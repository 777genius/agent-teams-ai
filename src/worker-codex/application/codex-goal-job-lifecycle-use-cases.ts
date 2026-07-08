import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalStopTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
  prepareCodexGoalLaunchPaths,
  reconcileCodexGoalRuntimeResult,
  resolveCodexGoalWorkerLiveness,
  startCodexGoalTmux,
  stopCodexGoalTmux,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";
import { codexGoalProgressPath } from "../codex-goal-runner";
import { buildCodexGoalBrief } from "../codex-goal-mcp-brief";
import {
  isSafeStartAction,
  nextActionForStatus,
} from "./codex-goal-decision";
import {
  type CodexGoalJobIdInput,
  type CodexGoalJobLifecycleInput,
  type CodexGoalJobResultReconcileInput,
} from "./codex-goal-use-case-inputs";
import {
  writeCodexGoalMaintenancePauseEvent,
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "../codex-goal-mcp-lifecycle-markers";
import { codexGoalStateRootDir } from "../codex-goal-mcp-worker-control";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-status-input";
import {
  booleanValue,
  numberValue,
  stringValue,
} from "./codex-goal-input-values";
import {
  projectControlGenericScopeDenial,
  projectControlGenericToolDenial,
} from "../project-control-scope-guard";
import {
  stopDirectCodexGoalRun,
} from "./codex-goal-direct-run-stop-use-case";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedCodexGoalJobLaunch = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

export type CodexGoalMcpJobLifecycleDeps = {
  readonly loadJobLaunch: (args: CodexGoalJobIdInput) => Promise<LoadedCodexGoalJobLaunch>;
};

export async function continueStoredJobLifecycle(
  args: CodexGoalJobLifecycleInput,
  options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
  },
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: loaded.manifest.accessBoundary,
    projectAccessScope: loaded.manifest.projectAccessScope,
    jobId: loaded.manifest.jobId,
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.launch.config.workspacePath,
    requiredTool: "codex_goal_project_start",
  });
  if (projectControlDenial) return projectControlDenial;
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > (numberValue(args.staleAfterMs) ?? 10 * 60_000);
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  if (workerLiveness.alive) {
    return {
      ok: false,
      reason: "worker_already_running",
      jobId: loaded.manifest.jobId,
      status,
      workerSupervisorKind: workerLiveness.supervisorKind,
      workerAliveReason: workerLiveness.aliveReason,
    };
  }
  if (
    !isSafeStartAction(status.recommendedAction) &&
    !args.forceStart
  ) {
    return {
      ok: false,
      reason: "status_requires_review",
      jobId: loaded.manifest.jobId,
      status,
      next: nextActionForStatus(status.recommendedAction),
      requiredOverride: "forceStart",
    };
  }
  if (!args[options.confirmKey]) {
    return {
      ok: false,
      reason: `${options.confirmKey}_required`,
      jobId: loaded.manifest.jobId,
      status,
      tmuxCommand: loaded.launch.tmuxSession
        ? buildCodexGoalTmuxCommand(loaded.launch).preview
        : undefined,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
      next: nextActionForStatus(status.recommendedAction),
    };
  }
  if (!loaded.launch.tmuxSession) {
    return {
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
    };
  }
  if (!args.skipDoctor) {
    await prepareCodexGoalLaunchPaths(loaded.launch);
    const doctor = await doctorCodexGoal({
      config: loaded.launch.config,
      tmuxSession: loaded.launch.tmuxSession,
    });
    if (!doctor.ok) {
      return {
        ok: false,
        reason: "doctor_failed",
        jobId: loaded.manifest.jobId,
        doctor,
      };
    }
  }
  const resultReconciliation = shouldReconcileResultBeforeStart(status)
    ? await reconcileCodexGoalRuntimeResult({
        config: loaded.launch.config,
        status,
        preservePatch: true,
      })
    : undefined;
  const command = await startCodexGoalTmux(loaded.launch);
  return {
    ok: true,
    mode: options.mode,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    tmuxCommand: command.preview,
    statusBefore: status,
    ...(resultReconciliation === undefined ? {} : { resultReconciliation }),
  };
}

function shouldReconcileResultBeforeStart(
  status: Awaited<ReturnType<typeof collectCodexGoalStatus>>,
): boolean {
  if (
    status.progressStatus === "maintenance_paused" &&
    status.resultExists !== true &&
    !status.workspaceDirty &&
    (
      status.logExists !== true ||
      (status.logByteLength ?? 0) === 0
    )
  ) {
    return false;
  }
  if (status.resultExists === true) return true;
  if (status.workspaceDirty) return true;
  if (status.progressExists) return true;
  if (status.logExists && (status.logByteLength ?? 0) > 0) return true;
  return false;
}

export async function reconcileStoredJobRuntimeResultLifecycle(
  args: CodexGoalJobResultReconcileInput,
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (brief.workerAlive && !brief.silentStale && !brief.heartbeatOnlyNoOutput && !args.forceWrite) {
    return {
      ok: false,
      reason: "worker_alive",
      jobId: loaded.manifest.jobId,
      status,
      brief,
      requiredOverride: "forceWrite",
      safeMessage:
        "Worker still appears alive. Reconcile result only after stop/stale confirmation or with forceWrite.",
    };
  }
  const reconciliation = await reconcileCodexGoalRuntimeResult({
    config: loaded.launch.config,
    status,
    forceWrite: booleanValue(args.forceWrite) === true,
    preservePatch: args.preservePatch !== false,
    silentStale: brief.silentStale,
    heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
    ...(brief.silentStale
      ? { reason: "silent_stale_worker" }
      : brief.heartbeatOnlyNoOutput
      ? { reason: "heartbeat_only_no_output" }
      : {}),
  });
  return {
    ok: true,
    mode: "reconcile_result",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    status,
    brief,
    reconciliation,
  };
}

export async function stopStoredJobLifecycle(
  args: CodexGoalJobLifecycleInput,
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: loaded.manifest.accessBoundary,
    projectAccessScope: loaded.manifest.projectAccessScope,
    jobId: loaded.manifest.jobId,
    requiredTool: "codex_goal_project_stop",
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.launch.config.workspacePath,
    requiredTool: "codex_goal_project_stop",
  });
  if (projectControlDenial) return projectControlDenial;
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (!loaded.launch.tmuxSession) {
    return stopDirectCodexGoalRun({
      manifest: loaded.manifest,
      launch: loaded.launch,
      status,
      brief,
      confirmStop: Boolean(args.confirmStop),
    });
  }
  const stopCommand = buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession);
  if (!status.tmuxAlive) {
    return {
      ok: false,
      reason: "worker_not_running",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  if (!brief.silentStale && !brief.heartbeatOnlyNoOutput && !args.forceStop) {
    return {
      ok: false,
      reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      requiredOverride: "forceStop",
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  if (!args.confirmStop) {
    return {
      ok: false,
      reason: "confirm_stop_required",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  const command = await stopCodexGoalTmux(loaded.launch.tmuxSession);
  await writeCodexGoalStoppedProgress({
    progressPath: loaded.launch.config.progressPath ?? codexGoalProgressPath({
      jobRootDir: loaded.launch.config.jobRootDir,
      taskId: loaded.launch.config.taskId,
    }),
    taskId: loaded.launch.config.taskId,
    status: "stopped",
  });
  const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
  const stopEventPath = await writeCodexGoalStopEvent({
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    jobRootDir: loaded.launch.config.jobRootDir,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    forceStop: Boolean(args.forceStop),
    statusBefore: status,
    statusAfter,
    brief,
  });
  const resultReconciliation = await reconcileCodexGoalRuntimeResult({
    config: loaded.launch.config,
    status: statusAfter,
    reason: brief.silentStale
      ? "silent_stale_worker"
      : brief.heartbeatOnlyNoOutput
      ? "heartbeat_only_no_output"
      : "manual_force_stop",
    preservePatch: true,
    silentStale: brief.silentStale,
    heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
  });
  return {
    ok: true,
    mode: "stop",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    stopEventPath,
    statusBefore: status,
    statusAfter,
    brief,
    resultReconciliation,
    safeMessage:
      "Stopped the tmux worker session. Review workspace/log/result before continuing or recovery.",
  };
}

export async function maintenancePauseStoredJobLifecycle(
  args: CodexGoalJobLifecycleInput,
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: loaded.manifest.accessBoundary,
    projectAccessScope: loaded.manifest.projectAccessScope,
    jobId: loaded.manifest.jobId,
    requiredTool: "codex_goal_project_stop",
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    workspacePath: loaded.launch.config.workspacePath,
    requiredTool: "codex_goal_project_stop",
  });
  if (projectControlDenial) return projectControlDenial;
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (!loaded.launch.tmuxSession) {
    return {
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      status,
      brief,
    };
  }
  const stopCommand = buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession);
  if (!status.tmuxAlive) {
    return {
      ok: false,
      reason: status.progressStatus === "maintenance_paused"
        ? "already_maintenance_paused"
        : "worker_not_running",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  if (status.workspaceDirty && !args.forcePause) {
    return {
      ok: false,
      reason: "workspace_dirty_requires_force_pause",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      requiredOverride: "forcePause",
      stopCommand: stopCommand.preview,
      status,
      brief,
      safeMessage:
        "Workspace has uncommitted changes. Wait for a clean checkpoint or pass forcePause after manual review.",
    };
  }
  if (!args.confirmPause) {
    return {
      ok: false,
      reason: "confirm_pause_required",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  const command = await stopCodexGoalTmux(loaded.launch.tmuxSession);
  const pauseReason = stringValue(args.reason) ?? "planned_maintenance";
  await writeCodexGoalStoppedProgress({
    progressPath: loaded.launch.config.progressPath ?? codexGoalProgressPath({
      jobRootDir: loaded.launch.config.jobRootDir,
      taskId: loaded.launch.config.taskId,
    }),
    taskId: loaded.launch.config.taskId,
    status: "maintenance_paused",
    reason: pauseReason,
  });
  const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
  const maintenancePausePath = await writeCodexGoalMaintenancePauseEvent({
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    jobRootDir: loaded.launch.config.jobRootDir,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    reason: pauseReason,
    forcePause: Boolean(args.forcePause),
    statusBefore: status,
    statusAfter,
    brief,
  });
  return {
    ok: true,
    mode: "maintenance_pause",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    maintenancePausePath,
    statusBefore: status,
    statusAfter,
    brief,
    safeMessage:
      "Worker paused for planned maintenance. No failure result was reconciled; codex_goal_continue can resume after maintenance.",
  };
}
