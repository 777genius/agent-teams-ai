import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";
import type {
  CodexReasoningEffort,
  CodexServiceTier,
} from "@vioxen/subscription-runtime/provider-codex";
import type {
  SafeExecutionPolicy,
  SafeExecutionRunResult,
  TaskEffectMode,
} from "@vioxen/subscription-runtime/worker-core";
import {
  FileBackendCodexSafeExecutor,
  type FileBackendCodexSafeExecutorOptions,
} from "./file-backend-codex-safe-executor";
import type {
  CodexWorkerExecutionEngine,
  FileBackendCodexWorkerResult,
} from "./file-backend-codex-worker";

export type CodexGoalAccountSlot = {
  readonly name: string;
  readonly authJsonPath?: string;
};

export type CodexGoalRunConfig = {
  readonly jobRootDir: string;
  readonly stateRootDir?: string;
  readonly encryptionKeyPath?: string;
  readonly authRootDir: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly taskId: string;
  readonly accounts: readonly CodexGoalAccountSlot[];
  readonly outputPath?: string;
  readonly progressPath?: string;
  readonly progressHeartbeatMs?: number;
  readonly executorId?: string;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly executionEngine?: CodexWorkerExecutionEngine;
  readonly taskTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly quotaCooldownMs?: number;
  readonly reconnectCooldownMs?: number;
  readonly maxReconnectRetriesPerAccount?: number;
  readonly permissionMode?: ProviderTaskControls["permissionMode"];
  readonly goalSummary?: string;
  readonly codexGoalObjective?: string;
  readonly effectMode?: TaskEffectMode;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly requireGitWorkspace?: boolean;
  readonly prewarmOnStart?: boolean;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export type CodexGoalProgressStatus =
  | "starting"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "aborted";

export type CodexGoalProgressSnapshot = {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly status: CodexGoalProgressStatus;
  readonly updatedAt: string;
  readonly pid: number;
  readonly reason?: string;
  readonly resultStatus?: string;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
};

export type CodexGoalRunDeps = {
  readonly createExecutor?: (
    options: FileBackendCodexSafeExecutorOptions,
  ) => CodexGoalExecutor;
};

export type CodexGoalExecutor = {
  run(
    input: Parameters<FileBackendCodexSafeExecutor["run"]>[0],
  ): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>>;
  dispose(): Promise<void>;
};

export async function runCodexGoal(
  config: CodexGoalRunConfig,
  deps: CodexGoalRunDeps = {},
): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
  assertCodexGoalRunConfig(config);
  const prompt = await readFile(config.promptPath, "utf8");
  const progressPath = codexGoalProgressPath(config);
  const progressHeartbeat = createCodexGoalProgressHeartbeat({
    progressPath,
    taskId: config.taskId,
    intervalMs: config.progressHeartbeatMs ?? 60_000,
  });
  await progressHeartbeat.write({ status: "starting" });
  const encryptionKey = await readOrCreateCodexGoalEncryptionKey(
    config.encryptionKeyPath ?? join(config.jobRootDir, "encryption-key.hex"),
  );
  const stateRootDir = config.stateRootDir ?? join(config.jobRootDir, "state");
  await mkdir(stateRootDir, { recursive: true, mode: 0o700 });

  const executor = (
    deps.createExecutor ??
    ((options) => new FileBackendCodexSafeExecutor(options))
  )(buildCodexGoalExecutorOptions({
    config,
    stateRootDir,
    encryptionKey,
  }));

  try {
    progressHeartbeat.start();
    const result = await executor.run({
      taskId: config.taskId,
      prompt,
      originalPrompt: prompt,
      ...(config.staleLockMs === undefined
        ? {}
        : { staleLockMs: config.staleLockMs }),
      ...(config.maxAccountCycles === undefined
        ? {}
        : { maxAccountCycles: config.maxAccountCycles }),
      ...(config.effectMode === undefined ? {} : { effectMode: config.effectMode }),
      ...(config.safeExecutionPolicy === undefined
        ? {}
        : { safeExecutionPolicy: config.safeExecutionPolicy }),
      controls: {
        permissionMode: config.permissionMode ?? "allow-edits",
      },
      metadata: {
        goal: config.goalSummary ?? config.taskId,
        codexGoalObjective: config.codexGoalObjective ?? prompt,
      },
    });
    if (config.outputPath) {
      await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    await progressHeartbeat.write(progressFromResult(result));
    return result;
  } catch (error) {
    await progressHeartbeat.write({
      status: "failed",
      reason: "runner_exception",
    });
    throw error;
  } finally {
    await progressHeartbeat.stop();
    await executor.dispose();
  }
}

export function buildCodexGoalExecutorOptions(input: {
  readonly config: CodexGoalRunConfig;
  readonly stateRootDir: string;
  readonly encryptionKey: Uint8Array;
}): FileBackendCodexSafeExecutorOptions {
  const { config } = input;
  return {
    ...(config.executorId ? { executorId: config.executorId } : {}),
    stateRootDir: input.stateRootDir,
    workspacePath: config.workspacePath,
    maxAccountCycles: config.maxAccountCycles ?? 5,
    allowDuplicateAccountIdentities:
      config.allowDuplicateAccountIdentities ?? false,
    requireGitWorkspace: config.requireGitWorkspace ?? true,
    prewarmOnStart: config.prewarmOnStart ?? false,
    ...(config.effectMode === undefined ? {} : { effectMode: config.effectMode }),
    ...(config.safeExecutionPolicy === undefined
      ? {}
      : { safeExecutionPolicy: config.safeExecutionPolicy }),
    accounts: config.accounts.map((account, index) => ({
      codexAuthJsonPath:
        account.authJsonPath ?? join(config.authRootDir, account.name, "auth.json"),
      worker: {
        providerInstanceId: `${config.taskId}-${account.name}`,
        stateRootDir: input.stateRootDir,
        codexBinaryPath: config.codexBinaryPath ?? "codex",
        encryptionKey: input.encryptionKey,
        executionEngine: config.executionEngine ?? "app-server-goal",
        capacityAccountId: account.name,
        taskTimeoutMs: config.taskTimeoutMs ?? 72 * 60 * 60 * 1000,
        sourceEnv: config.sourceEnv ?? process.env,
        ...(config.model ? { model: config.model } : {}),
        ...(config.reasoningEffort
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
        ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
        capacityPolicy: {
          quotaCooldownMs: config.quotaCooldownMs ?? 15 * 60 * 1000,
          reconnectCooldownMs: config.reconnectCooldownMs ?? 15 * 60 * 1000,
          maxReconnectRetriesPerAccount:
            config.maxReconnectRetriesPerAccount ?? 4,
        },
      },
    })),
    safeExecutionPolicy: {
      retryOnCapacity: true,
      retryOnAccountUnavailable: true,
      retryOnReconnectRequired: true,
      retryUnknownCleanWorkspace: false,
      retryUnknownChangedWorkspace: false,
      continuationMode: "packet_first",
      ...(config.safeExecutionPolicy ?? {}),
    },
  };
}

export async function readOrCreateCodexGoalEncryptionKey(
  keyPath: string,
): Promise<Uint8Array> {
  if (existsSync(keyPath)) {
    const value = (await readFile(keyPath, "utf8")).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error("codex_goal_encryption_key_invalid");
    }
    return Buffer.from(value, "hex");
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("hex")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return key;
}

export function codexGoalProgressPath(config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "progressPath">): string {
  return config.progressPath ?? join(config.jobRootDir, `${config.taskId}.progress.json`);
}

export function codexGoalAccountSlots(
  accounts: readonly string[],
): readonly CodexGoalAccountSlot[] {
  return accounts
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function assertCodexGoalRunConfig(config: CodexGoalRunConfig): void {
  if (!config.jobRootDir.trim()) throw new Error("codex_goal_job_root_required");
  if (!config.authRootDir.trim()) throw new Error("codex_goal_auth_root_required");
  if (!config.workspacePath.trim()) throw new Error("codex_goal_workspace_required");
  if (!config.promptPath.trim()) throw new Error("codex_goal_prompt_required");
  if (!config.taskId.trim()) throw new Error("codex_goal_task_id_required");
  if (config.accounts.length === 0) throw new Error("codex_goal_accounts_required");
  assertPositiveInteger(config.taskTimeoutMs, "codex_goal_task_timeout_invalid");
  assertPositiveInteger(config.staleLockMs, "codex_goal_stale_lock_invalid");
  assertPositiveInteger(config.maxAccountCycles, "codex_goal_account_cycles_invalid");
  assertPositiveInteger(config.quotaCooldownMs, "codex_goal_quota_cooldown_invalid");
  assertPositiveInteger(
    config.reconnectCooldownMs,
    "codex_goal_reconnect_cooldown_invalid",
  );
  assertPositiveInteger(
    config.maxReconnectRetriesPerAccount,
    "codex_goal_reconnect_retries_invalid",
  );
  assertPositiveInteger(
    config.progressHeartbeatMs,
    "codex_goal_progress_heartbeat_invalid",
  );
}

function assertPositiveInteger(value: number | undefined, code: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}

function createCodexGoalProgressHeartbeat(input: {
  readonly progressPath: string;
  readonly taskId: string;
  readonly intervalMs: number;
}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let writes = Promise.resolve();
  const write = (patch: Omit<
    CodexGoalProgressSnapshot,
    "schemaVersion" | "taskId" | "updatedAt" | "pid"
  >) => {
    writes = writes.then(async () => {
      if (stopped && patch.status === "running") return;
      await writeCodexGoalProgress(input.progressPath, {
        schemaVersion: 1,
        taskId: input.taskId,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        ...patch,
      });
    });
    return writes;
  };
  return {
    async write(patch: Omit<
      CodexGoalProgressSnapshot,
      "schemaVersion" | "taskId" | "updatedAt" | "pid"
    >): Promise<void> {
      await write(patch);
    },
    start(): void {
      void write({ status: "running" });
      timer = setInterval(() => {
        void write({ status: "running" });
      }, input.intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      await writes;
    },
  };
}

function progressFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): Omit<CodexGoalProgressSnapshot, "schemaVersion" | "taskId" | "updatedAt" | "pid"> {
  const attempts = "attempts" in result && Array.isArray(result.attempts)
    ? result.attempts
    : [];
  const lastAttempt = attempts.at(-1);
  return {
    status: progressStatusFromResult(result.status),
    resultStatus: result.status,
    ...("reason" in result && typeof result.reason === "string"
      ? { reason: result.reason }
      : {}),
    attemptCount: attempts.length,
    ...(lastAttempt && "accountId" in lastAttempt && typeof lastAttempt.accountId === "string"
      ? { currentAccount: lastAttempt.accountId }
      : {}),
  };
}

function progressStatusFromResult(status: string): CodexGoalProgressStatus {
  if (status === "completed") return "completed";
  if (status === "partial") return "partial";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "failed";
}

async function writeCodexGoalProgress(
  path: string,
  snapshot: CodexGoalProgressSnapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}
