import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
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
  GitPatchPreserver,
  normalizeWorkerReport,
  StrictResultRecorder,
  type RuntimeRecommendedAction,
  type RuntimeResultArtifact,
  type RuntimeResultEnvelopeInput,
  type RuntimeResultStatus,
  type WorkerReport,
} from "@vioxen/subscription-runtime/worker-core";
import {
  FileBackendCodexSafeExecutor,
  type FileBackendCodexSafeExecutorOptions,
} from "./file-backend-codex-safe-executor";
import type {
  CodexWorkerExecutionEngine,
  FileBackendCodexWorkerResult,
} from "./file-backend-codex-worker";

const execFileAsync = promisify(execFile);
const gitStatusTimeoutMs = 5_000;

export type CodexGoalAccountSlot = {
  readonly name: string;
  readonly authJsonPath?: string;
};

export type CodexGoalRunConfig = {
  readonly jobId?: string;
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
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
  readonly goalSummary?: string;
  readonly codexGoalObjective?: string;
  readonly effectMode?: TaskEffectMode;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly requireGitWorkspace?: boolean;
  readonly prewarmOnStart?: boolean;
  readonly workerReportMode?: CodexGoalWorkerReportMode | undefined;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export type CodexGoalWorkerReportMode = "runtime-only" | "structured-output";

export const codexWorkerReportSchemaName = "codex-worker-report";

export const codexWorkerReportSchema = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["done", "partial", "blocked", "failed"],
    },
    evidence: {
      type: "array",
      items: { type: "string" },
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
    nextActionHint: { type: "string" },
    summary: { type: "string" },
  },
  required: ["outcome", "evidence", "blockers", "nextActionHint", "summary"],
  additionalProperties: false,
} as const;

export const codexWorkerReportSystemPrompt = [
  "When your task is finished or blocked, make the final assistant response a JSON object matching the codex-worker-report schema.",
  "Use outcome done only when the requested work is complete.",
  "Use partial when useful workspace changes exist but verification or completion is incomplete.",
  "Use blocked when you need operator input, account capacity, auth, permissions, or another external condition.",
  "Use failed when no useful result can be preserved.",
  "Keep evidence and blockers concise and factual.",
].join("\n");

export type CodexGoalProgressStatus =
  | "starting"
  | "running"
  | "completed"
  | "partial"
  | "blocked"
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
  const outputPath = codexGoalOutputPath(config);
  const resultRecorder = new StrictResultRecorder({ outputPath });
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
      ...(config.jobId === undefined ? {} : { jobId: config.jobId }),
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
      ...(config.workerReportMode === "structured-output"
        ? {
            outputSchemaName: codexWorkerReportSchemaName,
            systemPrompt: codexWorkerReportSystemPrompt,
          }
        : {}),
      controls: {
        editMode: config.editMode ?? "allow-edits",
        ...(config.providerSandboxMode === undefined
          ? {}
          : { providerSandboxMode: config.providerSandboxMode }),
      },
      systemPrompt: codexGoalWorkerSystemPrompt(config.taskId),
      metadata: {
        goal: config.goalSummary ?? config.taskId,
        codexGoalObjective: config.codexGoalObjective ?? prompt,
      },
    });
    await resultRecorder.record(await codexRuntimeResultInput({ config, result }));
    await progressHeartbeat.write(progressFromResult(result));
    return result;
  } catch (error) {
    await resultRecorder.record(await codexExceptionRuntimeResultInput({
      config,
      error,
    }));
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
    ...(config.workerReportMode === "structured-output"
      ? {
          outputSchemas: {
            [codexWorkerReportSchemaName]: codexWorkerReportSchema,
          },
        }
      : {}),
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

export function codexGoalOutputPath(
  config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "outputPath">,
): string {
  return config.outputPath ?? join(config.jobRootDir, `${config.taskId}.latest-result.json`);
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

function codexGoalWorkerSystemPrompt(taskId: string): string {
  return [
    "Codex goal runtime artifact rule:",
    "If the task asks you to write a report, evidence file, or other artifact to a path outside the current workspace and the sandbox denies that write, write the artifact under /tmp instead.",
    `Use a task-specific directory such as /tmp/${taskId}-artifacts, include the exact fallback path in your final output, and do not mark the goal blocked solely because the external copy could not be performed.`,
    "Keep source worktrees clean unless the task explicitly requires code or docs changes.",
  ].join(" ");
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

async function codexRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly result: SafeExecutionRunResult<FileBackendCodexWorkerResult>;
}): Promise<RuntimeResultEnvelopeInput> {
  const changedFiles = changedFilesFromSafeExecutionResult(input.result);
  const workerReport = workerReportFromSafeExecutionResult(input.result);
  const reason = "reason" in input.result ? input.result.reason : undefined;
  const status = runtimeStatusFromSafeExecutionResult({
    resultStatus: input.result.status,
    changedFilesCount: changedFiles.length,
  });
  const artifacts = status === "done" || changedFiles.length === 0
    ? []
    : await preservePatchArtifacts(input.config);
  return {
    status,
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason,
    changedFiles,
    evidence: [
      ...runtimeEvidenceFromSafeExecutionResult(input.result),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...(changedFiles.length > 0 && artifacts.length === 0 && status !== "done"
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: runtimeBlockersFromSafeExecutionResult(input.result),
    nextAction: runtimeActionFromSafeExecutionResult({
      status,
      reason,
      changedFilesCount: changedFiles.length,
    }),
    ...(workerReport === undefined ? {} : { workerReport }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...("failureDetails" in input.result && input.result.failureDetails
      ? { details: input.result.failureDetails }
      : {}),
  };
}

async function codexExceptionRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly error: unknown;
}): Promise<RuntimeResultEnvelopeInput> {
  const workspace = await changedFilesFromWorkspace(input.config.workspacePath);
  const changedFiles = workspace.changedFiles;
  const artifacts = changedFiles.length === 0
    ? []
    : await preservePatchArtifacts(input.config);
  return {
    status: changedFiles.length > 0 ? "partial" : "failed",
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason: "runner_exception",
    changedFiles,
    evidence: [
      "runner threw before returning a safe execution result",
      ...(workspace.warning ? [workspace.warning] : []),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...(changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: ["runner_exception"],
    nextAction: changedFiles.length > 0 ? "preserve_patch" : "recover",
    ...(artifacts.length === 0 ? {} : { artifacts }),
    details: {
      errorName: input.error instanceof Error ? input.error.name : "unknown",
    },
  };
}

function runtimeStatusFromSafeExecutionResult(input: {
  readonly resultStatus: SafeExecutionRunResult<FileBackendCodexWorkerResult>["status"];
  readonly changedFilesCount: number;
}): RuntimeResultStatus {
  if (input.resultStatus === "completed") return "done";
  if (input.resultStatus === "partial") return "partial";
  if (input.resultStatus === "aborted" && input.changedFilesCount > 0) {
    return "partial";
  }
  return "failed";
}

function runtimeActionFromSafeExecutionResult(input: {
  readonly status: RuntimeResultStatus;
  readonly reason?: string | undefined;
  readonly changedFilesCount: number;
}): RuntimeRecommendedAction {
  if (input.status === "done") return "review_completed";
  if (
    input.reason === "quota_limited" ||
    input.reason === "capacity_unavailable" ||
    input.reason === "account_unavailable" ||
    input.reason === "reconnect_required"
  ) {
    return "switch_account";
  }
  if (input.reason === "permission_required") return "ask_user";
  if (input.changedFilesCount > 0) return "preserve_patch";
  return input.status === "failed" ? "recover" : "continue";
}

function runtimeEvidenceFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): readonly string[] {
  const evidence = [`safe_execution_status:${result.status}`];
  if (result.task.outputSummary) {
    evidence.push(`output_summary:${result.task.outputSummary}`);
  }
  if (result.attempts.length > 0) {
    evidence.push(`attempt_count:${result.attempts.length}`);
  }
  return evidence;
}

function runtimeBlockersFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): readonly string[] {
  if (result.status === "completed") return [];
  const blockers: string[] = "reason" in result ? [result.reason] : [];
  if ("safeMessage" in result && result.safeMessage) {
    blockers.push(result.safeMessage);
  }
  return blockers;
}

function workerReportFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): WorkerReport | undefined {
  if (result.status !== "completed") return undefined;
  if (!("result" in result) || result.result === undefined) return undefined;
  return normalizeWorkerReport(result.result.structuredOutput);
}

function changedFilesFromSafeExecutionResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): readonly string[] {
  return uniqueStrings(result.attempts.flatMap((attempt) => attempt.changedFiles));
}

async function changedFilesFromWorkspace(
  workspacePath: string,
): Promise<{
  readonly changedFiles: readonly string[];
  readonly warning?: string;
}> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "status",
      "--porcelain",
    ], { timeout: gitStatusTimeoutMs });
    const changedFiles = stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => statusPorcelainPath(line))
      .filter((path) => path.length > 0);
    return { changedFiles };
  } catch {
    return {
      changedFiles: [],
      warning: "workspace_changed_files_unavailable",
    };
  }
}

function statusPorcelainPath(line: string): string {
  const path = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renameTarget = path.split(" -> ").at(-1);
  return renameTarget?.trim() ?? path;
}

async function preservePatchArtifacts(
  config: Pick<CodexGoalRunConfig, "workspacePath" | "jobRootDir" | "taskId">,
): Promise<readonly RuntimeResultArtifact[]> {
  try {
    const artifact = await new GitPatchPreserver().preserve({
      workspacePath: config.workspacePath,
      outputPath: join(config.jobRootDir, `${config.taskId}.preserved.patch`),
    });
    return artifact ? [artifact] : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim()))];
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
