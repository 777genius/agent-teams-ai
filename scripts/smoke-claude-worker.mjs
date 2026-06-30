#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const rootDir = new URL("..", import.meta.url).pathname;
const claudePath = process.env.CLAUDE_PATH ?? findOnPath("claude");
const primaryToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const secondaryToken = process.env.CLAUDE_CODE_OAUTH_TOKEN_2;

if (!primaryToken) {
  fail("CLAUDE_CODE_OAUTH_TOKEN is required.");
}
if (!claudePath) {
  fail("Claude executable was not found. Set CLAUDE_PATH or add claude to PATH.");
}
if (!existsSync(join(rootDir, "dist/worker-claude/index.js"))) {
  fail("dist output is missing. Run npm run build before this smoke.");
}

const [
  { ClaudeRunObservationAdapter, FileBackendClaudeWorker },
  { BoundedSubscriptionWorkerPool, RunObservationService },
  provider,
] = await Promise.all([
  import(pathToFileURL(join(rootDir, "dist/worker-claude/index.js")).href),
  import(pathToFileURL(join(rootDir, "dist/worker-core/index.js")).href),
  import(pathToFileURL(join(rootDir, "dist/provider-claude/index.js")).href),
]);

const rootStateDir = await mkdtemp(
  join(tmpdir(), "subscription-runtime-claude-smoke-"),
);
const smokeMode = process.env.CLAUDE_WORKER_SMOKE_MODE ?? "all";
const keepTemp = process.env.CLAUDE_WORKER_SMOKE_KEEP_TMP === "1";

try {
  const report = {};
  if (smokeMode === "all" || smokeMode === "single") {
    report.single = await runSingleWorkerSmoke({
      ClaudeRunObservationAdapter,
      FileBackendClaudeWorker,
      RunObservationService,
      provider,
      rootStateDir,
      claudePath,
      token: primaryToken,
    });
  }
  if (smokeMode === "all" || smokeMode === "thread") {
    report.threadHandoff = await runThreadHandoffSmoke({
      FileBackendClaudeWorker,
      BoundedSubscriptionWorkerPool,
      provider,
      rootStateDir,
      claudePath,
      tokens: [
        primaryToken,
        secondaryToken && secondaryToken !== primaryToken
          ? secondaryToken
          : primaryToken,
      ],
    });
  }
  if (smokeMode === "all" || smokeMode === "multi") {
    report.multiWorker =
      secondaryToken && secondaryToken !== primaryToken
        ? await runMultiWorkerSmoke({
            FileBackendClaudeWorker,
            BoundedSubscriptionWorkerPool,
            provider,
            rootStateDir,
            claudePath,
            tokens: [primaryToken, secondaryToken],
          })
        : {
            skipped: true,
            reason: secondaryToken
              ? "secondary_token_matches_primary"
              : "CLAUDE_CODE_OAUTH_TOKEN_2 not provided",
          };
  }

  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!keepTemp) {
    await rm(rootStateDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function runSingleWorkerSmoke(input) {
  const worker = new input.FileBackendClaudeWorker({
    providerInstanceId: "live-smoke-claude-worker-1",
    stateRootDir: join(input.rootStateDir, "single"),
    encryptionKey: randomBytes(32),
    engine: createEngine(input.provider, {
      claudePath: input.claudePath,
      stateFilePath: join(input.rootStateDir, "single-runtime-state.json"),
    }),
    model: process.env.CLAUDE_MODEL ?? "sonnet",
    capacityPolicy: { softMaxRunsPerWindow: 3, windowMs: 60_000 },
  });
  const startedAt = Date.now();
  try {
    await worker.start();
    await worker.seedClaudeOAuth({ oauthToken: input.token });
    const prewarm = await worker.prewarm();
    const runId = "live-smoke-claude-worker-single";
    const result = await worker.run({
      runId,
      prompt: "Return exactly OK and nothing else.",
      controls: { maxTurns: 1, permissionMode: "read-only" },
    });
    const outputText = result.outputText.trim();
    if (outputText !== "OK") {
      fail(`Single Claude worker smoke expected OK, got ${outputText}`);
    }
    const watchSnapshot = await new input.RunObservationService(
      new input.ClaudeRunObservationAdapter({
        stateRootDir: join(input.rootStateDir, "single"),
      }),
    ).observeRun({
      runId,
      includeLogTail: true,
    });
    if (
      watchSnapshot.status !== "completed" ||
      watchSnapshot.result?.status !== "completed" ||
      watchSnapshot.progress?.status !== "completed"
    ) {
      fail(
        `Single Claude watch smoke expected completed artifacts, got ${JSON.stringify({
          status: watchSnapshot.status,
          result: watchSnapshot.result?.status,
          progress: watchSnapshot.progress?.status,
        })}`,
      );
    }
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      prewarm: { status: prewarm.status, mode: prewarm.details?.mode },
      outputText,
      watch: {
        status: watchSnapshot.status,
        liveness: watchSnapshot.liveness,
        decision: watchSnapshot.readOnlyDecision.kind,
        result: watchSnapshot.result?.status,
        progress: watchSnapshot.progress?.status,
        logTailHasCompletion:
          watchSnapshot.logs?.tail?.includes("run.completed") === true,
      },
      warnings: result.warnings.map((warning) => warning.code),
      capacity: worker.capacity(),
    };
  } finally {
    await worker.dispose().catch(() => undefined);
  }
}

async function runThreadHandoffSmoke(input) {
  const workers = [];
  const sharedWorkspacePath = join(input.rootStateDir, "thread-workspace");
  const phrase = `QTHANDOFF-${randomBytes(4).toString("hex").toUpperCase()}`;
  const pool = new input.BoundedSubscriptionWorkerPool({
    poolId: "live-smoke-claude-thread-pool",
    slots: 2,
    retryPolicy: {
      maxAttempts: 2,
      retryOnSlotCapacityUnavailable: true,
    },
    workerFactory: ({ slotIndex, workerId }) => {
      const worker = new input.FileBackendClaudeWorker({
        workerId,
        providerInstanceId: `live-smoke-claude-thread-${slotIndex + 1}`,
        stateRootDir: join(input.rootStateDir, "thread"),
        encryptionKey: randomBytes(32),
        engine: createEngine(input.provider, {
          claudePath: input.claudePath,
          stateFilePath: join(
            input.rootStateDir,
            `thread-runtime-state-${slotIndex + 1}.json`,
          ),
        }),
        model: process.env.CLAUDE_MODEL ?? "sonnet",
        workspace: fixedWorkspace(sharedWorkspacePath),
        workspacePath: sharedWorkspacePath,
        capacityPolicy: { softMaxRunsPerWindow: 1, windowMs: 60_000 },
      });
      workers.push(worker);
      return worker;
    },
  });

  const startedAt = Date.now();
  try {
    await pool.start();
    await Promise.all(
      workers.map((worker, index) =>
        worker.seedClaudeOAuth({ oauthToken: input.tokens[index] }),
      ),
    );
    const first = await pool.run({
      threadId: "live-smoke-logical-thread",
      prompt:
        `Remember this exact phrase: ${phrase}. ` +
        "Reply exactly FIRST_READY and nothing else.",
      controls: { maxTurns: 1, permissionMode: "read-only" },
    });
    const second = await pool.run({
      threadId: "live-smoke-logical-thread",
      prompt:
        "What exact phrase were you asked to remember? " +
        "Reply with only that phrase and nothing else.",
      controls: { maxTurns: 1, permissionMode: "read-only" },
    });
    const secondOutput = second.outputText.trim();
    if (!secondOutput.includes(phrase)) {
      fail(
        `Thread handoff resume failed. Expected ${phrase}, got ${secondOutput}`,
      );
    }

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      phrase,
      outputs: [first.outputText.trim(), secondOutput],
      firstThread: threadSummary(first.thread),
      secondThread: threadSummary(second.thread),
      capacities: workers.map((worker) => ({
        workerId: worker.workerId,
        capacity: worker.capacity(),
      })),
      configDirs: workers.map((worker) => worker.configDir),
      sharedWorkspacePath,
    };
  } finally {
    await pool.dispose().catch(() => undefined);
  }
}

async function runMultiWorkerSmoke(input) {
  const workers = [];
  const pool = new input.BoundedSubscriptionWorkerPool({
    poolId: "live-smoke-claude-pool",
    slots: input.tokens.length,
    retryPolicy: {
      maxAttempts: input.tokens.length,
      retryOnSlotCapacityUnavailable: true,
    },
    workerFactory: ({ slotIndex, workerId }) => {
      const worker = new input.FileBackendClaudeWorker({
        workerId,
        providerInstanceId: `live-smoke-claude-worker-${slotIndex + 1}`,
        stateRootDir: join(input.rootStateDir, "pool"),
        encryptionKey: randomBytes(32),
        engine: createEngine(input.provider, {
          claudePath: input.claudePath,
          stateFilePath: join(
            input.rootStateDir,
            `pool-runtime-state-${slotIndex + 1}.json`,
          ),
        }),
        model: process.env.CLAUDE_MODEL ?? "sonnet",
        capacityPolicy: { softMaxRunsPerWindow: 1, windowMs: 60_000 },
      });
      workers.push(worker);
      return worker;
    },
  });

  const startedAt = Date.now();
  try {
    await pool.start();
    await Promise.all(
      workers.map((worker, index) =>
        worker.seedClaudeOAuth({ oauthToken: input.tokens[index] }),
      ),
    );
    const first = await pool.run({
      prompt: "Return exactly FIRST and nothing else.",
      controls: { maxTurns: 1, permissionMode: "read-only" },
    });
    const second = await pool.run({
      prompt: "Return exactly SECOND and nothing else.",
      controls: { maxTurns: 1, permissionMode: "read-only" },
    });

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      outputs: [first.outputText.trim(), second.outputText.trim()],
      capacities: workers.map((worker) => ({
        workerId: worker.workerId,
        capacity: worker.capacity(),
      })),
    };
  } finally {
    await pool.dispose().catch(() => undefined);
  }
}

function fixedWorkspace(path) {
  return {
    workspaceId: "smoke-fixed-workspace",
    capabilities: {
      workspaceId: "smoke-fixed-workspace",
      supportsTempDir: false,
      supportsExistingCheckout: true,
      supportsContainer: false,
    },
    async create() {
      await mkdir(path, { recursive: true, mode: 0o700 });
      return { path };
    },
  };
}

function createEngine(provider, input) {
  const runtimeModules = localRuntimeModules();
  return new provider.ClaudeRuntimeTaskExecutionEngine({
    claudePath: input.claudePath,
    baseEnv: {
      CI: "1",
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
    commandTimeoutMs: Number(process.env.CLAUDE_COMMAND_TIMEOUT_MS ?? 180_000),
    pollIntervalMs: Number(process.env.CLAUDE_POLL_INTERVAL_MS ?? 250),
    stateFilePath: input.stateFilePath,
    ...(runtimeModules
      ? {
          runtimeModuleLoader: async () => import(runtimeModules.runtime),
          providerModuleLoader: async () => import(runtimeModules.provider),
        }
      : {}),
  });
}

function threadSummary(thread) {
  return {
    generation: thread?.generation,
    latestSessionId: thread?.latestSessionId,
    latestProviderInstanceId: thread?.latestProviderInstanceId,
    latestWorkerId: thread?.latestWorkerId,
  };
}

function localRuntimeModules() {
  const explicit = process.env.CLAUDE_RUNTIME_DIST_DIR;
  const candidates = [
    explicit ? resolve(explicit) : null,
    resolve(rootDir, "../claude-runtime/dist"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const runtime = join(candidate, "index.js");
    const provider = join(candidate, "infrastructure/claude-bg/provider/index.js");
    if (existsSync(runtime) && existsSync(provider)) {
      return {
        runtime: pathToFileURL(runtime).href,
        provider: pathToFileURL(provider).href,
      };
    }
  }
  return null;
}

function findOnPath(binary) {
  const result = spawnSync("which", [binary], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
