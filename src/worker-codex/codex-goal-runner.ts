import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";
import {
  AccessBoundary,
  type NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  SafeExecutionPolicy,
  SafeExecutionRunResult,
  TaskEffectMode,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexReasoningEffort,
  CodexServiceTier,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  LaunchPlanStatus,
  isSubscriptionWorkerError,
  normalizeWorkerReport,
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
import { migrateLegacyCodexAccountCapacity } from "./application/codex-account-capacity-store";
import type {
  CodexWorkerExecutionEngine,
  FileBackendCodexWorkerResult,
} from "./file-backend-codex-worker";
import {
  assertCodexGoalAccessLaunchAllowed,
  buildCodexGoalAccessLaunchPlan,
  codexGoalControlsForAccessBoundary,
} from "./codex-goal-access-plan";
import { readLocalGitHeadCommit } from "./codex-goal-git-revision";
import { createCodexGoalResultRecorder } from "./codex-goal-runtime-result-io";
import { materializeCodexGoalHandoffArtifacts } from "./codex-goal-handoff-artifacts";
import {
  codexGoalRuntimeEventObservability,
  createCodexGoalRuntimeEventWriter,
} from "./codex-goal-runtime-events";
export type {
  CodexGoalRuntimeEvent,
  CodexGoalRuntimeEventLevel,
} from "./codex-goal-runtime-events";

const execFileAsync = promisify(execFile);
const gitStatusTimeoutMs = 5_000;
const gitMetadataTimeoutMs = 5_000;

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
  readonly appServerStartupTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly quotaCooldownMs?: number;
  readonly reconnectCooldownMs?: number;
  readonly maxReconnectRetriesPerAccount?: number;
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
  readonly accessBoundary?: AccessBoundary;
  readonly projectAccessScope?: ProjectAccessScope;
  readonly allowDangerFullAccess?: boolean;
  readonly networkAccess?: NetworkAccessMode.Disabled | NetworkAccessMode.Restricted;
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

export const codexGoalLinkedWorktreeHandoffSystemPrompt = [
  "Linked git worktree sandbox rule:",
  "You are edit/test/handoff-only in this isolated linked worktree.",
  "Do not run git add, git commit, or git push.",
  "Run targeted verification, leave the workspace diff intact, and summarize changed files, tests, blockers, and risks in your final handoff.",
  "The project controller will apply, commit, and push through the Project Integration lifecycle.",
].join(" ");

export type CodexGoalProgressStatus =
  | "starting"
  | "running"
  | "stopped"
  | "maintenance_paused"
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
  readonly observability?: ObservabilityPort;
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
  assertCodexGoalAccessLaunchAllowed(config);
  const prompt = await readFile(config.promptPath, "utf8");
  const progressPath = codexGoalProgressPath(config);
  const runtimeEventsPath = codexGoalRuntimeEventsPath(config);
  const outputPath = codexGoalOutputPath(config);
  const resultRecorder = createCodexGoalResultRecorder({ outputPath });
  const progressHeartbeat = createCodexGoalProgressHeartbeat({
    progressPath,
    taskId: config.taskId,
    intervalMs: config.progressHeartbeatMs ?? 60_000,
  });
  const runtimeEvents = createCodexGoalRuntimeEventWriter({
    eventPath: runtimeEventsPath,
    taskId: config.taskId,
  });
  const observability =
    deps.observability ?? codexGoalRuntimeEventObservability(runtimeEvents);
  await runtimeEvents.write("runner_starting", {
    jobId: config.jobId ?? config.taskId,
    executionEngine: config.executionEngine ?? "app-server-goal",
    accountCount: config.accounts.length,
  });
  const baseCommit = await readLocalGitHeadCommit(config.workspacePath);
  const linkedWorktreeHandoff = await codexGoalLinkedWorktreeHandoffPreflight({
    config,
    prompt,
  });
  if (linkedWorktreeHandoff.enabled) {
    await runtimeEvents.write("linked_worktree_handoff_guardrail", {
      accessBoundary: config.accessBoundary ?? "",
      workspaceKind: "linked_git_worktree",
    });
  }
  if (linkedWorktreeHandoff.commitRequested) {
    await runtimeEvents.write("linked_worktree_commit_preflight_warning", {
      level: "warning",
      accessBoundary: config.accessBoundary ?? "",
      workspaceKind: "linked_git_worktree",
      guidance: "edit_test_handoff_only",
    });
  }
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
    observability,
  }));

  try {
    progressHeartbeat.start();
    await runtimeEvents.write("executor_started", {
      jobId: config.jobId ?? config.taskId,
      executionEngine: config.executionEngine ?? "app-server-goal",
    });
    const controls = codexGoalControlsForAccessBoundary(config);
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
          }
        : {}),
      controls: {
        ...controls,
      },
      systemPrompt: codexGoalRunSystemPrompt(config, {
        linkedWorktreeHandoff: linkedWorktreeHandoff.enabled,
      }),
      metadata: {
        goal: config.goalSummary ?? config.taskId,
        codexGoalObjective: config.codexGoalObjective ?? prompt,
      },
    });
    await resultRecorder.record(await codexRuntimeResultInput({
      config,
      result,
      ...(baseCommit === undefined ? {} : { baseCommit }),
    }));
    await progressHeartbeat.write(progressFromResult(result));
    await runtimeEvents.write("executor_finished", {
      status: result.status,
      attemptCount: attemptCountFromResult(result),
      currentAccount: currentAccountFromResult(result) ?? "",
    });
    return result;
  } catch (error) {
    const failure = codexRunnerExceptionFailure(error);
    await resultRecorder.record(await codexExceptionRuntimeResultInput({
      config,
      error,
      ...(baseCommit === undefined ? {} : { baseCommit }),
    }));
    await progressHeartbeat.write({
      status: "failed",
      reason: failure.reason,
    });
    await runtimeEvents.write("runner_exception", {
      level: "error",
      reason: failure.reason,
      safeMessage: failure.safeMessage,
    });
    throw error;
  } finally {
    await progressHeartbeat.stop();
    await executor.dispose();
    await runtimeEvents.write("runner_disposed", {
      jobId: config.jobId ?? config.taskId,
    });
  }
}

export function buildCodexGoalExecutorOptions(input: {
  readonly config: CodexGoalRunConfig;
  readonly stateRootDir: string;
  readonly encryptionKey: Uint8Array;
  readonly observability?: ObservabilityPort;
}): FileBackendCodexSafeExecutorOptions {
  const { config } = input;
  const accessLaunchPlan = buildCodexGoalAccessLaunchPlan(config);
  const commandPolicy =
    accessLaunchPlan?.status === LaunchPlanStatus.Ready &&
    accessLaunchPlan.commandPolicy.validateCommands
      ? accessLaunchPlan.commandPolicy
      : undefined;
  return {
    ...(config.executorId ? { executorId: config.executorId } : {}),
    authRootDir: config.authRootDir,
    ...(input.observability ? { observability: input.observability } : {}),
    stateRootDir: input.stateRootDir,
    accountCapacityStore: migrateLegacyCodexAccountCapacity({
      authRootDir: config.authRootDir,
      stateRootDir: input.stateRootDir,
      accountIds: config.accounts.map((account) => account.name),
      authJsonPaths: Object.fromEntries(
        config.accounts.map((account) => [
          account.name,
          account.authJsonPath ??
            join(config.authRootDir, account.name, "auth.json"),
        ]),
      ),
      ...(input.observability ? { observability: input.observability } : {}),
    }),
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
        ...(config.appServerStartupTimeoutMs === undefined
          ? {}
          : { appServerStartupTimeoutMs: config.appServerStartupTimeoutMs }),
        sourceEnv: config.sourceEnv ?? process.env,
        ...(commandPolicy === undefined ? {} : { commandPolicy }),
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

export function codexGoalRuntimeEventsPath(
  config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId">,
): string {
  return join(config.jobRootDir, `${config.taskId}.events.jsonl`);
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
  assertPositiveInteger(
    config.appServerStartupTimeoutMs,
    "codex_goal_app_server_startup_timeout_invalid",
  );
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

function codexGoalRunSystemPrompt(
  config: Pick<CodexGoalRunConfig, "taskId" | "workerReportMode">,
  options: { readonly linkedWorktreeHandoff?: boolean } = {},
): string {
  const prompts = [codexGoalWorkerSystemPrompt(config.taskId)];
  if (options.linkedWorktreeHandoff === true) {
    prompts.push(codexGoalLinkedWorktreeHandoffSystemPrompt);
  }
  if (config.workerReportMode === "structured-output") {
    prompts.push(codexWorkerReportSystemPrompt);
  }
  return prompts.join("\n\n");
}

async function codexGoalLinkedWorktreeHandoffPreflight(input: {
  readonly config: Pick<CodexGoalRunConfig, "accessBoundary" | "workspacePath">;
  readonly prompt: string;
}): Promise<{ readonly enabled: boolean; readonly commitRequested: boolean }> {
  if (input.config.accessBoundary !== AccessBoundary.IsolatedWorkspaceWrite) {
    return { enabled: false, commitRequested: false };
  }
  const linkedWorktree = await isLinkedGitWorktree(input.config.workspacePath);
  if (!linkedWorktree) return { enabled: false, commitRequested: false };
  return {
    enabled: true,
    commitRequested: promptRequestsWorkerGitCommit(input.prompt),
  };
}

async function isLinkedGitWorktree(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ], { timeout: gitMetadataTimeoutMs });
    const [gitDir, gitCommonDir] = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return Boolean(gitDir && gitCommonDir && gitDir !== gitCommonDir);
  } catch {
    return false;
  }
}

function promptRequestsWorkerGitCommit(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (/\bdo not\s+(?:run\s+)?git\s+(?:add|commit|push)\b/.test(normalized)) {
    return false;
  }
  if (/\bdo not\s+(?:commit|push)\b/.test(normalized)) return false;
  if (/\bwithout\s+(?:committing|pushing)\b/.test(normalized)) return false;
  if (/\bgit\s+(?:add|commit|push)\b/.test(normalized)) return true;
  if (/\b(?:create|make|produce)\s+(?:a\s+)?commit\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:commit|push)\s+(?:the\s+)?(?:changes|diff|work)\b/.test(normalized)) {
    return true;
  }
  return /(?:закоммит|закаммит|закамить|закомить|закоммить|запуш)/u.test(
    normalized,
  );
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
  const attempts = attemptsFromResult(result);
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

function attemptsFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
) {
  const attempts = "attempts" in result && Array.isArray(result.attempts)
    ? result.attempts
    : [];
  return attempts;
}

function attemptCountFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): number {
  return attemptsFromResult(result).length;
}

function currentAccountFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): string | undefined {
  const lastAttempt = attemptsFromResult(result).at(-1);
  return lastAttempt && "accountId" in lastAttempt &&
    typeof lastAttempt.accountId === "string"
    ? lastAttempt.accountId
    : undefined;
}

function progressStatusFromResult(status: string): CodexGoalProgressStatus {
  if (status === "completed") return "completed";
  if (status === "waiting_capacity") return "blocked";
  if (status === "partial") return "partial";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "failed";
}

async function codexRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly result: SafeExecutionRunResult<FileBackendCodexWorkerResult>;
  readonly baseCommit?: string;
}): Promise<RuntimeResultEnvelopeInput> {
  const changedFiles = changedFilesFromSafeExecutionResult(input.result);
  const workerReport = workerReportFromSafeExecutionResult(input.result);
  const reason = "reason" in input.result ? input.result.reason : undefined;
  const status = runtimeStatusFromSafeExecutionResult({
    resultStatus: input.result.status,
    changedFilesCount: changedFiles.length,
  });
  const handoff = changedFiles.length === 0
    ? null
    : await preservePatchArtifacts(input.config, input.baseCommit);
  const artifacts = handoff?.artifacts ?? [];
  const exactChangedFiles = handoff?.changedPaths ?? changedFiles;
  const details = runtimeResultDetails({
    ...("failureDetails" in input.result && input.result.failureDetails
      ? { failureDetails: input.result.failureDetails }
      : {}),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...(handoff?.errorCode === undefined
      ? {}
      : { handoffArtifactError: handoff.errorCode }),
  });
  return {
    status,
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason,
    changedFiles: exactChangedFiles,
    evidence: [
      ...runtimeEvidenceFromSafeExecutionResult(input.result),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...(handoff?.errorCode === undefined
        ? []
        : [`handoff_artifact_materialization_failed:${handoff.errorCode}`]),
      ...(changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: runtimeBlockersFromSafeExecutionResult(input.result),
    nextAction: runtimeActionFromSafeExecutionResult({
      status,
      resultStatus: input.result.status,
      reason,
      changedFilesCount: changedFiles.length,
    }),
    ...(workerReport === undefined ? {} : { workerReport }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(details === undefined ? {} : { details }),
  };
}

async function codexExceptionRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly error: unknown;
  readonly baseCommit?: string;
}): Promise<RuntimeResultEnvelopeInput> {
  const failure = codexRunnerExceptionFailure(input.error);
  const workspace = await changedFilesFromWorkspace(input.config.workspacePath);
  const changedFiles = workspace.changedFiles;
  const handoff = changedFiles.length === 0
    ? null
    : await preservePatchArtifacts(input.config, input.baseCommit);
  const artifacts = handoff?.artifacts ?? [];
  const exactChangedFiles = handoff?.changedPaths ?? changedFiles;
  const details = runtimeResultDetails({
    failureDetails: {
      errorName: input.error instanceof Error ? input.error.name : "unknown",
      ...(failure.errorCode === undefined
        ? {}
        : { errorCode: failure.errorCode }),
    },
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...(handoff?.errorCode === undefined
      ? {}
      : { handoffArtifactError: handoff.errorCode }),
  });
  return {
    status: changedFiles.length > 0 ? "partial" : "failed",
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason: failure.reason,
    changedFiles: exactChangedFiles,
    evidence: [
      failure.evidence,
      ...(workspace.warning ? [workspace.warning] : []),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...(handoff?.errorCode === undefined
        ? []
        : [`handoff_artifact_materialization_failed:${handoff.errorCode}`]),
      ...(changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: [failure.reason],
    nextAction: changedFiles.length > 0 ? "preserve_patch" : "recover",
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(details === undefined ? {} : { details }),
  };
}

function codexRunnerExceptionFailure(error: unknown): {
  readonly reason: string;
  readonly safeMessage: string;
  readonly evidence: string;
  readonly errorCode?: string;
} {
  for (const item of errorCauseChain(error)) {
    if (!isSubscriptionWorkerError(item)) continue;
    if (item.code === "subscription_worker_prewarm_failed") {
      return {
        reason: "prewarm_failed",
        safeMessage: "Codex provider prewarm failed before task execution.",
        evidence: "provider prewarm failed before any task attempt",
        errorCode: item.code,
      };
    }
    if (
      item.code === "subscription_worker_start_failed" ||
      item.code === "subscription_worker_start_timeout"
    ) {
      return {
        reason: "provider_start_failed",
        safeMessage: "Codex provider failed to start before task execution.",
        evidence: "provider start failed before any task attempt",
        errorCode: item.code,
      };
    }
  }
  return {
    reason: "runner_exception",
    safeMessage: error instanceof Error ? error.message : "Runner failed.",
    evidence: "runner threw before returning a safe execution result",
  };
}

function errorCauseChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause
      : undefined;
  }
  return chain;
}

function runtimeResultDetails(input: {
  readonly failureDetails?: Readonly<Record<string, string>>;
  readonly baseCommit?: string;
  readonly handoffArtifactError?: string;
}): Readonly<Record<string, string>> | undefined {
  const details = {
    ...(input.failureDetails ?? {}),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...(input.handoffArtifactError === undefined
      ? {}
      : { handoffArtifactError: input.handoffArtifactError }),
  };
  return Object.keys(details).length === 0 ? undefined : details;
}

function runtimeStatusFromSafeExecutionResult(input: {
  readonly resultStatus: SafeExecutionRunResult<FileBackendCodexWorkerResult>["status"];
  readonly changedFilesCount: number;
}): RuntimeResultStatus {
  if (input.resultStatus === "completed") return "done";
  if (input.resultStatus === "waiting_capacity") return "blocked";
  if (input.resultStatus === "partial") return "partial";
  if (input.resultStatus === "aborted" && input.changedFilesCount > 0) {
    return "partial";
  }
  return "failed";
}

function runtimeActionFromSafeExecutionResult(input: {
  readonly status: RuntimeResultStatus;
  readonly resultStatus?: SafeExecutionRunResult<FileBackendCodexWorkerResult>["status"];
  readonly reason?: string | undefined;
  readonly changedFilesCount: number;
}): RuntimeRecommendedAction {
  if (input.status === "done") return "review_completed";
  if (input.resultStatus === "waiting_capacity") return "wait";
  if (
    input.reason === "quota_limited" ||
    input.reason === "capacity_unavailable" ||
    input.reason === "account_unavailable" ||
    input.reason === "reconnect_required"
  ) {
    return "switch_account";
  }
  if (input.reason === "goal_slice_exhausted") return "launch_next_slice";
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
      "--untracked-files=all",
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
  config: Pick<
    CodexGoalRunConfig,
    "workspacePath" | "jobRootDir" | "jobId" | "taskId"
  >,
  expectedBaseCommit?: string,
): Promise<{
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly changedPaths?: readonly string[];
  readonly errorCode?: string;
} | null> {
  try {
    const materialized = await materializeCodexGoalHandoffArtifacts({
      workerJobId: config.jobId ?? config.taskId,
      taskId: config.taskId,
      workspacePath: config.workspacePath,
      jobRootDir: config.jobRootDir,
      ...(expectedBaseCommit === undefined ? {} : { expectedBaseCommit }),
    });
    return materialized === null
      ? {
          artifacts: [],
          errorCode: "handoff_patch_empty_for_dirty_workspace",
        }
      : {
          artifacts: materialized.artifacts,
          changedPaths: materialized.changedPaths,
        };
  } catch (error) {
    return {
      artifacts: [],
      errorCode: safeHandoffMaterializationErrorCode(error),
    };
  }
}

function safeHandoffMaterializationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0] ?? "";
  return /^handoff_[a-z0-9_]+$/.test(code)
    ? code
    : "handoff_artifact_materialization_failed";
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
