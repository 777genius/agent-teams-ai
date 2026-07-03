import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  readCodexAuthJsonFreshness,
  validateCodexAuthJsonBytes,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  GitPatchPreserver,
  StrictResultRecorder,
  actionForRuntimeState,
  classifyRuntimeRunState,
  hostExecutableNotFoundMessage,
  resolveHostExecutable,
  RunProcessAliveReason,
  RunProcessSupervisorKind,
  type RunProgressClassification,
  type RuntimeRecommendedAction,
  type RuntimeResultEnvelope,
  type RuntimeResultStatus,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  codexGoalOutputPath,
  codexGoalProgressPath,
  codexGoalRuntimeEventsPath,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";

const execFileAsync = promisify(execFile);
const gitStatusTimeoutMs = 5_000;
const processCpuActiveThreshold = 0.1;

export type CodexGoalOutputFormat = "text" | "json";

export type CodexGoalLaunchInput = {
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly cwd: string;
  readonly logPath: string;
  readonly format?: CodexGoalOutputFormat;
  readonly cliCommand: readonly string[];
};

export type CodexGoalTmuxCommand = {
  readonly args: readonly string[];
  readonly preview: string;
};

export type CodexGoalStatusInput = {
  readonly jobRootDir?: string;
  readonly taskId?: string;
  readonly resultPath?: string;
  readonly workspacePath?: string;
  readonly tmuxSession?: string;
  readonly logPath?: string;
  readonly progressPath?: string;
};

export type CodexGoalRecommendedAction =
  | "start_worker"
  | "wait_for_worker"
  | "review_completed"
  | "continue_after_capacity"
  | "continue_after_timeout"
  | "continue_after_provider_output"
  | "ask_user"
  | "inspect_dirty_workspace"
  | "inspect_dirty_failure"
  | "inspect_failure"
  | "check_log_or_result";

export type CodexGoalStatus = {
  readonly tmuxAlive?: boolean;
  readonly resultPath?: string;
  readonly resultExists?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly resultUpdatedAt?: string;
  readonly workspaceDirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly logPath?: string;
  readonly logExists?: boolean;
  readonly logUpdatedAt?: string;
  readonly logByteLength?: number;
  readonly progressPath?: string;
  readonly progressExists?: boolean;
  readonly progressStatus?: string;
  readonly progressUpdatedAt?: string;
  readonly progressHeartbeatAgeMs?: number;
  readonly progressPid?: number;
  readonly progressProcessAlive?: boolean;
  readonly progressCpuActive?: boolean;
  readonly progressCommand?: string;
  readonly progressResultStatus?: string;
  readonly progressResultReason?: string;
  readonly progressAttemptCount?: number;
  readonly progressCurrentAccount?: string;
  readonly runtimeEventsPath?: string;
  readonly runtimeEventsExists?: boolean;
  readonly runtimeEventsUpdatedAt?: string;
  readonly runtimeEventsByteLength?: number;
  readonly lastRuntimeEvent?: string;
  readonly lastRuntimeEventAt?: string;
  readonly lastRuntimeEventLevel?: string;
  readonly recommendedAction: CodexGoalRecommendedAction;
  readonly warnings: readonly string[];
};

export type CodexGoalRuntimeResultReconcileInput = {
  readonly config: Pick<
    CodexGoalRunConfig,
    "jobRootDir" | "jobId" | "outputPath" | "taskId" | "workspacePath"
  >;
  readonly status?: CodexGoalStatus;
  readonly reason?: string;
  readonly forceWrite?: boolean;
  readonly preservePatch?: boolean;
  readonly silentStale?: boolean;
  readonly heartbeatOnlyNoOutput?: boolean;
};

export type CodexGoalRuntimeResultReconcileResult = {
  readonly wrote: boolean;
  readonly reason: string;
  readonly outputPath: string;
  readonly classification?: RunProgressClassification;
  readonly recommendedAction?: RuntimeRecommendedAction;
  readonly result?: RuntimeResultEnvelope;
};

export type CodexGoalRuntimeResultReconcilerPort = {
  reconcile(
    input: CodexGoalRuntimeResultReconcileInput,
  ): Promise<CodexGoalRuntimeResultReconcileResult>;
};

export class CodexGoalRuntimeResultReconciler
  implements CodexGoalRuntimeResultReconcilerPort
{
  async reconcile(
    input: CodexGoalRuntimeResultReconcileInput,
  ): Promise<CodexGoalRuntimeResultReconcileResult> {
    return reconcileCodexGoalRuntimeResult(input);
  }
}

export type CodexGoalProcessSnapshotRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly cpu: number;
  readonly command: string;
};

export type CodexGoalProcessSnapshot = {
  readonly alive?: boolean;
  readonly cpuActive?: boolean;
  readonly command?: string;
};

export type CodexGoalWorkerLiveness = {
  readonly alive: boolean;
  readonly supervisorKind: RunProcessSupervisorKind;
  readonly aliveReason: RunProcessAliveReason;
  readonly processAlive: boolean;
  readonly freshProgressAlive: boolean;
};

export type CodexGoalDoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
};

export type CodexGoalDoctorResult = {
  readonly ok: boolean;
  readonly checks: readonly CodexGoalDoctorCheck[];
};

export type CodexGoalAccountStatus =
  | "ready"
  | "auth_missing"
  | "auth_invalid";

export type CodexGoalAccountSlotStatus = {
  readonly name: string;
  readonly authJsonPath: string;
  readonly status: CodexGoalAccountStatus;
  readonly byteLength?: number;
  readonly authJsonSha256Prefix?: string;
  readonly identitySource?: string;
  readonly identityHashPrefix?: string;
  readonly lastRefreshAt?: string;
  readonly expiresAt?: string;
  readonly capacityAvailability?: string;
  readonly capacityReason?: string;
  readonly capacityCooldownUntil?: string;
  readonly capacityLastLimitSignalAt?: string;
  readonly liveCheck?: "passed" | "failed";
  readonly liveCheckSafeMessage?: string;
  readonly warnings: readonly string[];
  readonly safeMessage: string;
};

export type CodexGoalAccountStatusInput = {
  readonly authRootDir: string;
  readonly accounts?: readonly string[];
  readonly stateRootDir?: string;
  readonly liveCheck?: boolean;
  readonly codexBinaryPath?: string;
  readonly liveCheckTimeoutMs?: number;
};

export function buildCodexGoalNoTmuxCommand(input: CodexGoalLaunchInput): string {
  const config = input.config;
  const args = [
    ...input.cliCommand,
    "run",
    "--no-tmux",
    "--job-root",
    config.jobRootDir,
    "--auth-root",
    config.authRootDir,
    "--workspace",
    config.workspacePath,
    "--prompt",
    config.promptPath,
    "--task-id",
    config.taskId,
    "--accounts",
    config.accounts.map((account) => account.name).join(","),
    "--format",
    input.format ?? "text",
  ];
  pushOptional(args, "--state-root", config.stateRootDir);
  pushOptional(args, "--job-id", config.jobId);
  pushOptional(args, "--output", config.outputPath);
  pushOptional(args, "--progress", config.progressPath);
  pushOptional(args, "--codex-binary", config.codexBinaryPath);
  pushOptional(args, "--model", config.model);
  pushOptional(args, "--effort", config.reasoningEffort);
  pushOptional(args, "--service-tier", config.serviceTier);
  pushOptional(args, "--execution-engine", config.executionEngine);
  pushOptionalNumber(args, "--timeout-ms", config.taskTimeoutMs);
  pushOptionalNumber(args, "--progress-heartbeat-ms", config.progressHeartbeatMs);
  pushOptionalNumber(args, "--stale-lock-ms", config.staleLockMs);
  pushOptionalNumber(args, "--max-account-cycles", config.maxAccountCycles);
  pushOptional(args, "--edit-mode", config.editMode);
  pushOptional(args, "--provider-sandbox-mode", config.providerSandboxMode);
  if (config.allowDuplicateAccountIdentities) args.push("--allow-duplicate-accounts");
  if (config.requireGitWorkspace === false) args.push("--no-require-git-workspace");
  if (config.prewarmOnStart) args.push("--prewarm");
  return args.map(shellQuote).join(" ");
}

export function buildCodexGoalTmuxCommand(
  input: CodexGoalLaunchInput,
): CodexGoalTmuxCommand {
  if (!input.tmuxSession) {
    throw new Error("codex_goal_tmux_session_required");
  }
  const shellCommand = `${buildCodexGoalNoTmuxCommand(input)} 2>&1 | tee -a ${shellQuote(input.logPath)}`;
  const args = [
    "new-session",
    "-d",
    "-s",
    input.tmuxSession,
    "-c",
    input.cwd,
    shellCommand,
  ] as const;
  return {
    args,
    preview: `tmux ${args.map(shellQuote).join(" ")}`,
  };
}

export async function startCodexGoalTmux(
  input: CodexGoalLaunchInput,
): Promise<CodexGoalTmuxCommand> {
  await prepareCodexGoalLaunchPaths(input);
  const command = buildCodexGoalTmuxCommand(input);
  await execFileAsync(await resolveTmuxExecutable(), command.args);
  return command;
}

export async function prepareCodexGoalLaunchPaths(
  input: CodexGoalLaunchInput,
): Promise<void> {
  const paths = [
    input.config.jobRootDir,
    input.logPath,
    input.config.outputPath,
    input.config.progressPath,
  ];
  const dirs = new Set(
    paths
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .map((path) => (path === input.config.jobRootDir ? path : dirname(path))),
  );

  await Promise.all(
    [...dirs].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
}

export function buildCodexGoalStopTmuxCommand(
  tmuxSession: string,
): CodexGoalTmuxCommand {
  if (!tmuxSession.trim()) {
    throw new Error("codex_goal_tmux_session_required");
  }
  const args = ["kill-session", "-t", tmuxSession] as const;
  return {
    args,
    preview: `tmux ${args.map(shellQuote).join(" ")}`,
  };
}

export async function stopCodexGoalTmux(
  tmuxSession: string,
): Promise<CodexGoalTmuxCommand> {
  const command = buildCodexGoalStopTmuxCommand(tmuxSession);
  await execFileAsync(await resolveTmuxExecutable(), command.args);
  return command;
}

export async function collectCodexGoalStatus(
  input: CodexGoalStatusInput,
): Promise<CodexGoalStatus> {
  const warnings: string[] = [];
  const resultPath = input.resultPath ?? (input.jobRootDir && input.taskId
    ? codexGoalOutputPath({
        jobRootDir: input.jobRootDir,
        taskId: input.taskId,
      })
    : undefined);
  const resultExists = resultPath ? await fileExists(resultPath) : undefined;
  const resultFile = resultPath ? await logFileStatus(resultPath) : {};
  const result = resultPath && resultExists
    ? await readCodexGoalResultSummary(resultPath)
    : {};
  let tmuxAlive: boolean | undefined;
  if (input.tmuxSession) {
    const tmux = await inspectTmuxSession(input.tmuxSession);
    tmuxAlive = tmux.alive;
    if (!tmuxAlive) warnings.push("tmux session is not alive");
    if (tmux.warning) warnings.push(tmux.warning);
  }
  const workspace = input.workspacePath
    ? await gitWorkspaceStatus(input.workspacePath)
    : {};
  if (workspace.warning) warnings.push(workspace.warning);
  const log = input.logPath ?? (input.jobRootDir && input.taskId
    ? join(input.jobRootDir, `${input.taskId}.log`)
    : undefined);
  const logStatus = log ? await logFileStatus(log) : {};
  const progressPath = input.progressPath ?? (input.jobRootDir && input.taskId
    ? codexGoalProgressPath({
        jobRootDir: input.jobRootDir,
        taskId: input.taskId,
      })
    : undefined);
  const progress = progressPath ? await readCodexGoalProgressSummary(progressPath) : {};
  const progressProcess = progress.pid === undefined
    ? {}
    : await inspectProcessSnapshot(progress.pid);
  if (progress.warning) warnings.push(progress.warning);
  const runtimeEventsPath = input.jobRootDir && input.taskId
    ? codexGoalRuntimeEventsPath({
        jobRootDir: input.jobRootDir,
        taskId: input.taskId,
      })
    : undefined;
  const runtimeEventsStatus = runtimeEventsPath
    ? await logFileStatus(runtimeEventsPath)
    : {};
  const lastRuntimeEvent = runtimeEventsPath
    ? await readLastCodexGoalRuntimeEvent(runtimeEventsPath)
    : {};
  if (lastRuntimeEvent.warning) warnings.push(lastRuntimeEvent.warning);
  return {
    ...(tmuxAlive === undefined ? {} : { tmuxAlive }),
    ...(resultPath === undefined ? {} : { resultPath }),
    ...(resultExists === undefined ? {} : { resultExists }),
    ...(result.status === undefined ? {} : { resultStatus: result.status }),
    ...(result.reason === undefined ? {} : { resultReason: result.reason }),
    ...(resultFile.updatedAt === undefined
      ? {}
      : { resultUpdatedAt: resultFile.updatedAt }),
    ...(workspace.dirty === undefined ? {} : { workspaceDirty: workspace.dirty }),
    ...(workspace.changedFiles === undefined
      ? {}
      : { changedFiles: workspace.changedFiles }),
    ...(log === undefined ? {} : { logPath: log }),
    ...(logStatus.exists === undefined ? {} : { logExists: logStatus.exists }),
    ...(logStatus.updatedAt === undefined
      ? {}
      : { logUpdatedAt: logStatus.updatedAt }),
    ...(logStatus.byteLength === undefined
      ? {}
      : { logByteLength: logStatus.byteLength }),
    ...(progressPath === undefined ? {} : { progressPath }),
    ...(progress.exists === undefined ? {} : { progressExists: progress.exists }),
    ...(progress.status === undefined ? {} : { progressStatus: progress.status }),
    ...(progress.updatedAt === undefined
      ? {}
      : { progressUpdatedAt: progress.updatedAt }),
    ...(progress.heartbeatAgeMs === undefined
      ? {}
      : { progressHeartbeatAgeMs: progress.heartbeatAgeMs }),
    ...(progress.pid === undefined ? {} : { progressPid: progress.pid }),
    ...(progressProcess.alive === undefined
      ? {}
      : { progressProcessAlive: progressProcess.alive }),
    ...(progressProcess.cpuActive === undefined
      ? {}
      : { progressCpuActive: progressProcess.cpuActive }),
    ...(progressProcess.command === undefined
      ? {}
      : { progressCommand: progressProcess.command }),
    ...(progress.resultStatus === undefined
      ? {}
      : { progressResultStatus: progress.resultStatus }),
    ...(progress.reason === undefined
      ? {}
      : { progressResultReason: progress.reason }),
    ...(progress.attemptCount === undefined
      ? {}
      : { progressAttemptCount: progress.attemptCount }),
    ...(progress.currentAccount === undefined
      ? {}
      : { progressCurrentAccount: progress.currentAccount }),
    ...(runtimeEventsPath === undefined ? {} : { runtimeEventsPath }),
    ...(runtimeEventsStatus.exists === undefined
      ? {}
      : { runtimeEventsExists: runtimeEventsStatus.exists }),
    ...(runtimeEventsStatus.updatedAt === undefined
      ? {}
      : { runtimeEventsUpdatedAt: runtimeEventsStatus.updatedAt }),
    ...(runtimeEventsStatus.byteLength === undefined
      ? {}
      : { runtimeEventsByteLength: runtimeEventsStatus.byteLength }),
    ...(lastRuntimeEvent.event === undefined
      ? {}
      : { lastRuntimeEvent: lastRuntimeEvent.event }),
    ...(lastRuntimeEvent.timestamp === undefined
      ? {}
      : { lastRuntimeEventAt: lastRuntimeEvent.timestamp }),
    ...(lastRuntimeEvent.level === undefined
      ? {}
      : { lastRuntimeEventLevel: lastRuntimeEvent.level }),
    recommendedAction: recommendCodexGoalAction({
      ...(tmuxAlive === undefined ? {} : { tmuxAlive }),
      ...(result.status === undefined ? {} : { resultStatus: result.status }),
      ...(result.reason === undefined ? {} : { resultReason: result.reason }),
      ...(progress.status === undefined ? {} : { progressStatus: progress.status }),
      ...(workspace.dirty === undefined
        ? {}
        : { workspaceDirty: workspace.dirty }),
      ...(resultExists === undefined ? {} : { resultExists }),
    }),
    warnings,
  };
}

export function resolveCodexGoalWorkerLiveness(input: {
  readonly status: Pick<
    CodexGoalStatus,
    | "tmuxAlive"
    | "progressExists"
    | "progressStatus"
    | "progressHeartbeatAgeMs"
    | "progressProcessAlive"
  >;
  readonly progressStale?: boolean;
}): CodexGoalWorkerLiveness {
  const tmuxAlive = input.status.tmuxAlive === true;
  const terminalProgress = input.status.progressStatus === "completed" ||
    input.status.progressStatus === "failed" ||
    input.status.progressStatus === "maintenance_paused";
  const processAlive = !terminalProgress &&
    (tmuxAlive || input.status.progressProcessAlive === true);
  const freshProgressAlive = Boolean(
    !terminalProgress &&
      input.status.progressExists &&
      input.status.progressStatus === "running" &&
      input.status.progressHeartbeatAgeMs !== undefined &&
      input.progressStale !== true,
  );
  const alive = processAlive || freshProgressAlive;
  const supervisorKind = tmuxAlive
    ? RunProcessSupervisorKind.Tmux
    : terminalProgress
    ? RunProcessSupervisorKind.None
    : input.status.progressProcessAlive === true
    ? RunProcessSupervisorKind.Direct
    : freshProgressAlive
    ? RunProcessSupervisorKind.External
    : RunProcessSupervisorKind.None;
  return {
    alive,
    supervisorKind,
    aliveReason: tmuxAlive
      ? RunProcessAliveReason.Tmux
      : terminalProgress
      ? RunProcessAliveReason.TerminalResult
      : input.status.progressProcessAlive === true
      ? RunProcessAliveReason.Pid
      : freshProgressAlive
      ? RunProcessAliveReason.FreshProgress
      : input.status.progressStatus === "running" && input.progressStale === true
      ? RunProcessAliveReason.StaleProgress
      : RunProcessAliveReason.Unknown,
    processAlive,
    freshProgressAlive,
  };
}

export async function reconcileCodexGoalRuntimeResult(
  input: CodexGoalRuntimeResultReconcileInput,
): Promise<CodexGoalRuntimeResultReconcileResult> {
  const status = input.status ?? await collectCodexGoalStatus({
    jobRootDir: input.config.jobRootDir,
    taskId: input.config.taskId,
    workspacePath: input.config.workspacePath,
    ...(input.config.outputPath === undefined
      ? {}
      : { resultPath: input.config.outputPath }),
  });
  const outputPath = input.config.outputPath ?? codexGoalOutputPath({
    jobRootDir: input.config.jobRootDir,
    taskId: input.config.taskId,
  });
  const existingStrictResult = await readStrictRuntimeResultEnvelope(outputPath);
  if (!input.forceWrite && existingStrictResult) {
    return {
      wrote: false,
      reason: "strict_result_already_exists",
      outputPath,
      result: existingStrictResult,
    };
  }

  const changedFiles = status.changedFiles ?? [];
  const nonStrictExistingResult = status.resultExists === true && !existingStrictResult;
  const progressStaleForReconcile = staleProgress(status);
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale: progressStaleForReconcile,
  });
  const classification = classifyRuntimeRunState({
    status: workerLiveness.alive ? "running" : "failed",
    liveness: workerLiveness.alive ? "alive" : "dead",
    workspaceDirty: status.workspaceDirty,
    changedFilesCount: changedFiles.length,
    processAlive: workerLiveness.alive,
    processCpuActive: status.progressCpuActive,
    processCommand: status.progressCommand,
    progressStatus: status.progressStatus,
    progressStale: progressStaleForReconcile,
    progressSilentStale: input.silentStale,
    heartbeatOnlyNoOutput: input.heartbeatOnlyNoOutput,
    resultExists: status.resultExists,
    resultStatus: status.resultStatus,
    resultReason: status.resultReason,
    logStale: false,
    logByteLength: status.logByteLength,
  });
  const runtimeStatus = runtimeStatusForReconciledResult({
    classification,
    changedFilesCount: changedFiles.length,
  });
  const reason = input.reason ??
    status.resultReason ??
    (nonStrictExistingResult ? "non_strict_runtime_result" : undefined) ??
    reasonForReconciledResult({
      classification,
      ...(status.resultExists === undefined ? {} : { resultExists: status.resultExists }),
      ...(status.resultStatus === undefined ? {} : { resultStatus: status.resultStatus }),
      ...(status.tmuxAlive === undefined ? {} : { tmuxAlive: status.tmuxAlive }),
    });
  const artifacts = input.preservePatch === false || changedFiles.length === 0
    ? []
    : await preserveCodexGoalPatchArtifact({
        workspacePath: input.config.workspacePath,
        outputPath: join(input.config.jobRootDir, `${input.config.taskId}.preserved.patch`),
      });
  const nextAction = actionForRuntimeState({
    status: runtimeStatus,
    classification,
    reason,
    changedFilesCount: changedFiles.length,
  });
  const result = await new StrictResultRecorder({ outputPath }).record({
    status: runtimeStatus,
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    classification,
    reason,
    changedFiles,
    evidence: [
      "supervisor_reconciled_result",
      ...(status.resultExists === false ? ["latest_result_missing"] : []),
      ...(nonStrictExistingResult
        ? [`latest_result_non_strict:${status.resultStatus ?? "unknown"}`]
        : []),
      ...(!workerLiveness.alive ? ["worker_not_alive"] : []),
      ...(status.progressStatus ? [`progress_status:${status.progressStatus}`] : []),
      ...status.warnings.map((warning) => `status_warning:${warning}`),
      ...(status.logByteLength === undefined
        ? []
        : [`log_byte_length:${status.logByteLength}`]),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...(changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: runtimeStatus === "done" ? [] : [reason, classification],
    nextAction,
    ...(artifacts.length === 0 ? {} : { artifacts }),
    details: {
      source: "codex_goal_runtime_result_reconcile",
    },
  });
  return {
    wrote: true,
    reason,
    outputPath,
    classification,
    recommendedAction: nextAction,
    result,
  };
}

export async function doctorCodexGoal(input: {
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
}): Promise<CodexGoalDoctorResult> {
  const checks = await Promise.all([
    checkFile("prompt", input.config.promptPath),
    checkDirectory("jobRoot", input.config.jobRootDir),
    checkDirectory("authRoot", input.config.authRootDir),
    checkGitWorkspace(input.config.workspacePath),
    ...(input.tmuxSession
      ? [checkTmuxSessionAvailable(input.tmuxSession)]
      : []),
    ...input.config.accounts.map((account) =>
      checkFile(
        `account:${account.name}`,
        account.authJsonPath ??
          join(input.config.authRootDir, account.name, "auth.json"),
      ),
    ),
  ]);
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export async function tailCodexGoalLog(
  logPath: string,
  lines: number,
): Promise<string> {
  const text = await readFile(logPath, "utf8");
  return `${text.split(/\r?\n/).slice(-lines).join("\n")}\n`;
}

export async function listCodexGoalAccountStatuses(
  input: CodexGoalAccountStatusInput,
): Promise<readonly CodexGoalAccountSlotStatus[]> {
  const accountNames = input.accounts?.length
    ? input.accounts
    : await listAccountDirectories(input.authRootDir);
  return Promise.all(
    accountNames.map((name) =>
      inspectCodexGoalAccount({
        authRootDir: input.authRootDir,
        name,
        ...(input.stateRootDir ? { stateRootDir: input.stateRootDir } : {}),
        ...(input.liveCheck ? { liveCheck: input.liveCheck } : {}),
        ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
        ...(input.liveCheckTimeoutMs ? { liveCheckTimeoutMs: input.liveCheckTimeoutMs } : {}),
      }),
    ),
  );
}

export function recommendCodexGoalAction(input: {
  readonly tmuxAlive?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly progressStatus?: string;
  readonly workspaceDirty?: boolean;
  readonly resultExists?: boolean;
}): CodexGoalRecommendedAction {
  if (input.tmuxAlive) return "wait_for_worker";
  if (input.progressStatus === "maintenance_paused") return "start_worker";
  if (input.resultStatus === "done" || input.resultStatus === "completed") {
    return "review_completed";
  }
  if (!input.resultExists) {
    return input.workspaceDirty ? "inspect_dirty_workspace" : "start_worker";
  }
  if (
    input.resultReason === "quota_limited" ||
    input.resultReason === "capacity_unavailable" ||
    input.resultReason === "account_unavailable" ||
    input.resultReason === "reconnect_required"
  ) {
    return "continue_after_capacity";
  }
  if (input.resultReason === "task_timeout") return "continue_after_timeout";
  if (input.resultReason === "provider_output_invalid") {
    return input.workspaceDirty
      ? "inspect_dirty_failure"
      : "continue_after_provider_output";
  }
  if (input.resultStatus === "blocked") return "ask_user";
  if (
    input.resultStatus === "partial" ||
    input.resultStatus === "failed" ||
    input.resultStatus === "aborted"
  ) {
    return input.workspaceDirty ? "inspect_dirty_failure" : "inspect_failure";
  }
  return "check_log_or_result";
}

function runtimeStatusForReconciledResult(input: {
  readonly classification: RunProgressClassification;
  readonly changedFilesCount: number;
}): RuntimeResultStatus {
  if (
    input.classification === "provider_capacity_unavailable" ||
    input.classification === "auth_or_quota_blocked" ||
    input.classification === "app_server_goal_blocked"
  ) {
    return "blocked";
  }
  return input.changedFilesCount > 0 ? "partial" : "failed";
}

function reasonForReconciledResult(input: {
  readonly classification: RunProgressClassification;
  readonly resultExists?: boolean;
  readonly resultStatus?: string;
  readonly tmuxAlive?: boolean;
}): string {
  if (input.resultExists === false) return "missing_runtime_result";
  if (input.resultExists === true && !isStrictRuntimeResultStatus(input.resultStatus)) {
    return "non_strict_runtime_result";
  }
  if (input.tmuxAlive === false) return "worker_stopped_before_result";
  return input.classification;
}

function staleProgress(status: CodexGoalStatus): boolean {
  if (status.progressHeartbeatAgeMs === undefined) return false;
  return status.progressHeartbeatAgeMs > 10 * 60_000;
}

function isStrictRuntimeResultStatus(
  value: string | undefined,
): value is RuntimeResultStatus {
  return value === "done" ||
    value === "partial" ||
    value === "blocked" ||
    value === "failed";
}

async function readStrictRuntimeResultEnvelope(
  path: string,
): Promise<RuntimeResultEnvelope | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return null;
    if (!isStrictRuntimeResultStatus(
      typeof parsed.status === "string" ? parsed.status : undefined,
    )) return null;
    if (!stringArrayField(parsed.changedFiles)) return null;
    if (!stringArrayField(parsed.evidence)) return null;
    if (!stringArrayField(parsed.blockers)) return null;
    if (!isRuntimeRecommendedAction(parsed.nextAction)) return null;
    return parsed as RuntimeResultEnvelope;
  } catch {
    return null;
  }
}

function stringArrayField(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRuntimeRecommendedAction(
  value: unknown,
): value is RuntimeRecommendedAction {
  return value === "wait" ||
    value === "wait_with_limit" ||
    value === "continue" ||
    value === "recover" ||
    value === "stop" ||
    value === "preserve_patch" ||
    value === "switch_account" ||
    value === "ask_user" ||
    value === "launch_next_slice" ||
    value === "review_completed";
}

async function preserveCodexGoalPatchArtifact(input: {
  readonly workspacePath: string;
  readonly outputPath: string;
}) {
  try {
    const artifact = await new GitPatchPreserver().preserve(input);
    return artifact ? [artifact] : [];
  } catch {
    return [];
  }
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function inspectCodexGoalAccount(input: {
  readonly authRootDir: string;
  readonly name: string;
  readonly stateRootDir?: string;
  readonly liveCheck?: boolean;
  readonly codexBinaryPath?: string;
  readonly liveCheckTimeoutMs?: number;
}
): Promise<CodexGoalAccountSlotStatus> {
  const authJsonPath = join(input.authRootDir, input.name, "auth.json");
  try {
    const authJsonBytes = await readFile(authJsonPath, "utf8");
    const validation = validateCodexAuthJsonBytes({ authJsonBytes });
    const freshness = readCodexAuthJsonFreshness({ authJsonBytes });
    const identity = sanitizedCodexIdentity(validation.parsed.tokens.id_token);
    const capacity = readAccountCapacity({
      accountName: input.name,
      ...(input.stateRootDir ? { stateRootDir: input.stateRootDir } : {}),
    });
    const live = input.liveCheck
      ? await inspectCodexAccountLiveStatus({
          codexHome: dirname(authJsonPath),
          ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
          ...(input.liveCheckTimeoutMs ? { timeoutMs: input.liveCheckTimeoutMs } : {}),
        })
      : undefined;
    const warnings = [...validation.warnings, ...freshness.warnings];
    if (live && !live.ok) {
      return {
        name: input.name,
        authJsonPath,
        status: "auth_invalid",
        byteLength: validation.byteLength,
        authJsonSha256Prefix: validation.exactBytesSha256.slice(0, 12),
        ...(identity ? { identitySource: identity.source } : {}),
        ...(identity ? { identityHashPrefix: identity.hashPrefix } : {}),
        ...(freshness.lastRefreshAt
          ? { lastRefreshAt: freshness.lastRefreshAt.toISOString() }
          : {}),
        ...(freshness.expiresAt
          ? { expiresAt: freshness.expiresAt.toISOString() }
          : {}),
        ...(capacity?.availability
          ? { capacityAvailability: capacity.availability }
          : {}),
        ...(capacity?.reason ? { capacityReason: capacity.reason } : {}),
        ...(capacity?.cooldownUntil
          ? { capacityCooldownUntil: capacity.cooldownUntil.toISOString() }
          : {}),
        ...(capacity?.lastLimitSignalAt
          ? { capacityLastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
          : {}),
        liveCheck: "failed",
        liveCheckSafeMessage: live.safeMessage,
        warnings,
        safeMessage: live.safeMessage,
      };
    }
    return {
      name: input.name,
      authJsonPath,
      status: "ready",
      byteLength: validation.byteLength,
      authJsonSha256Prefix: validation.exactBytesSha256.slice(0, 12),
      ...(identity ? { identitySource: identity.source } : {}),
      ...(identity ? { identityHashPrefix: identity.hashPrefix } : {}),
      ...(freshness.lastRefreshAt
        ? { lastRefreshAt: freshness.lastRefreshAt.toISOString() }
        : {}),
      ...(freshness.expiresAt
        ? { expiresAt: freshness.expiresAt.toISOString() }
        : {}),
      ...(capacity?.availability
        ? { capacityAvailability: capacity.availability }
        : {}),
      ...(capacity?.reason ? { capacityReason: capacity.reason } : {}),
      ...(capacity?.cooldownUntil
        ? { capacityCooldownUntil: capacity.cooldownUntil.toISOString() }
        : {}),
      ...(capacity?.lastLimitSignalAt
        ? { capacityLastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
        : {}),
      ...(live ? { liveCheck: "passed" as const } : {}),
      ...(live ? { liveCheckSafeMessage: live.safeMessage } : {}),
      warnings,
      safeMessage: warnings.length
        ? "auth.json is readable but has warnings"
        : "auth.json is readable",
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "auth_invalid";
    return {
      name: input.name,
      authJsonPath,
      status: safeMessage.includes("ENOENT") ? "auth_missing" : "auth_invalid",
      warnings: [],
      safeMessage: safeMessage.includes("ENOENT")
        ? "auth.json is missing"
        : safeMessage,
    };
  }
}

async function inspectCodexAccountLiveStatus(input: {
  readonly codexHome: string;
  readonly codexBinaryPath?: string;
  readonly timeoutMs?: number;
}): Promise<{ readonly ok: boolean; readonly safeMessage: string }> {
  const codexBinaryPath = input.codexBinaryPath ?? "codex";
  try {
    await execFileAsync(codexBinaryPath, ["login", "status"], {
      env: {
        ...process.env,
        CODEX_HOME: input.codexHome,
      },
      timeout: input.timeoutMs ?? 70_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, safeMessage: "codex login status passed" };
  } catch (error) {
    if (isExecTimeoutError(error)) {
      return { ok: false, safeMessage: "codex login status timed out" };
    }
    return { ok: false, safeMessage: "codex login status failed" };
  }
}

function isExecTimeoutError(error: unknown): boolean {
  return isRecord(error) &&
    (error.signal === "SIGTERM" || error.killed === true || error.code === "ETIMEDOUT");
}

function sanitizedCodexIdentity(idToken: string | undefined): {
  readonly source: string;
  readonly hashPrefix: string;
} | null {
  if (!idToken) return null;
  const claims = decodeJwtClaims(idToken);
  if (!claims) return null;
  const authClaims = isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"]
    : {};
  const candidates = [
    ["chatgpt_account_id", authClaims.chatgpt_account_id],
    ["chatgpt_user_id", authClaims.chatgpt_user_id],
    ["sub", claims.sub],
    ["email", claims.email],
  ] as const;
  for (const [source, value] of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    return {
      source,
      hashPrefix: hashText(`${source}:${value}`).slice(0, 16),
    };
  }
  return null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAccountCapacity(input: {
  readonly stateRootDir?: string;
  readonly accountName: string;
}) {
  if (!input.stateRootDir) return null;
  try {
    return new LocalFileWorkerAccountCapacityStore({
      rootDir: join(input.stateRootDir, "worker-account-capacity"),
    }).read({ accountId: input.accountName });
  } catch {
    return null;
  }
}

async function listAccountDirectories(authRootDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(authRootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function readCodexGoalResultSummary(path: string): Promise<{
  readonly status?: string;
  readonly reason?: string;
}> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(typeof parsed.reason === "string"
        ? { reason: redactStatusText(parsed.reason) }
        : {}),
    };
  } catch {
    return {};
  }
}

async function readCodexGoalProgressSummary(path: string): Promise<{
  readonly exists?: boolean;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly heartbeatAgeMs?: number;
  readonly pid?: number;
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
  readonly warning?: string;
}> {
  try {
    const [item, parsed] = await Promise.all([
      stat(path),
      readCodexGoalProgressFile(path),
    ]);
    const updatedAt = parsed.updatedAt ?? item.mtime.toISOString();
    const updatedAtMs = Date.parse(updatedAt);
    return {
      exists: item.isFile(),
      ...(parsed.status ? { status: parsed.status } : {}),
      updatedAt,
      ...(Number.isFinite(updatedAtMs)
        ? { heartbeatAgeMs: Date.now() - updatedAtMs }
        : {}),
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(parsed.resultStatus ? { resultStatus: parsed.resultStatus } : {}),
      ...(parsed.reason ? { reason: redactStatusText(parsed.reason) } : {}),
      ...(typeof parsed.attemptCount === "number"
        ? { attemptCount: parsed.attemptCount }
        : {}),
      ...(parsed.currentAccount ? { currentAccount: parsed.currentAccount } : {}),
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "progress_unreadable";
    return safeMessage.includes("ENOENT")
      ? { exists: false }
      : { exists: false, warning: `progress file is unreadable: ${safeMessage}` };
  }
}

async function readLastCodexGoalRuntimeEvent(path: string): Promise<{
  readonly event?: string;
  readonly timestamp?: string;
  readonly level?: string;
  readonly warning?: string;
}> {
  try {
    const text = await readFile(path, "utf8");
    const line = text.split(/\r?\n/).reverse().find((item) => item.trim());
    if (!line) return {};
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed.event === "string"
        ? { event: redactStatusText(parsed.event) }
        : {}),
      ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
      ...(typeof parsed.level === "string" ? { level: redactStatusText(parsed.level) } : {}),
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "runtime_event_unreadable";
    return safeMessage.includes("ENOENT")
      ? {}
      : { warning: `runtime event file is unreadable: ${safeMessage}` };
  }
}

async function readCodexGoalProgressFile(
  path: string,
): Promise<{
  readonly status?: string;
  readonly updatedAt?: string;
  readonly pid?: number;
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
}> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) return {};
  return {
    ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
    ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
    ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
    ...(typeof parsed.resultStatus === "string"
      ? { resultStatus: parsed.resultStatus }
      : {}),
    ...(typeof parsed.reason === "string"
      ? { reason: redactStatusText(parsed.reason) }
      : {}),
    ...(typeof parsed.attemptCount === "number"
      ? { attemptCount: parsed.attemptCount }
      : {}),
    ...(typeof parsed.currentAccount === "string"
      ? { currentAccount: parsed.currentAccount }
      : {}),
  };
}

async function gitWorkspaceStatus(path: string): Promise<{
  readonly dirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly warning?: string;
}> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "status",
      "--porcelain",
    ], { timeout: gitStatusTimeoutMs });
    const changedFiles = stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => statusPorcelainPath(line))
      .filter((path) => path.length > 0)
      .sort((left, right) => left.localeCompare(right));
    return {
      dirty: changedFiles.length > 0,
      changedFiles,
    };
  } catch {
    return {
      dirty: false,
      changedFiles: [],
      warning: `${path} is not a readable git worktree`,
    };
  }
}

function statusPorcelainPath(line: string): string {
  const path = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renameTarget = path.split(" -> ").at(-1);
  return renameTarget?.trim() ?? path;
}

async function logFileStatus(path: string): Promise<{
  readonly exists?: boolean;
  readonly updatedAt?: string;
  readonly byteLength?: number;
}> {
  try {
    const item = await stat(path);
    return {
      exists: item.isFile(),
      ...(item.isFile() ? { updatedAt: item.mtime.toISOString() } : {}),
      ...(item.isFile() ? { byteLength: item.size } : {}),
    };
  } catch {
    return { exists: false };
  }
}

async function inspectProcessSnapshot(
  pid: number,
): Promise<CodexGoalProcessSnapshot> {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-axo",
      "pid=,ppid=,%cpu=,command=",
    ], { timeout: 1_000 });
    const summary = summarizeCodexGoalProcessTree(
      pid,
      parseProcessSnapshotRows(stdout),
    );
    if (
      summary.alive !== undefined ||
      summary.cpuActive !== undefined ||
      summary.command !== undefined
    ) {
      return {
        ...(summary.alive === undefined ? {} : { alive: summary.alive }),
        ...(summary.cpuActive === undefined ? {} : { cpuActive: summary.cpuActive }),
        ...(summary.command === undefined ? {} : { command: redactStatusText(summary.command) }),
      };
    }
  } catch {
    // Fall back to direct pid inspection below.
  }
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "%cpu=",
      "-o",
      "command=",
    ], { timeout: 1_000 });
    const line = stdout.trim();
    if (!line) return {};
    const match = line.match(/^(\S+)\s+([\s\S]*)$/);
    const cpu = match ? Number(match[1]) : Number.NaN;
    const command = match?.[2]?.trim();
    return {
      alive: true,
      ...(Number.isFinite(cpu) ? { cpuActive: cpu > 0.1 } : {}),
      ...(command ? { command: redactStatusText(command) } : {}),
    };
  } catch {
    return {};
  }
}

export function summarizeCodexGoalProcessTree(
  rootPid: number,
  rows: readonly CodexGoalProcessSnapshotRow[],
): CodexGoalProcessSnapshot {
  const rowsByParent = new Map<number, CodexGoalProcessSnapshotRow[]>();
  for (const row of rows) {
    const group = rowsByParent.get(row.ppid) ?? [];
    group.push(row);
    rowsByParent.set(row.ppid, group);
  }
  const treeRows: CodexGoalProcessSnapshotRow[] = [];
  const queue = rows.filter((row) => row.pid === rootPid);
  const seen = new Set<number>();
  while (queue.length > 0) {
    const row = queue.shift();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    treeRows.push(row);
    queue.push(...(rowsByParent.get(row.pid) ?? []));
  }
  if (treeRows.length === 0) return {};
  const activeRows = treeRows.filter((row) => row.cpu > processCpuActiveThreshold);
  const totalCpu = treeRows.reduce((sum, row) => sum + row.cpu, 0);
  const commandRow = bestProcessCommandRow(activeRows.length > 0 ? activeRows : treeRows);
  return {
    alive: true,
    cpuActive: activeRows.length > 0 || totalCpu > processCpuActiveThreshold,
    ...(commandRow?.command ? { command: commandRow.command } : {}),
  };
}

function parseProcessSnapshotRows(
  stdout: string,
): readonly CodexGoalProcessSnapshotRow[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([0-9.]+)\s*([\s\S]*)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const cpu = Number(match[3]);
      if (
        !Number.isInteger(pid) ||
        !Number.isInteger(ppid) ||
        !Number.isFinite(cpu)
      ) {
        return null;
      }
      return {
        pid,
        ppid,
        cpu,
        command: match[4]?.trim() ?? "",
      };
    })
    .filter((row): row is CodexGoalProcessSnapshotRow => row !== null);
}

function bestProcessCommandRow(
  rows: readonly CodexGoalProcessSnapshotRow[],
): CodexGoalProcessSnapshotRow | undefined {
  return rows.slice().sort((left, right) => {
    const buildScore = Number(isBuildLikeProcessCommand(right.command)) -
      Number(isBuildLikeProcessCommand(left.command));
    if (buildScore !== 0) return buildScore;
    return right.cpu - left.cpu;
  })[0];
}

function isBuildLikeProcessCommand(command: string | undefined): boolean {
  return command === undefined ||
    /\b(build|test|check|lint|tsc|vite|vitest|jest|pytest|cargo|gradle|mvn)\b/i
      .test(command);
}

async function checkFile(
  name: string,
  path: string,
): Promise<CodexGoalDoctorCheck> {
  try {
    const item = await stat(path);
    return {
      name,
      ok: item.isFile(),
      message: item.isFile() ? path : `${path} is not a file`,
    };
  } catch {
    return { name, ok: false, message: `${path} is missing` };
  }
}

async function checkDirectory(
  name: string,
  path: string,
): Promise<CodexGoalDoctorCheck> {
  try {
    const item = await stat(path);
    return {
      name,
      ok: item.isDirectory(),
      message: item.isDirectory() ? path : `${path} is not a directory`,
    };
  } catch {
    return { name, ok: false, message: `${path} is missing` };
  }
}

async function checkGitWorkspace(path: string): Promise<CodexGoalDoctorCheck> {
  try {
    await execFileAsync(
      "git",
      ["-C", path, "rev-parse", "--is-inside-work-tree"],
      { timeout: gitStatusTimeoutMs },
    );
    return { name: "workspace", ok: true, message: path };
  } catch {
    return { name: "workspace", ok: false, message: `${path} is not a git worktree` };
  }
}

async function checkTmuxSessionAvailable(
  session: string,
): Promise<CodexGoalDoctorCheck> {
  const tmux = await inspectTmuxSession(session);
  if (tmux.warning) {
    return {
      name: "tmuxSession",
      ok: false,
      message: tmux.warning,
    };
  }
  const alive = tmux.alive;
  return {
    name: "tmuxSession",
    ok: !alive,
    message: alive
      ? `${session} is already alive`
      : `${session} is available`,
  };
}

async function resolveTmuxExecutable(): Promise<string> {
  const resolution = await resolveTmux();
  if (!resolution.found) {
    throw new Error(hostExecutableNotFoundMessage(resolution));
  }
  return resolution.executable;
}

async function resolveTmux() {
  return resolveHostExecutable({
    name: "tmux",
    envNames: [
      "SUBSCRIPTION_RUNTIME_TMUX_PATH",
      "TMUX_PATH",
      "TMUX_BIN",
    ],
    additionalCandidates: [
      "/opt/homebrew/bin/tmux",
      "/usr/local/bin/tmux",
      "/usr/bin/tmux",
      "/bin/tmux",
    ],
  });
}

async function inspectTmuxSession(
  session: string,
): Promise<{ readonly alive: boolean; readonly warning?: string }> {
  const resolution = await resolveTmux();
  if (!resolution.found) {
    return {
      alive: false,
      warning: hostExecutableNotFoundMessage(resolution),
    };
  }
  try {
    await execFileAsync(resolution.executable, ["has-session", "-t", session]);
    return { alive: true };
  } catch {
    return { alive: false };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function redactStatusText(value: string): string {
  return new DefaultRedactor().redact(value);
}

function pushOptional(
  args: string[],
  flagName: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  args.push(flagName, value);
}

function pushOptionalNumber(
  args: string[],
  flagName: string,
  value: number | undefined,
): void {
  if (value === undefined) return;
  args.push(flagName, String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
