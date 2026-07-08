import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  buildHandoffManifest,
  describeProjectControlSurface,
} from "@vioxen/subscription-runtime/worker-core";
import { isSafeStartAction } from "./codex-goal-start-policy";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  resolveCodexGoalWorkerLiveness,
  shellQuote,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";
import type { CodexGoalRunConfig } from "../codex-goal-runner";

type JsonObject = Readonly<Record<string, unknown>>;
type WorkerLivenessStatus = Parameters<typeof resolveCodexGoalWorkerLiveness>[0]["status"];

export { isSafeStartAction } from "./codex-goal-start-policy";

type CodexGoalStatusView = WorkerLivenessStatus & {
  readonly recommendedAction: string;
  readonly progressStatus?: string;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly resultExists?: boolean;
  readonly tmuxAlive?: boolean;
  readonly workspaceDirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly progressHeartbeatAgeMs?: number;
  readonly logUpdatedAt?: string;
  readonly lastRuntimeEvent?: string;
  readonly logExists?: boolean;
  readonly logByteLength?: number;
  readonly progressCpuActive?: boolean;
  readonly progressExists?: boolean;
};

type CodexGoalBriefView = {
  readonly workerAlive: boolean;
  readonly workerSupervisorKind?: unknown;
  readonly workerAliveReason?: unknown;
  readonly workerProcessAlive?: unknown;
  readonly workerFreshProgressAlive?: unknown;
  readonly activeWriterRisk?: unknown;
  readonly activeWriterRiskReasons?: unknown;
  readonly baseRevisionStatus?: unknown;
  readonly baseRevisionReasons?: unknown;
  readonly recommendedAction?: unknown;
  readonly lastProgressAt?: string | undefined;
  readonly lastProgressAgeMs?: number | undefined;
  readonly staleAfterMs?: number | undefined;
  readonly progressUpdatedAt?: string | undefined;
  readonly progressHeartbeatAgeMs?: number | undefined;
  readonly progressStatus?: string | undefined;
  readonly appServerProcessAlive?: boolean | undefined;
  readonly appServerProcessPid?: number | undefined;
  readonly logByteLength?: number | undefined;
  readonly silentStale: boolean;
  readonly heartbeatOnlyNoOutput: boolean;
  readonly runtimeEventsPath?: string | undefined;
  readonly lastRuntimeEvent?: string | undefined;
  readonly lastRuntimeEventAt?: string | undefined;
  readonly lastRuntimeEventLevel?: string | undefined;
  readonly statusView?: unknown;
  readonly baseRevision?: unknown;
  readonly configuredAccounts: readonly string[];
  readonly dedupedAccounts: readonly string[];
  readonly availableDedupedAccounts: readonly string[];
  readonly invalidAccounts: readonly string[];
  readonly hasAvailableAccount: boolean;
  readonly lifecycleMarkerTypes: readonly string[];
  readonly lifecycleMarkers: unknown;
  readonly safeToContinue: boolean;
  readonly nextBestTool?: unknown;
  readonly nextBestReason?: unknown;
  readonly nextBestCommand?: unknown;
  readonly needsHumanRelogin: boolean;
  readonly duplicateAccounts: readonly unknown[];
  readonly capacityBlockedAccounts: readonly unknown[];
  readonly handoffBaseCommit?: string | undefined;
  readonly handoffPatchPath?: string | undefined;
  readonly handoffSummaryPath?: string | undefined;
  readonly logExists?: boolean | undefined;
  readonly progressPath?: string | undefined;
  readonly progressExists?: boolean | undefined;
  readonly progressPid?: number | undefined;
  readonly recentCommands: readonly string[];
};

type CodexGoalAccountView = {
  readonly name: string;
  readonly status?: unknown;
  readonly availability?: unknown;
  readonly schedulerEligible?: unknown;
  readonly recommendedAction?: unknown;
  readonly limitResetAt?: unknown;
  readonly capacityAvailability?: unknown;
  readonly capacityReason?: unknown;
  readonly capacityCooldownUntil?: unknown;
  readonly identityHashPrefix?: unknown;
  readonly safeMessage?: unknown;
};

export function codexGoalBriefHealthStatus(input: {
  readonly status: CodexGoalStatusView;
  readonly workerAlive: boolean;
}): "running" | "stopped" | "completed" | "blocked" | "failed" | "unknown" {
  if (input.workerAlive && input.status.progressStatus === "running") {
    return "running";
  }
  if (
    input.status.resultStatus === "done" ||
    input.status.resultStatus === "completed"
  ) {
    return "completed";
  }
  if (
    input.status.resultStatus === "waiting_capacity" ||
    input.status.progressStatus === "blocked"
  ) {
    return "blocked";
  }
  if (input.workerAlive) return "running";
  if (
    input.status.resultStatus === "failed" ||
    input.status.resultStatus === "partial" ||
    input.status.resultStatus === "blocked" ||
    input.status.resultStatus === "aborted"
  ) {
    return "failed";
  }
  if (input.status.resultExists === false && input.status.tmuxAlive === false) {
    return "stopped";
  }
  return "unknown";
}

export function isHeartbeatOnlyNoOutputBrief(input: {
  readonly status: CodexGoalStatusView;
  readonly staleAfterMs: number;
}): boolean {
  const status = input.status;
  const heartbeatOnlyNoOutputAfterMs = Math.min(input.staleAfterMs, 2 * 60_000);
  const logUpdatedAgeMs = isoAgeMs(status.logUpdatedAt);
  const noOutputAgeMs = logUpdatedAgeMs ?? status.progressHeartbeatAgeMs;
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > input.staleAfterMs;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  const executorStartedOnlyNoOutput = Boolean(
    status.lastRuntimeEvent === "executor_started" &&
      status.resultExists === false &&
      (status.logExists === false || status.logByteLength === 0),
  );
  const noOutputIsNotUsefulProgress = status.progressCpuActive !== true ||
    executorStartedOnlyNoOutput;
  return Boolean(
    workerLiveness.alive &&
      status.progressExists &&
      status.progressStatus === "running" &&
      noOutputAgeMs !== undefined &&
      noOutputAgeMs >= heartbeatOnlyNoOutputAfterMs &&
      status.progressHeartbeatAgeMs !== undefined &&
      status.progressHeartbeatAgeMs <= input.staleAfterMs &&
      noOutputIsNotUsefulProgress &&
      status.resultExists === false &&
      (status.logExists === false || status.logByteLength === 0) &&
      status.workspaceDirty === false &&
      (status.changedFiles ?? []).length === 0,
  );
}

export function buildCodexGoalDecision(input: {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly status: CodexGoalStatusView;
  readonly accounts: readonly CodexGoalAccountView[];
  readonly brief: CodexGoalBriefView;
  readonly overview?: JsonObject;
}): JsonObject {
  const registryArgs = {
    registryRootDir: input.registryRootDir,
    jobId: input.manifest.jobId,
  };
  const workspaceConflict = findWorkspaceConflictForJob(
    input.overview,
    input.manifest.jobId,
  );
  const blockedBySingleWriter = workspaceConflict !== undefined;
  const safeToContinue = input.brief.safeToContinue && !blockedBySingleWriter;
  const blockers: JsonObject[] = [];
  const warnings: JsonObject[] = [];
  const evidence: JsonObject[] = [
    {
      code: "worker_state",
      workerAlive: Boolean(input.brief.workerAlive),
      workerSupervisorKind: input.brief.workerSupervisorKind,
      workerAliveReason: input.brief.workerAliveReason,
      workerProcessAlive: input.brief.workerProcessAlive,
      workerFreshProgressAlive: input.brief.workerFreshProgressAlive,
      activeWriterRisk: input.brief.activeWriterRisk,
      activeWriterRiskReasons: input.brief.activeWriterRiskReasons,
      baseRevisionStatus: input.brief.baseRevisionStatus,
      baseRevisionReasons: input.brief.baseRevisionReasons,
      recommendedAction: input.status.recommendedAction,
      resultStatus: input.status.resultStatus,
      resultReason: redactOptional(input.status.resultReason),
    },
    {
      code: "workspace_state",
      workspacePath: input.launch.config.workspacePath,
      workspaceDirty: input.status.workspaceDirty,
      changedFilesCount: (input.status.changedFiles ?? []).length,
    },
    {
      code: "progress_state",
      lastProgressAt: input.brief.lastProgressAt,
      lastProgressAgeMs: input.brief.lastProgressAgeMs,
      staleAfterMs: input.brief.staleAfterMs,
      progressUpdatedAt: input.brief.progressUpdatedAt,
      progressHeartbeatAgeMs: input.brief.progressHeartbeatAgeMs,
      progressStatus: input.brief.progressStatus,
      appServerProcessAlive: input.brief.appServerProcessAlive,
      appServerProcessPid: input.brief.appServerProcessPid,
      logByteLength: input.brief.logByteLength,
      silentStale: input.brief.silentStale,
      heartbeatOnlyNoOutput: input.brief.heartbeatOnlyNoOutput,
      runtimeEventsPath: input.brief.runtimeEventsPath,
      lastRuntimeEvent: input.brief.lastRuntimeEvent,
      lastRuntimeEventAt: input.brief.lastRuntimeEventAt,
      lastRuntimeEventLevel: input.brief.lastRuntimeEventLevel,
    },
    {
      code: "status_view",
      statusView: input.brief.statusView,
    },
    {
      code: "base_revision",
      baseRevision: input.brief.baseRevision,
    },
    {
      code: "account_state",
      configuredAccounts: input.brief.configuredAccounts,
      dedupedAccounts: input.brief.dedupedAccounts,
      availableDedupedAccounts: input.brief.availableDedupedAccounts,
      invalidAccounts: input.brief.invalidAccounts,
      hasAvailableAccount: input.brief.hasAvailableAccount,
    },
  ];
  if (input.brief.lifecycleMarkerTypes.length) {
    evidence.push({
      code: "lifecycle_markers",
      lifecycleMarkerTypes: input.brief.lifecycleMarkerTypes,
      lifecycleMarkers: input.brief.lifecycleMarkers,
    });
  }
  if (workspaceConflict) {
    blockers.push({
      code: "single_writer_workspace_conflict",
      severity: "critical",
      message:
        "Multiple stored jobs can write to the same workspace. Do not continue this job until one writer is selected.",
      conflict: workspaceConflict,
    });
  }
  if (input.brief.silentStale) {
    blockers.push({
      code: "silent_stale_worker",
      severity: "blocked",
      message:
        "The worker process appears alive but observable progress is stale. Inspect process, app-server, log and worktree before stopping or recovery.",
    });
  }
  if (input.brief.heartbeatOnlyNoOutput) {
    blockers.push({
      code: "heartbeat_only_no_output",
      severity: "blocked",
      message:
        "The worker heartbeat is fresh, but there is no result, log output or workspace change. Inspect process, app-server, log and worktree before stopping or recovery.",
    });
  }
  if (
    input.brief.lifecycleMarkerTypes.includes("stop_event") &&
    !input.status.resultExists &&
    !input.brief.workerAlive
  ) {
    blockers.push({
      code: "stopped_worker_requires_review",
      severity: "blocked",
      message:
        "The worker was explicitly stopped before producing a result. Review the stop reason and workspace before starting a replacement worker.",
    });
  }
  if (input.status.workspaceDirty && !input.brief.workerAlive) {
    blockers.push({
      code: "dirty_worktree_requires_review",
      severity: "blocked",
      message:
        "The workspace has uncommitted changes and no active worker. Review changes before starting another writer.",
      changedFiles: input.status.changedFiles ?? [],
    });
  }
  if (
    !input.brief.lifecycleMarkerTypes.includes("stop_event") &&
    !input.brief.hasAvailableAccount &&
    isSafeStartAction(input.status.recommendedAction)
  ) {
    blockers.push({
      code: "no_available_accounts",
      severity: "blocked",
      message:
        "The job is otherwise continuable, but no deduped account slot is currently available.",
      invalidAccounts: input.brief.invalidAccounts,
      capacityBlockedAccounts: input.brief.capacityBlockedAccounts,
    });
  }
  if (input.brief.needsHumanRelogin && input.brief.hasAvailableAccount) {
    warnings.push({
      code: "some_accounts_need_relogin",
      severity: "warning",
      message:
        "Some configured accounts are invalid, but at least one deduped account is still available.",
      invalidAccounts: input.brief.invalidAccounts,
    });
  }
  if (input.brief.duplicateAccounts.length) {
    warnings.push({
      code: "duplicate_account_identity",
      severity: "warning",
      message:
        "Multiple slots appear to share one account identity. Deduped availability is lower than configured slot count.",
      duplicateAccounts: input.brief.duplicateAccounts,
    });
  }
  const decision = codexGoalDecisionKind({
    blockedBySingleWriter,
    brief: input.brief,
    status: input.status,
    safeToContinue,
  });
  const severity = codexGoalDecisionSeverity(decision, blockers, warnings);
  const commands = codexGoalDecisionCommands({
    registryArgs,
    safeToContinue,
    silentStale: input.brief.silentStale,
    heartbeatOnlyNoOutput: input.brief.heartbeatOnlyNoOutput,
    hasInvalidAccounts: input.brief.invalidAccounts.length > 0,
  });
  return {
    action: decision,
    decision,
    severity,
    safeToContinue,
    safeToOperate: !blockedBySingleWriter,
    jobId: input.manifest.jobId,
    taskId: input.launch.config.taskId,
    workspacePath: input.launch.config.workspacePath,
    tmuxSession: input.launch.tmuxSession,
    controlSurface: codexGoalControlSurface(input.launch),
    nextBestTool: blockedBySingleWriter
      ? "manual_review"
      : input.brief.nextBestTool,
    nextBestReason: blockedBySingleWriter
      ? "single_writer_workspace_conflict"
      : input.brief.nextBestReason,
    nextBestCommand: blockedBySingleWriter
      ? "manual_review_single_writer_workspace_conflict"
      : safeToContinue
      ? commands.continue
      : input.brief.nextBestCommand,
    blockers,
    warnings,
    evidence,
    checklist: codexGoalDecisionChecklist({
      decision,
      commands,
      invalidAccounts: input.brief.invalidAccounts,
    }),
    commands,
    recentCommands: input.brief.recentCommands,
  };
}

function codexGoalDecisionKind(input: {
  readonly blockedBySingleWriter: boolean;
  readonly brief: CodexGoalBriefView;
  readonly status: CodexGoalStatusView;
  readonly safeToContinue: boolean;
}): string {
  if (input.blockedBySingleWriter) return "manual_review_single_writer_conflict";
  if (input.brief.silentStale) return "manual_review_silent_stale";
  if (input.brief.heartbeatOnlyNoOutput) return "manual_review_heartbeat_only_no_output";
  if (input.brief.workerAlive) return "wait_for_worker";
  if (input.status.recommendedAction === "review_completed") return "review_completed";
  if (
    input.brief.lifecycleMarkerTypes.includes("stop_event") &&
    !input.status.resultExists &&
    !input.brief.workerAlive
  ) {
    return "manual_review_stopped_worker";
  }
  if (!input.brief.hasAvailableAccount && isSafeStartAction(input.status.recommendedAction)) {
    return "fix_accounts";
  }
  if (input.safeToContinue) return "continue";
  if (input.status.workspaceDirty) return "manual_review_dirty_worktree";
  return "manual_review";
}

function codexGoalDecisionSeverity(
  decision: string,
  blockers: readonly JsonObject[],
  warnings: readonly JsonObject[],
): string {
  if (blockers.some((blocker) => blocker.severity === "critical")) return "critical";
  if (blockers.length) return "blocked";
  if (decision.startsWith("manual_review")) return "blocked";
  if (warnings.length) return "warning";
  return "info";
}

function codexGoalDecisionCommands(input: {
  readonly registryArgs: JsonObject;
  readonly safeToContinue: boolean;
  readonly silentStale: boolean;
  readonly heartbeatOnlyNoOutput: boolean;
  readonly hasInvalidAccounts: boolean;
}): JsonObject {
  return {
    overview: `codex_goal_overview(${JSON.stringify({
      registryRootDir: input.registryArgs.registryRootDir,
    })})`,
    decision: `codex_goal_decision(${JSON.stringify(input.registryArgs)})`,
    brief: `codex_goal_brief(${JSON.stringify(input.registryArgs)})`,
    handoff: `codex_goal_handoff(${JSON.stringify(input.registryArgs)})`,
    accounts: `codex_goal_accounts_status(${JSON.stringify(input.registryArgs)})`,
    ...(input.safeToContinue
      ? {
          continue:
            `codex_goal_continue(${JSON.stringify({ ...input.registryArgs, confirmContinue: true })})`,
        }
      : {}),
    ...(input.silentStale
      ? {
          stopAfterManualReview:
            `codex_goal_stop(${JSON.stringify({ ...input.registryArgs, confirmStop: true })})`,
        }
      : {}),
    ...(input.heartbeatOnlyNoOutput
      ? {
          stopAfterManualReview:
            `codex_goal_stop(${JSON.stringify({ ...input.registryArgs, confirmStop: true })})`,
        }
      : {}),
    ...(input.hasInvalidAccounts
      ? {
          reloginInstructions:
            `codex_goal_accounts_relogin_instructions(${JSON.stringify(input.registryArgs)})`,
        }
      : {}),
  };
}

function codexGoalDecisionChecklist(input: {
  readonly decision: string;
  readonly commands: JsonObject;
  readonly invalidAccounts: readonly string[];
}): readonly string[] {
  if (input.decision === "continue") {
    return [
      `Call ${String(input.commands.continue)}.`,
      "Monitor with codex_goal_brief and do not start another writer in the same worktree.",
    ];
  }
  if (input.decision === "wait_for_worker") {
    return [
      "Keep monitoring with codex_goal_brief.",
      "Do not start or recover another writer while the worker is alive and not silent-stale.",
    ];
  }
  if (input.decision === "fix_accounts") {
    return [
      `Call ${String(input.commands.accounts)}.`,
      input.invalidAccounts.length
        ? `Relogin invalid slots with ${String(input.commands.reloginInstructions)}.`
        : "Wait for account capacity cooldown or add a valid account slot.",
      "Re-run codex_goal_decision before continuing.",
    ];
  }
  if (input.decision === "manual_review_silent_stale") {
    return [
      "Inspect process tree, app-server, log tail and git status.",
      `If stale is confirmed, call ${String(input.commands.stopAfterManualReview)}.`,
      "After stop, re-run codex_goal_decision before continuing.",
    ];
  }
  if (input.decision === "manual_review_heartbeat_only_no_output") {
    return [
      "Inspect process tree, app-server, log tail and git status.",
      `If heartbeat-only no-output is confirmed, call ${String(input.commands.stopAfterManualReview)}.`,
      "After stop, re-run codex_goal_decision before continuing.",
    ];
  }
  if (input.decision === "manual_review_single_writer_conflict") {
    return [
      `Call ${String(input.commands.overview)}.`,
      "Choose exactly one writer job for the shared workspace.",
      "Do not continue any conflicted job until the conflict is resolved.",
    ];
  }
  if (input.decision === "review_completed") {
    return [
      "Review the result, workspace diff and project checks.",
      "If accepted, call codex_goal_mark_reviewed for this job.",
    ];
  }
  return [
    "Inspect brief, status, recent log tail and workspace diff manually.",
    "Do not continue until the blocking state is understood.",
  ];
}

interface CodexGoalControlSurface {
  readonly executionEngine: NonNullable<CodexGoalRunConfig["executionEngine"]>;
  readonly childWorkerSpawn: string;
  readonly hostAuthSurfaces: readonly string[];
  readonly guidance: string;
  readonly projectControlSurface: ReturnType<typeof describeProjectControlSurface>;
}

const DEFAULT_CODEX_GOAL_EXECUTION_ENGINE: NonNullable<CodexGoalRunConfig["executionEngine"]> = "app-server-goal";
const CODEX_GOAL_EXECUTION_ENGINES = new Set([
  "app-server",
  "app-server-goal",
  "packaged-exec",
  "plain-exec",
] satisfies readonly NonNullable<CodexGoalRunConfig["executionEngine"]>[]);

function codexGoalControlSurface(launch: CodexGoalLaunchInput): CodexGoalControlSurface {
  // Keep this default aligned with create/load launch config defaults above.
  const configuredExecutionEngine = launch.config.executionEngine;
  const executionEngine = isCodexGoalExecutionEngine(configuredExecutionEngine)
    ? configuredExecutionEngine
    : DEFAULT_CODEX_GOAL_EXECUTION_ENGINE;
  const appServerGoal = executionEngine === "app-server-goal";
  return {
    executionEngine,
    childWorkerSpawn: appServerGoal
      ? "host_control_surface_required"
      : "runtime_adapter_owned",
    hostAuthSurfaces: appServerGoal
      ? [
          "github_tokens_not_inherited",
          "codex_auth_root_host_owned",
        ]
      : ["provider_environment_policy_applies"],
    guidance: appServerGoal
      ? "Lane orchestrators running inside app-server-goal should not spawn child workers or depend on host GH/auth surfaces. Request child worker, continue, stop and account actions through host-side subscription-runtime MCP or CLI controls."
      : "Use the runtime adapter control surface for worker lifecycle and account actions.",
    projectControlSurface: describeProjectControlSurface(),
  };
}

function isCodexGoalExecutionEngine(
  value: unknown,
): value is NonNullable<CodexGoalRunConfig["executionEngine"]> {
  return typeof value === "string" &&
    CODEX_GOAL_EXECUTION_ENGINES.has(
      value as NonNullable<CodexGoalRunConfig["executionEngine"]>,
    );
}

function findWorkspaceConflictForJob(
  overview: JsonObject | undefined,
  jobId: string,
): JsonObject | undefined {
  const conflicts = Array.isArray(overview?.workspaceConflicts)
    ? overview.workspaceConflicts
    : [];
  return conflicts.find((conflict): conflict is JsonObject =>
    isRecord(conflict) &&
      Array.isArray(conflict.jobIds) &&
      conflict.jobIds.includes(jobId)
  );
}

function redactOptional(value: string | undefined): string | undefined {
  return value ? redactText(value) : undefined;
}

export function buildCodexGoalHandoff(input: {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly brief: CodexGoalBriefView;
  readonly status: CodexGoalStatusView;
  readonly accounts: readonly CodexGoalAccountView[];
  readonly includeCliFallback: boolean;
}): JsonObject {
  const registryArgs = {
    registryRootDir: input.registryRootDir,
    jobId: input.manifest.jobId,
  };
  const cliFallbackCommands = input.includeCliFallback
    ? [
        cliFallbackToolCommand("codex_goal_get_job", registryArgs),
        cliFallbackToolCommand("codex_goal_brief", registryArgs),
        cliFallbackToolCommand("codex_goal_accounts_status", registryArgs),
        cliFallbackToolCommand("codex_goal_continue", {
          ...registryArgs,
          confirmContinue: true,
        }),
        cliFallbackToolCommand("codex_goal_handoff", registryArgs),
      ]
    : [];
  const stopArgs = { ...registryArgs, confirmStop: true };
  const controlSurface = codexGoalControlSurface(input.launch);
  const reviewCommands = input.brief.silentStale
    ? [
        `codex_goal_stop(${JSON.stringify(stopArgs)})`,
        `subscription-runtime-codex-goal stop-job ${shellText(input.manifest.jobId)} --registry-root ${shellText(input.registryRootDir)} --confirm`,
      ]
    : [];
  const handoffContract = buildHandoffManifest({
    workerJobId: input.manifest.jobId,
    workspacePath: input.launch.config.workspacePath,
    createdAt: new Date().toISOString(),
    changedFiles: input.status.changedFiles ?? [],
    ...(input.brief.handoffBaseCommit === undefined
      ? {}
      : { baseCommit: input.brief.handoffBaseCommit }),
    ...(input.brief.handoffPatchPath === undefined
      ? {}
      : { patchPath: input.brief.handoffPatchPath }),
    ...(input.brief.handoffSummaryPath === undefined
      ? {}
      : { summaryPath: input.brief.handoffSummaryPath }),
    ...(input.status.workspaceDirty === undefined
      ? {}
      : { workspaceDirty: input.status.workspaceDirty }),
  });
  const mcpCommands = [
    `codex_goal_get_job(${JSON.stringify(registryArgs)})`,
    `codex_goal_brief(${JSON.stringify(registryArgs)})`,
    `codex_goal_accounts_status(${JSON.stringify(registryArgs)})`,
    input.brief.safeToContinue
      ? `codex_goal_continue(${JSON.stringify({ ...registryArgs, confirmContinue: true })})`
      : String(input.brief.nextBestCommand),
  ];
  const text = [
    `# Codex goal handoff: ${input.manifest.jobId}`,
    "",
    "Use subscription-runtime Codex goal controls. Native MCP is preferred; CLI fallback calls the same MCP server through the SDK.",
    "",
    "## Job",
    `- registryRootDir: ${input.registryRootDir}`,
    `- workspacePath: ${input.launch.config.workspacePath}`,
    `- jobRootDir: ${input.launch.config.jobRootDir}`,
    `- stateRootDir: ${codexGoalStateRootDir(input.launch)}`,
    `- taskId: ${input.launch.config.taskId}`,
    `- tmuxSession: ${input.launch.tmuxSession ?? ""}`,
    `- model: ${input.launch.config.model ?? ""}`,
    `- reasoningEffort: ${input.launch.config.reasoningEffort ?? ""}`,
    `- serviceTier: ${input.launch.config.serviceTier ?? ""}`,
    `- taskTimeoutMs: ${input.launch.config.taskTimeoutMs}`,
    `- maxAccountCycles: ${input.launch.config.maxAccountCycles}`,
    `- accounts: ${input.launch.config.accounts.map((account) => account.name).join(", ")}`,
    `- executionEngine: ${String(controlSurface.executionEngine)}`,
    "",
    "## Current State",
    `- worker: ${input.brief.workerAlive ? "alive" : "not running"}`,
    `- workerSupervisorKind: ${String(input.brief.workerSupervisorKind ?? "")}`,
    `- workerAliveReason: ${String(input.brief.workerAliveReason ?? "")}`,
    `- recommendedAction: ${input.status.recommendedAction}`,
    `- resultStatus: ${input.status.resultStatus ?? ""}`,
    `- resultReason: ${input.status.resultReason ?? ""}`,
    `- workspaceDirty: ${String(input.status.workspaceDirty)}`,
    `- changedFiles: ${(input.status.changedFiles ?? []).length}`,
    `- silentStale: ${String(input.brief.silentStale)}`,
    `- lastProgressAt: ${String(input.brief.lastProgressAt ?? "")}`,
    `- progressStatus: ${String(input.brief.progressStatus ?? "")}`,
    `- progressUpdatedAt: ${String(input.brief.progressUpdatedAt ?? "")}`,
    `- progressHeartbeatAgeMs: ${String(input.brief.progressHeartbeatAgeMs ?? "")}`,
    `- logByteLength: ${String(input.brief.logByteLength ?? "")}`,
    `- lifecycleMarkers: ${input.brief.lifecycleMarkerTypes.join(", ") || "none"}`,
    `- safeToContinue: ${String(input.brief.safeToContinue)}`,
    `- hasAvailableAccount: ${String(input.brief.hasAvailableAccount)}`,
    `- availableDedupedAccounts: ${input.brief.availableDedupedAccounts.join(", ")}`,
    `- invalidAccounts: ${input.brief.invalidAccounts.join(", ")}`,
    `- nextBestTool: ${String(input.brief.nextBestTool)}`,
    `- nextBestCommand: ${String(input.brief.nextBestCommand)}`,
    "",
    "## Native MCP",
    ...mcpCommands.map((command) => `- ${command}`),
    ...(reviewCommands.length
      ? [
          "",
          "## After Manual Review",
          ...reviewCommands.map((command) => `- ${command}`),
        ]
      : []),
    ...(cliFallbackCommands.length
      ? [
          "",
          "## CLI Fallback",
          ...cliFallbackCommands.map((command) => `- ${command}`),
        ]
      : []),
    "",
    "## Control Surface",
    `- childWorkerSpawn: ${String(controlSurface.childWorkerSpawn)}`,
    `- hostAuthSurfaces: ${controlSurface.hostAuthSurfaces.join(", ")}`,
    `- guidance: ${String(controlSurface.guidance)}`,
    "",
    "## Safety Rules",
    "- Do not run two writer workers in the same worktree.",
    "- Continue only when brief.safeToContinue is true.",
    "- If hasAvailableAccount is false, inspect accounts before continuing.",
    "- Dirty, provider output invalid, unknown runtime, test and benchmark failures require manual review.",
    "- Never print auth.json, access tokens, refresh tokens, id tokens or raw provider payloads.",
  ].join("\n");
  return {
    text,
    mcpCommands,
    reviewCommands,
    cliFallbackCommands,
    controlSurface,
    handoffContract,
    summary: {
      jobId: input.manifest.jobId,
      registryRootDir: input.registryRootDir,
      workspacePath: input.launch.config.workspacePath,
      taskId: input.launch.config.taskId,
      tmuxSession: input.launch.tmuxSession,
      recommendedAction: input.status.recommendedAction,
      resultStatus: input.status.resultStatus,
      resultReason: input.status.resultReason,
      workspaceDirty: input.status.workspaceDirty,
      changedFiles: input.status.changedFiles ?? [],
      handoffStatus: handoffContract.status,
      handoffIssues: handoffContract.issues,
      baseRevision: input.brief.baseRevision,
      silentStale: input.brief.silentStale,
      lastProgressAt: input.brief.lastProgressAt,
      lastProgressAgeMs: input.brief.lastProgressAgeMs,
      staleAfterMs: input.brief.staleAfterMs,
      logExists: input.brief.logExists,
      logByteLength: input.brief.logByteLength,
      progressPath: input.brief.progressPath,
      progressExists: input.brief.progressExists,
      progressStatus: input.brief.progressStatus,
      progressUpdatedAt: input.brief.progressUpdatedAt,
      progressHeartbeatAgeMs: input.brief.progressHeartbeatAgeMs,
      progressPid: input.brief.progressPid,
      appServerProcessAlive: input.brief.appServerProcessAlive,
      appServerProcessPid: input.brief.appServerProcessPid,
      lifecycleMarkers: input.brief.lifecycleMarkers,
      lifecycleMarkerTypes: input.brief.lifecycleMarkerTypes,
      safeToContinue: input.brief.safeToContinue,
      hasAvailableAccount: input.brief.hasAvailableAccount,
      availableDedupedAccounts: input.brief.availableDedupedAccounts,
      invalidAccounts: input.brief.invalidAccounts,
      nextBestTool: input.brief.nextBestTool,
      nextBestCommand: input.brief.nextBestCommand,
    },
    accounts: input.accounts.map((account) => ({
      name: account.name,
      status: account.status,
      availability: account.availability,
      schedulerEligible: account.schedulerEligible,
      recommendedAction: account.recommendedAction,
      limitResetAt: account.limitResetAt,
      capacityAvailability: account.capacityAvailability,
      capacityReason: account.capacityReason,
      capacityCooldownUntil: account.capacityCooldownUntil,
      identityHashPrefix: account.identityHashPrefix,
      safeMessage: account.safeMessage,
    })),
  };
}

export function latestIsoDate(values: readonly (string | undefined)[]): string | undefined {
  const latest = values
    .map((value) => value ? { value, time: Date.parse(value) } : undefined)
    .filter((value): value is { readonly value: string; readonly time: number } =>
      value !== undefined && Number.isFinite(value.time)
    )
    .sort((left, right) => right.time - left.time)[0];
  return latest?.value;
}

function isoAgeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Date.now() - time : undefined;
}

export function redactText(value: string): string {
  return new DefaultRedactor().redact(value);
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function cliFallbackToolCommand(tool: string, args: JsonObject): string {
  return `subscription-runtime-codex-goal tool ${tool} --args-json ${shellText(JSON.stringify(args))}`;
}

export function nextActionForStatus(action: string): JsonObject {
  if (action === "wait_for_worker") {
    return { tool: "codex_goal_brief", reason: "worker is already running" };
  }
  if (action === "start_worker") {
    return { tool: "codex_goal_continue", reason: "no result exists and workspace is clean" };
  }
  if (
    action === "continue_after_capacity" ||
    action === "continue_after_timeout" ||
    action === "continue_after_provider_output"
  ) {
    return { tool: "codex_goal_continue", reason: "safe continuation condition" };
  }
  if (action === "review_completed") {
    return { tool: "codex_goal_mark_reviewed", reason: "worker completed" };
  }
  if (action === "ask_user") {
    return {
      tool: "codex_goal_control_decision",
      reason: "worker is blocked waiting for operator or inbox input",
    };
  }
  return { tool: "manual_review", reason: "status requires inspection before continuing" };
}

export function nextBestCommand(input: {
  readonly jobId: string;
  readonly action: JsonObject;
  readonly status: CodexGoalStatusView;
  readonly launch: CodexGoalLaunchInput;
}): string {
  const tool = typeof input.action.tool === "string"
    ? input.action.tool
    : "manual_review";
  if (tool === "codex_goal_continue") {
    return `codex_goal_continue({ jobId: ${JSON.stringify(input.jobId)}, confirmContinue: true })`;
  }
  if (tool === "codex_goal_mark_reviewed") {
    return `codex_goal_mark_reviewed({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (tool === "codex_goal_brief") {
    return `codex_goal_brief({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (tool === "codex_goal_reconcile_result") {
    return `codex_goal_reconcile_result({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (tool === "codex_goal_control_decision") {
    return `codex_goal_control_decision({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (tool === "codex_goal_accounts_status") {
    return `codex_goal_accounts_status({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (
    tool === "manual_review" &&
    input.action.reason === "silent_stale_worker"
  ) {
    return "manual_review_silent_stale_worker";
  }
  if (input.status.workspaceDirty) {
    return "manual_review_dirty_worktree";
  }
  return "manual_review_status";
}

function codexGoalStateRootDir(launch: CodexGoalLaunchInput): string {
  return launch.config.stateRootDir ?? join(launch.config.jobRootDir, "state");
}

function shellText(value: string): string {
  return shellQuote(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
