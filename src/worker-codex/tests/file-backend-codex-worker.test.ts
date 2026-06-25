import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type {
  RunnerPort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  BoundedSubscriptionWorkerPool,
  InMemoryWorkerAccountCapacityStore,
  accountCapacityAwareWorkerFactory,
} from "@vioxen/subscription-runtime/worker-core";
import { describe, expect, it } from "vitest";
import { FileBackendCodexWorker } from "../index";
import { NodeProcessRunner } from "../node-process-runner";

const validAuthJson = codexAuthJson("refresh-token");

describe("FileBackendCodexWorker", () => {
  it("exposes lifecycle, seed, prewarm, health, and dispose", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(7),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await expect(worker.health()).resolves.toMatchObject({
        status: "unhealthy",
      });
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.health()).resolves.toMatchObject({
        status: "healthy",
      });
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
        details: {
          engine: "app-server-pool",
          engineReusable: "true",
        },
      });
      expect(appServer.spawnCount).toBe(1);
      expect(appServer.envs[0]).toMatchObject({ PATH: process.env.PATH });
      expect(appServer.prompts).toEqual(["Return exactly OK."]);
      await worker.dispose();
      await expect(access(join(rootDir, "codex-cache"))).rejects.toThrow();
      await expect(worker.run({ prompt: "hello" })).rejects.toThrow(
        "Codex worker has been disposed.",
      );
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires explicit start before running work", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(8),
    });

    try {
      await expect(worker.run({ prompt: "hello" })).rejects.toThrow(
        "Codex worker has not been started.",
      );
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates direct job system prompts before runtime dispatch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(6),
    });

    try {
      await worker.start();
      await expect(
        worker.run({ prompt: "hello", systemPrompt: " " }),
      ).rejects.toThrow("job.systemPrompt must not be empty");
      await expect(
        worker.run({
          prompt: "hello",
          systemPrompt: "x".repeat(256 * 1024 + 1),
        }),
      ).rejects.toThrow("job.systemPrompt exceeds 262144 bytes");
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous custom workspace options", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const customWorkspace: WorkspacePort = {
      workspaceId: "custom-test-workspace",
      capabilities: {
        workspaceId: "custom-test-workspace",
        supportsContainer: false,
        supportsExistingCheckout: true,
        supportsTempDir: false,
      },
      async create() {
        return { path: rootDir };
      },
    };

    try {
      expect(() => new FileBackendCodexWorker({
        providerInstanceId: "codex:test",
        stateRootDir: rootDir,
        workspace: customWorkspace,
        workspacePath: join(rootDir, "borrowed"),
        codexBinaryPath: "codex",
        encryptionKey: new Uint8Array(32).fill(3),
      })).toThrow("file_backend_codex_workspace_conflict");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("runs tasks in a borrowed caller workspace without deleting it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-caller-workspace-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(5),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });
    const canaryPath = join(callerWorkspace, "canary.txt");
    await writeFile(canaryPath, "safe", "utf8");

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.run({ prompt: "hello" })).resolves.toEqual({
        outputText: "OK",
        warnings: [],
      });
      expect(appServer.threadCwds).toContain(callerWorkspace);
      await worker.dispose();
      await expect(access(canaryPath)).resolves.toBeUndefined();
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("keeps prewarm work out of the borrowed caller workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const callerWorkspace = await mkdtemp(join(tmpdir(), "codex-caller-workspace-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      workspacePath: callerWorkspace,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(4),
      appServerProcessFactory: appServer.create,
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await expect(worker.prewarm()).resolves.toMatchObject({
        status: "ready",
      });
      expect(appServer.threadCwds.length).toBeGreaterThan(0);
      expect(appServer.threadCwds).not.toContain(callerWorkspace);
    } finally {
      await worker.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(callerWorkspace, { recursive: true, force: true });
    }
  });

  it("waits and retries when another slot is refreshing the same provider session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const runner = new RefreshingFakeRunner();
    const appServer = new FakeAppServerFactory();
    const key = new Uint8Array(32).fill(9);
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const first = new FileBackendCodexWorker({
      workerId: "slot-1",
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: key,
      appServerProcessFactory: appServer.create,
      runner,
      clock,
      refreshConflictRetryMaxMs: 2_000,
    });
    const second = new FileBackendCodexWorker({
      workerId: "slot-2",
      providerInstanceId: "codex:test",
      stateRootDir: rootDir,
      codexBinaryPath: "codex",
      encryptionKey: key,
      appServerProcessFactory: appServer.create,
      runner,
      clock,
      refreshConflictRetryMaxMs: 2_000,
    });

    try {
      await first.start();
      await second.start();
      await first.seedCodexAuthJson(
        JSON.stringify({
          ...JSON.parse(validAuthJson),
          tokens: {
            refresh_token: "refresh-token",
            access_token: "access-token",
            expiry: "2026-05-31T00:06:00.000Z",
          },
          last_refresh: "2026-05-30T23:00:00.000Z",
        }),
      );

      await expect(
        Promise.all([
          first.run({ prompt: "first" }),
          second.run({ prompt: "second" }),
        ]),
      ).resolves.toEqual([
        { outputText: "OK", warnings: [] },
        { outputText: "OK", warnings: [] },
      ]);
      expect(runner.runCount).toBe(1);
      expect([...appServer.prompts].sort()).toEqual(["first", "second"]);
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries quota-limited Codex work on a different account", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-worker-"));
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const accountCapacityStore = new InMemoryWorkerAccountCapacityStore();
    const appServers = [
      new FakeAppServerFactory({
        emitTopLevelErrorOnTurn: "You've hit your usage limit.",
      }),
      new FakeAppServerFactory(),
      new FakeAppServerFactory(),
    ];
    const workers: FileBackendCodexWorker[] = [];
    const pool = new BoundedSubscriptionWorkerPool<
      Parameters<FileBackendCodexWorker["run"]>[0],
      Awaited<ReturnType<FileBackendCodexWorker["run"]>>
    >({
      poolId: "codex-quota-account-aware-pool",
      slots: 3,
      clock,
      retryPolicy: {
        maxAttempts: 3,
        retryOnSlotCapacityUnavailable: true,
      },
      workerFactory: accountCapacityAwareWorkerFactory({
        accountCapacityStore,
        clock,
        workerFactory: ({ slotIndex, workerId }) => {
          const worker = new FileBackendCodexWorker({
            workerId,
            providerInstanceId: `codex-quota-account-${slotIndex + 1}`,
            stateRootDir: rootDir,
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(slotIndex + 10),
            appServerProcessFactory: appServers[slotIndex]!.create,
            runner: new StaticRunner({
              exitCode: slotIndex === 0 ? 1 : 0,
              stdout: slotIndex === 0 ? "" : "OK",
              stderr:
                slotIndex === 0 ? "You've hit your usage limit." : "",
            }),
            capacityPolicy: {
              quotaCooldownMs: 60_000,
            },
            clock,
          });
          workers.push(worker);
          return worker;
        },
      }),
    });

    try {
      await pool.start();
      await workers[0]!.seedCodexAuthJson(codexAuthJson("account-a-token"));
      await workers[1]!.seedCodexAuthJson(codexAuthJson("account-a-token"));
      await workers[2]!.seedCodexAuthJson(codexAuthJson("account-b-token"));

      await expect(pool.run({ prompt: "review" })).resolves.toEqual({
        outputText: "OK",
        warnings: [],
      });

      const accountId = workers[0]!.capacity().details?.quotaGroup;
      expect(accountId).toBeTruthy();
      expect(
        accountCapacityStore.read({ accountId: accountId!, now: clock.now() }),
      ).toMatchObject({
        availability: "cooldown",
        reason: "quota_limited",
      });
      expect(appServers[0]!.prompts).toEqual(["review"]);
      expect(appServers[1]!.prompts).toEqual([]);
      expect(appServers[2]!.prompts).toEqual(["review"]);
    } finally {
      await pool.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

type FakeAppServerFactoryOptions = {
  readonly emitTopLevelErrorOnTurn?: string;
};

class FakeAppServerFactory {
  spawnCount = 0;
  readonly prompts: string[] = [];
  readonly threadCwds: string[] = [];
  readonly envs: Readonly<Record<string, string>>[] = [];

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }) => {
    this.spawnCount += 1;
    this.envs.push(input.env);
    return new FakeAppServerProcess(
      (prompt) => this.prompts.push(prompt),
      (cwd) => this.threadCwds.push(cwd),
      this.options,
    );
  };
}

class FakeAppServerProcess extends EventEmitter {
  readonly pid = undefined;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.handleRequest(String(chunk));
      return true;
    },
    end: () => undefined,
  };
  private nextThreadId = 1;
  private nextTurnId = 1;

  constructor(
    private readonly onPrompt: (prompt: string) => void,
    private readonly onThreadCwd: (cwd: string) => void,
    private readonly options: FakeAppServerFactoryOptions,
  ) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  private handleRequest(chunk: string): void {
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "initialize") {
        this.respond(request.id, { userAgent: "fake-codex" });
        continue;
      }
      if (request.method === "thread/start") {
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        const cwd = request.params?.cwd;
        if (typeof cwd === "string") {
          this.onThreadCwd(cwd);
        }
        this.respond(request.id, { thread: { id: threadId } });
        continue;
      }
      if (request.method === "turn/start") {
        const turnId = `turn-${this.nextTurnId}`;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.onPrompt(prompt);
        this.respond(request.id, { turn: { id: turnId } });
        setTimeout(() => {
          if (this.options.emitTopLevelErrorOnTurn) {
            this.stdout.emit(
              "data",
              `${JSON.stringify({
                method: "error",
                message: this.options.emitTopLevelErrorOnTurn,
              })}\n`,
            );
            return;
          }
          this.notify("item/agentMessage/delta", {
            turnId,
            delta: "OK",
          });
          this.notify("turn/completed", {
            turn: { id: turnId, status: { type: "completed" } },
          });
        }, 1);
        continue;
      }
      this.respond(request.id, {});
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class StaticRunner implements RunnerPort {
  readonly runnerId = "node-process";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {}

  async run() {
    return {
      ...this.result,
      durationMs: 1,
    };
  }
}

class RefreshingFakeRunner implements RunnerPort {
  readonly runnerId = "node-process";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };
  runCount = 0;

  async run(input: Parameters<RunnerPort["run"]>[0]) {
    this.runCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const authPath = input.env.REVIEWROUTER_CODEX_AUTH_PATH;
    if (!authPath) {
      throw new Error("missing_auth_path");
    }
    const { readFile, writeFile } = await import("node:fs/promises");
    const auth = JSON.parse(await readFile(authPath, "utf8")) as {
      tokens: { access_token?: string; expiry?: string };
      last_refresh?: string;
    };
    auth.tokens.access_token = `access-token-refreshed-${this.runCount}`;
    auth.tokens.expiry = "2026-05-31T23:00:00.000Z";
    auth.last_refresh = "2026-05-31T00:05:00.000Z";
    await writeFile(authPath, JSON.stringify(auth), "utf8");
    return { exitCode: 0, stdout: "OK", stderr: "", durationMs: 50 };
  }
}

function codexAuthJson(refreshToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: refreshToken,
      access_token: "access-token",
      expiry: "2026-05-31T23:00:00.000Z",
    },
    last_refresh: "2026-05-31T00:00:00.000Z",
  });
}

function extractFakePrompt(
  params: Record<string, unknown> | undefined,
): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

describe("NodeProcessRunner", () => {
  it("rejects non-zero process exits with a safe error", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.stderr.write('bad exit'); process.exit(7)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_failed:7:bad exit");
  });

  it("rejects timed-out work even when the process exits zero after SIGTERM", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 500 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 20));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 50,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_timeout:50");
  });

  it("does not spawn work for an already-aborted signal", async () => {
    const runner = new NodeProcessRunner();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run({
        command: "/path/that/must/not/spawn",
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("node_process_runner_aborted");
  });
});
