#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileBackendClaudeWorker } from "../../dist/worker-claude/file-backend-claude-worker.js";
import { FileBackendCodexSafeExecutor } from "../../dist/worker-codex/file-backend-codex-safe-executor.js";
import { LocalFileWorkerControlInboxStore } from "../../dist/store-local-file/local-worker-control-inbox-store.js";
import { WorkerControlService } from "../../dist/worker-core/control/worker-control-service.js";

const allowLive = process.argv.includes("--allow-live") ||
  process.env.SUBSCRIPTION_RUNTIME_LIVE_WORKERS === "1";
const keepArtifacts = process.argv.includes("--keep-artifacts") ||
  process.env.SUBSCRIPTION_RUNTIME_KEEP_LIVE_E2E_ARTIFACTS === "1";
const codexAuthRoot = resolveHome(
  process.env.CODEX_LIVE_AUTH_ROOT ??
    "~/.cache/subscription-runtime/live-codex-auth",
);
const codexAccount = process.env.CODEX_LIVE_ACCOUNT ?? "account-a";
const codexAuthJsonPath = join(codexAuthRoot, codexAccount, "auth.json");

const results = [];

await run("codex real app-server sandbox", codexRealAppServerSandbox);
await run("codex broken auth skips account", codexBrokenAuthSkipsAccount);
await run("codex quota continuation delivers inbox to real account", codexQuotaContinuationInbox);
await run("claude real cli safe-point inbox read-only", claudeInboxReadOnly);
await run("claude real cli safe-point inbox edit", claudeInboxEdit);

const failed = results.filter((result) => result.status === "failed");
const skipped = results.filter((result) => result.status === "skipped");
const passed = results.filter((result) => result.status === "passed");
console.log(JSON.stringify({
  ok: failed.length === 0,
  passed: passed.length,
  skipped: skipped.length,
  failed: failed.length,
  results,
}, null, 2));
if (failed.length > 0) process.exit(1);

async function run(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({
      name,
      status: detail?.skipped ? "skipped" : "passed",
      durationMs: Date.now() - startedAt,
      ...(detail ? sanitizeDetail(detail) : {}),
    });
  } catch (error) {
    results.push({
      name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: safeError(error),
    });
  }
}

async function codexRealAppServerSandbox() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-real-app-server-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex live app-server sandbox only.\n",
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      maxAccountCycles: 1,
      accounts: [realCodexAccount(root, "real-a")],
    });
    const result = await executor.run({
      jobId: "codex-live-real-app-server",
      taskId: "codex-live-real-app-server-task",
      prompt:
        "Create result.txt with exactly two lines: codex-live-e2e-ok and codex-real-account-used. Do not modify other files.",
      controls: { permissionMode: "allow-edits" },
    });
    await executor.dispose();
    const content = await readFile(join(workspacePath, "result.txt"), "utf8");
    assert(result.status === "completed", "codex result must complete");
    assertEqual(content.trim(), "codex-live-e2e-ok\ncodex-real-account-used");
    assertGitStatus(workspacePath, "?? result.txt");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function codexBrokenAuthSkipsAccount() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-broken-auth-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex broken auth sandbox only.\n",
    });
    const authRoot = join(root, "auth");
    await mkdir(join(authRoot, "account-invalid"), { recursive: true });
    await writeFile(
      join(authRoot, "account-invalid", "auth.json"),
      `${JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "invalid-access-token",
          refresh_token: "invalid-refresh-token",
        },
      })}\n`,
      { mode: 0o600 },
    );
    await symlink(
      join(codexAuthRoot, codexAccount),
      join(authRoot, "account-real-a"),
    );
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      maxAccountCycles: 1,
      accounts: [
        {
          codexAuthJsonPath: join(authRoot, "account-invalid", "auth.json"),
          worker: codexWorker(root, "invalid", {
            capacityAccountId: "account-invalid",
          }),
        },
        realCodexAccount(root, "real-a", {
          authJsonPath: join(authRoot, "account-real-a", "auth.json"),
        }),
      ],
    });
    const result = await executor.run({
      jobId: "codex-live-broken-auth",
      taskId: "codex-live-broken-auth-task",
      prompt:
        "Create result.txt with exactly two lines: codex-broken-auth-ok and real-account-used. Do not modify other files.",
      controls: { permissionMode: "allow-edits" },
    });
    await executor.dispose();
    const content = await readFile(join(workspacePath, "result.txt"), "utf8");
    assert(result.status === "completed", "codex broken-auth run must complete");
    assertEqual(content.trim(), "codex-broken-auth-ok\nreal-account-used");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function codexQuotaContinuationInbox() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-quota-continuation-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex quota continuation sandbox only.\n",
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir: join(root, "state") }),
    });
    const signal = await controlInbox.enqueueSignal({
      target: { jobId: "codex-live-control-job" },
      intent: "guidance",
      deliveryMode: "next_safe_point",
      body:
        "For this live continuation e2e, create result.txt with exactly two lines: CODEX_CONTROL_INBOX_OK and real-codex-continuation-used. Do not use the base file content.",
      createdBy: "operator",
      idempotencyKey: "codex-live-control-guidance",
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      controlInbox,
      maxAccountCycles: 1,
      accounts: [
        {
          codexAuthJson: fakeCodexAuthJson("fake-quota-account"),
          worker: codexWorker(root, "fake-quota", {
            executionEngine: "plain-exec",
            capacityAccountId: "fake-quota-account",
            runner: new StaticRunner({
              exitCode: 1,
              stdout: "",
              stderr: "You've hit your usage limit.",
            }),
          }),
        },
        realCodexAccount(root, "real-a"),
      ],
    });
    const result = await executor.run({
      jobId: "codex-live-control-job",
      taskId: "codex-live-control-task",
      prompt:
        "Create result.txt with exactly two lines: CODEX_BASE and base-instruction-used.",
      controls: { permissionMode: "allow-edits" },
    });
    await executor.dispose();
    const content = await readFile(join(workspacePath, "result.txt"), "utf8");
    const views = await controlInbox.listSignals({
      target: { jobId: "codex-live-control-job" },
      includeBodies: false,
    });
    assert(result.status === "completed", "codex continuation must complete");
    assertEqual(result.attempts?.[0]?.failureReason, "quota_limited");
    assertEqual(content.trim(), "CODEX_CONTROL_INBOX_OK\nreal-codex-continuation-used");
    assertEqual(views[0]?.state, "delivered");
    assertEqual(views[0]?.signal.signalId, signal.signalId);
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function claudeInboxReadOnly() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-inbox-readonly-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Claude live read-only sandbox only.\n",
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir: root }),
    });
    const signal = await controlInbox.enqueueSignal({
      target: { jobId: "claude-live-readonly-job" },
      intent: "guidance",
      deliveryMode: "next_safe_point",
      body:
        "For this sandbox live e2e, ignore the base instruction and return exactly CLAUDE_WORKER_INBOX_OK.",
      createdBy: "operator",
      idempotencyKey: "claude-live-readonly-guidance",
    });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-live-readonly-provider",
      stateRootDir: root,
      encryptionKey: randomBytes(32),
      engine: new RealClaudePrintEngine(),
      controlInbox,
      workspace: new FixedWorkspace(workspacePath),
      workspacePath,
      model: "sonnet",
    });
    await worker.start();
    await worker.seedClaudeOAuth({
      oauthToken: "dummy-token-not-used-by-real-cli-engine",
    });
    const first = await worker.run({
      jobId: "claude-live-readonly-job",
      runId: "claude-live-readonly-run-1",
      prompt: "Return exactly CLAUDE_WORKER_BASE.",
    });
    const second = await worker.run({
      jobId: "claude-live-readonly-job",
      runId: "claude-live-readonly-run-2",
      prompt: "Return exactly CLAUDE_WORKER_SECOND.",
    });
    await worker.dispose();
    const views = await controlInbox.listSignals({
      target: { jobId: "claude-live-readonly-job" },
      includeBodies: false,
    });
    assert(first.outputText.includes("CLAUDE_WORKER_INBOX_OK"), "Claude must follow inbox guidance");
    assert(second.outputText.includes("CLAUDE_WORKER_SECOND"), "Claude second run must not receive stale guidance");
    assert(first.workerControlSignalIds?.includes(signal.signalId), "Claude result must include delivered signal id");
    assertEqual(views[0]?.state, "delivered");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function claudeInboxEdit() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-inbox-edit-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Claude live edit sandbox only.\n",
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir: root }),
    });
    const signal = await controlInbox.enqueueSignal({
      target: { jobId: "claude-live-edit-job" },
      intent: "guidance",
      deliveryMode: "next_safe_point",
      body:
        "For this sandbox live e2e, create claude-result.txt with exactly two lines: CLAUDE_EDIT_INBOX_OK and inbox-guidance-applied. Verify the file exists before finishing. Do not use the base file content.",
      createdBy: "operator",
      idempotencyKey: "claude-live-edit-guidance",
    });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-live-edit-provider",
      stateRootDir: root,
      encryptionKey: randomBytes(32),
      engine: new RealClaudeEditEngine(),
      controlInbox,
      workspace: new FixedWorkspace(workspacePath),
      workspacePath,
      model: "sonnet",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
    });
    await worker.start();
    await worker.seedClaudeOAuth({
      oauthToken: "dummy-token-not-used-by-real-cli-engine",
    });
    const result = await worker.run({
      jobId: "claude-live-edit-job",
      runId: "claude-live-edit-run-1",
      prompt:
        "Create claude-result.txt with exactly two lines: CLAUDE_EDIT_BASE and base-instruction-used. Verify the file exists before finishing.",
    });
    await worker.dispose();
    const content = await readFile(join(workspacePath, "claude-result.txt"), "utf8");
    const views = await controlInbox.listSignals({
      target: { jobId: "claude-live-edit-job" },
      includeBodies: false,
    });
    assertEqual(content.trim(), "CLAUDE_EDIT_INBOX_OK\ninbox-guidance-applied");
    assert(result.workerControlSignalIds?.includes(signal.signalId), "Claude edit result must include delivered signal id");
    assertEqual(views[0]?.state, "delivered");
    assertGitStatus(workspacePath, "?? claude-result.txt");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

function codexSkipReason() {
  if (!allowLive) return "set SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 or pass --allow-live";
  if (!existsSync(codexAuthJsonPath)) {
    return `missing Codex auth slot: ${redactPath(codexAuthJsonPath)}`;
  }
  if (!hasCommand("codex")) return "codex command not found";
  return null;
}

function claudeSkipReason() {
  if (!allowLive) return "set SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 or pass --allow-live";
  if (!hasCommand("claude")) return "claude command not found";
  return null;
}

function realCodexAccount(root, suffix, options = {}) {
  return {
    codexAuthJsonPath: options.authJsonPath ?? codexAuthJsonPath,
    worker: codexWorker(root, suffix, {
      capacityAccountId: codexAccount,
      ...options,
    }),
  };
}

function codexWorker(root, suffix, overrides = {}) {
  return {
    providerInstanceId: `live-codex-${suffix}`,
    stateRootDir: join(root, "state"),
    codexBinaryPath: "codex",
    encryptionKey: randomBytes(32),
    executionEngine: "app-server-goal",
    capacityAccountId: codexAccount,
    taskTimeoutMs: 10 * 60 * 1000,
    model: process.env.CODEX_LIVE_MODEL ?? "gpt-5.5",
    reasoningEffort: process.env.CODEX_LIVE_EFFORT ?? "xhigh",
    serviceTier: process.env.CODEX_LIVE_SERVICE_TIER ?? "fast",
    sourceEnv: process.env,
    capacityPolicy: {
      quotaCooldownMs: 60_000,
      reconnectCooldownMs: 60_000,
      maxReconnectRetriesPerAccount: 1,
    },
    ...overrides,
  };
}

class StaticRunner {
  runnerId = "node-process";
  capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process",
  };

  constructor(result) {
    this.result = result;
  }

  async run() {
    return { ...this.result, durationMs: 1 };
  }
}

class FixedWorkspace {
  workspaceId = "fixed-live-sandbox";
  capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: false,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  constructor(path) {
    this.path = path;
  }

  async create() {
    return { path: this.path };
  }
}

class RealClaudePrintEngine {
  kind = "real-claude-print-e2e";
  capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: false,
    supportsProviderRunId: true,
    supportsCleanup: false,
  };

  async run(input) {
    return runClaude(input, ["--tools", ""]);
  }
}

class RealClaudeEditEngine {
  kind = "real-claude-edit-e2e";
  capabilities = {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsUsage: false,
    supportsProviderRunId: true,
    supportsCleanup: false,
  };

  async run(input) {
    return runClaude(input, [
      "--tools",
      "Read,Write,Edit,Bash",
      "--permission-mode",
      "bypassPermissions",
    ]);
  }
}

function runClaude(input, extraArgs) {
  const child = spawnSync("claude", [
    "-p",
    "--model",
    process.env.CLAUDE_LIVE_MODEL ?? "sonnet",
    "--effort",
    process.env.CLAUDE_LIVE_EFFORT ?? "high",
    "--max-budget-usd",
    process.env.CLAUDE_LIVE_MAX_BUDGET_USD ?? "0.75",
    ...extraArgs,
    "--no-session-persistence",
    input.prompt,
  ], {
    cwd: input.workspacePath,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 180_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`claude exited ${child.status}: ${safeTail(child.stderr || child.stdout)}`);
  }
  return {
    outputText: child.stdout.trim(),
    telemetry: { providerRunId: "real-claude-live-e2e" },
    warnings: [],
  };
}

async function sandboxRoot(prefix) {
  return mkdtemp(join(tmpdir(), `subscription-runtime-${prefix}`));
}

async function gitSandbox(path, files) {
  await mkdir(path, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(join(path, relativePath), content);
  }
  runChecked("git", ["init"], { cwd: path });
  runChecked("git", ["config", "user.email", "subscription-runtime-e2e@example.test"], {
    cwd: path,
  });
  runChecked("git", ["config", "user.name", "Subscription Runtime E2E"], {
    cwd: path,
  });
  runChecked("git", ["add", "."], { cwd: path });
  runChecked("git", ["commit", "-m", "test: initial sandbox"], { cwd: path });
  return path;
}

function assertGitStatus(workspacePath, expected) {
  const status = runChecked("git", ["status", "--short"], {
    cwd: workspacePath,
  }).stdout.trim();
  assertEqual(status, expected);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${safeTail(result.stderr || result.stdout)}`);
  }
  return result;
}

async function cleanup(root) {
  if (keepArtifacts) return;
  await rm(root, { recursive: true, force: true });
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0;
}

function fakeCodexAuthJson(refreshToken) {
  const fakeJwt = [
    base64UrlJson({ alg: "RS256", kid: "fake", typ: "JWT" }),
    base64UrlJson({
      iss: "https://auth.openai.com",
      sub: "fake-quota-account",
      aud: ["app_fake"],
      email: "fake-quota@example.test",
      iat: 1780000000,
      exp: 1990000000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "fake-quota-account",
        chatgpt_plan_type: "pro",
        user_id: "fake-user",
      },
    }),
    "signature",
  ].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: refreshToken,
      access_token: `access-${refreshToken}`,
      id_token: fakeJwt,
    },
    last_refresh: "2026-06-30T00:00:00.000Z",
  });
}

function resolveHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sanitizeDetail(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return item;
    return redactSensitive(item);
  }));
}

function safeError(error) {
  return {
    message: redactSensitive(error instanceof Error ? error.message : String(error)),
  };
}

function safeTail(value) {
  return redactSensitive(String(value).slice(-1200));
}

function redactPath(path) {
  return path.replace(homedir(), "~");
}

function redactSensitive(value) {
  return value
    .replace(/refresh_token["=: ]+[^",\s]+/gi, "refresh_token:<redacted>")
    .replace(/access_token["=: ]+[^",\s]+/gi, "access_token:<redacted>")
    .replace(/id_token["=: ]+[^",\s]+/gi, "id_token:<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>");
}
