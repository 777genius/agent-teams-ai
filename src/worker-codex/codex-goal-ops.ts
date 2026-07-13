import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  AccessBoundary,
  actionForRuntimeState,
  classifyRuntimeRunState,
  type RunProgressClassification,
  type RuntimeRecommendedAction,
  type RuntimeResultEnvelope,
  type RuntimeResultStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createCodexGoalResultRecorder,
  GitPatchPreserver,
} from "./codex-goal-runtime-result-io";
import {
  codexGoalOutputPath,
  codexGoalProgressPath,
  codexGoalRuntimeEventsPath,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";
import { assertCodexGoalAccessLaunchAllowed } from "./codex-goal-access-plan";
import { readLocalGitHeadCommit } from "./codex-goal-git-revision";
import { refreshCompletedCodexGoalResultArtifacts } from "./codex-goal-terminal-result-refresh";
import { listCodexGoalAccountStatuses } from "./codex-goal-account-status";
import {
  doctorCodexGoal,
  inspectCodexGoalTmuxSession,
  resolveCodexGoalTmuxExecutable,
  tmuxCodexGoalStartFailedMessage,
} from "./codex-goal-doctor";
import { inspectCodexGoalProcessSnapshot } from "./codex-goal-process-snapshot";
import type { CodexGoalObservationContext } from "./application/codex-goal-observation-context";
import {
  isCodexGoalStoppedProgressStatus,
  resolveCodexGoalWorkerLiveness,
  stopCodexGoalDirectProcess,
} from "./application/codex-goal-process-liveness";
import * as goalResult from "./application/codex-goal-visible-result";
import {
  fileExists,
  gitWorkspaceStatus,
  logFileStatus,
  readCodexGoalProgressSummary,
  readCodexGoalResultSummary,
  readLastCodexGoalRuntimeEvent,
} from "./codex-goal-status-files";

export { listCodexGoalAccountStatuses };
export { doctorCodexGoal };
export { summarizeCodexGoalProcessTree } from "./codex-goal-process-snapshot";
export type {
  CodexGoalProcessSnapshot,
  CodexGoalProcessSnapshotRow,
} from "./codex-goal-process-snapshot";
export type {
  CodexGoalDoctorCheck,
  CodexGoalDoctorResult,
} from "./codex-goal-doctor";
export type {
  CodexGoalAccountSlotStatus,
  CodexGoalAccountStatus,
  CodexGoalAccountStatusInput,
} from "./codex-goal-account-status";
export {
  isCodexGoalStoppedProgressStatus,
  resolveCodexGoalWorkerLiveness,
  stopCodexGoalDirectProcess,
};
export type {
  CodexGoalDirectStopCommand,
  CodexGoalWorkerLiveness,
} from "./application/codex-goal-process-liveness";

const execFileAsync = promisify(execFile);

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
  readonly accessBoundary?: AccessBoundary;
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
  readonly workspaceExists?: boolean;
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
  readonly appServerProcessAlive?: boolean;
  readonly appServerProcessPid?: number;
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

export function buildCodexGoalNoTmuxCommand(input: CodexGoalLaunchInput): string {
  const config = input.config;
  assertCodexGoalAccessLaunchAllowed(config);
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
  pushOptional(args, "--codex-goal-objective", config.codexGoalObjective);
  pushOptional(args, "--output", config.outputPath);
  pushOptional(args, "--progress", config.progressPath);
  pushOptional(args, "--codex-binary", config.codexBinaryPath);
  pushOptional(args, "--model", config.model);
  pushOptional(args, "--effort", config.reasoningEffort);
  pushOptional(args, "--service-tier", config.serviceTier);
  pushOptional(args, "--execution-engine", config.executionEngine);
  pushOptionalNumber(args, "--timeout-ms", config.taskTimeoutMs);
  pushOptionalNumber(
    args,
    "--app-server-startup-timeout-ms",
    config.appServerStartupTimeoutMs,
  );
  pushOptionalNumber(args, "--progress-heartbeat-ms", config.progressHeartbeatMs);
  pushOptionalNumber(args, "--stale-lock-ms", config.staleLockMs);
  pushOptionalNumber(args, "--max-account-cycles", config.maxAccountCycles);
  pushOptional(args, "--edit-mode", config.editMode);
  pushOptional(args, "--provider-sandbox-mode", config.providerSandboxMode);
  pushOptional(args, "--access-boundary", config.accessBoundary);
  if (config.projectAccessScope) {
    args.push(
      "--project-access-scope-json",
      JSON.stringify(config.projectAccessScope),
    );
  }
  if (config.allowDangerFullAccess) args.push("--allow-danger-full-access");
  pushOptional(args, "--network-access", config.networkAccess);
  if (config.allowDuplicateAccountIdentities) args.push("--allow-duplicate-accounts");
  if (config.requireGitWorkspace === false) args.push("--no-require-git-workspace");
  if (config.prewarmOnStart) args.push("--prewarm");
  const envAssignments: string[] = [];
  const extraWritableRoots = config.projectAccessScope
    ? ""
    : process.env.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS?.trim();
  if (config.projectAccessScope) {
    envAssignments.push(
      "SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS=1",
      "SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS=",
    );
  }
  if (extraWritableRoots) {
    envAssignments.push(
      `SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS=${shellQuote(extraWritableRoots)}`,
    );
  }
  const brokeredProjectStart =
    process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START?.trim();
  if (brokeredProjectStart) {
    envAssignments.push(
      `SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START=${shellQuote(brokeredProjectStart)}`,
    );
  }
  const envPrefix = envAssignments.length ? `${envAssignments.join(" ")} ` : "";
  return `${envPrefix}${args.map(shellQuote).join(" ")}`;
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
  assertCodexGoalAccessLaunchAllowed(input.config);
  await prepareCodexGoalLaunchPaths(input);
  const command = buildCodexGoalTmuxCommand(input);
  const tmuxExecutable = await resolveCodexGoalTmuxExecutable();
  try {
    await execFileAsync(tmuxExecutable, command.args);
  } catch (error) {
    throw new Error(tmuxCodexGoalStartFailedMessage(error));
  }
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
  await execFileAsync(await resolveCodexGoalTmuxExecutable(), command.args);
  return command;
}

export async function collectCodexGoalStatus(
  input: CodexGoalStatusInput,
  observation?: CodexGoalObservationContext,
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
    const tmux = await inspectCodexGoalTmuxSession(input.tmuxSession);
    tmuxAlive = tmux.alive;
    if (!tmuxAlive) warnings.push("tmux session is not alive");
    if (tmux.warning) warnings.push(tmux.warning);
  }
  const workspace = input.workspacePath
    ? await (observation
      ? observation.workspaceStatus(input.workspacePath)
      : gitWorkspaceStatus(input.workspacePath))
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
    : await (observation
      ? observation.processSnapshot(progress.pid)
      : inspectCodexGoalProcessSnapshot(progress.pid));
  if (progress.warning) warnings.push(progress.warning);
  const currentAttemptWorkerAlive = goalResult.isCodexGoalAttemptProcess({
    alive: progressProcess.alive,
    command: progressProcess.supervisorCommand ?? progressProcess.command,
    taskId: input.taskId,
    progressPath,
  }) || tmuxAlive === true;
  const visibleResult = goalResult.resolveVisibleCodexGoalResult({
    exists: resultExists,
    ...result,
    updatedAt: resultFile.updatedAt,
    progress,
    workerAlive: currentAttemptWorkerAlive,
  });
  if (visibleResult.warning) warnings.push(visibleResult.warning);
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
  if (
    input.accessBoundary === AccessBoundary.ProjectScopedControl &&
    visibleResult.exists === false
  ) {
    warnings.push("project_scoped_control broker-only anchor; use project broker tools, not raw worker start");
  }
  if (lastRuntimeEvent.warning) warnings.push(lastRuntimeEvent.warning);
  return {
    ...(tmuxAlive === undefined ? {} : { tmuxAlive }),
    ...(resultPath === undefined ? {} : { resultPath }),
    ...(visibleResult.exists === undefined ? {} : { resultExists: visibleResult.exists }),
    ...(visibleResult.status === undefined ? {} : { resultStatus: visibleResult.status }),
    ...(visibleResult.reason === undefined ? {} : { resultReason: visibleResult.reason }),
    ...(visibleResult.updatedAt === undefined ? {} : { resultUpdatedAt: visibleResult.updatedAt }),
    ...(workspace.exists === undefined ? {} : { workspaceExists: workspace.exists }),
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
    ...(progressProcess.appServerAlive === undefined
      ? {}
      : { appServerProcessAlive: progressProcess.appServerAlive }),
    ...(progressProcess.appServerPid === undefined
      ? {}
      : { appServerProcessPid: progressProcess.appServerPid }),
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
      tmuxAlive: currentAttemptWorkerAlive,
      ...(visibleResult.status === undefined ? {} : { resultStatus: visibleResult.status }),
      ...(visibleResult.reason === undefined ? {} : { resultReason: visibleResult.reason }),
      ...(progress.status === undefined ? {} : { progressStatus: progress.status }),
      ...(input.accessBoundary === undefined
        ? {}
        : { accessBoundary: input.accessBoundary }),
      ...(workspace.exists === undefined
        ? {}
        : { workspaceExists: workspace.exists }),
      ...(workspace.dirty === undefined
        ? {}
        : { workspaceDirty: workspace.dirty }),
      ...(visibleResult.exists === undefined ? {} : { resultExists: visibleResult.exists }),
    }),
    warnings,
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
  if (input.forceWrite && existingStrictResult?.status === "done") {
    return await refreshCompletedCodexGoalResultArtifacts({
      config: input.config,
      outputPath,
      existingResult: existingStrictResult,
      changedFiles,
      preservePatch: input.preservePatch !== false,
    });
  }

  const nonStrictExistingResult = status.resultExists === true && !existingStrictResult;
  const progressStaleForReconcile = staleProgress(status);
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale: progressStaleForReconcile,
  });
  const noOutputAgeMs = ageMsFromIso(status.logUpdatedAt) ?? status.progressHeartbeatAgeMs;
  const heartbeatOnlyNoOutputForReconcile = Boolean(
    input.heartbeatOnlyNoOutput ||
      (status.resultExists === false &&
        changedFiles.length === 0 &&
        (status.logExists === false || status.logByteLength === 0) &&
        noOutputAgeMs !== undefined &&
        noOutputAgeMs > 10 * 60_000),
  );
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
    heartbeatOnlyNoOutput: heartbeatOnlyNoOutputForReconcile,
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
  const baseCommit = await readLocalGitHeadCommit(input.config.workspacePath);
  const nextAction = actionForRuntimeState({
    status: runtimeStatus,
    classification,
    reason,
    changedFilesCount: changedFiles.length,
  });
  const result = await createCodexGoalResultRecorder({ outputPath }).record({
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
      ...(heartbeatOnlyNoOutputForReconcile ? ["heartbeat_only_no_output"] : []),
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
      ...(baseCommit === undefined ? {} : { baseCommit }),
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

export async function tailCodexGoalLog(
  logPath: string,
  lines: number,
): Promise<string> {
  const text = await readFile(logPath, "utf8");
  return `${text.split(/\r?\n/).slice(-lines).join("\n")}\n`;
}

export function recommendCodexGoalAction(input: {
  readonly tmuxAlive?: boolean;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly progressStatus?: string;
  readonly workspaceExists?: boolean;
  readonly workspaceDirty?: boolean;
  readonly resultExists?: boolean;
  readonly accessBoundary?: AccessBoundary;
}): CodexGoalRecommendedAction {
  if (input.tmuxAlive) return "wait_for_worker";
  if (input.workspaceExists === false) return "inspect_failure";
  if (input.progressStatus === "maintenance_paused") return "start_worker";
  if (input.resultStatus === "done" || input.resultStatus === "completed") {
    return "review_completed";
  }
  if (input.resultStatus === "waiting_capacity") {
    return "continue_after_capacity";
  }
  if (
    input.accessBoundary === AccessBoundary.ProjectScopedControl &&
    !input.resultExists
  ) {
    return "check_log_or_result";
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

function ageMsFromIso(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Date.now() - time);
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
