import {
  AccessBoundary,
  LaunchPlanStatus,
  NetworkAccessMode,
  type AccessDecisionReason,
  type CommandPolicy,
  type EnvironmentPolicy,
  type FilesystemPolicy,
  type ProjectAccessScope,
} from "../../access-control";
import type { WorkerRuntimeDemand } from "../../account-capacity";
import { RunEventProviderKind } from "../../run-provider-kind";

export enum ControlledAgentLaunchBlockReason {
  BoundaryRequired = "boundary_required",
  ProjectScopeRequired = "project_scope_required",
  ProviderCannotRestrictToolSurface = "provider_cannot_restrict_tool_surface",
  ProviderCannotDisableRawShell = "provider_cannot_disable_raw_shell",
  ProviderCannotEnforceFilesystemSandbox = "provider_cannot_enforce_filesystem_sandbox",
  ProviderCannotIsolateHome = "provider_cannot_isolate_home",
  ProviderCannotIsolateTemp = "provider_cannot_isolate_temp",
  ProviderCannotRestrictNetwork = "provider_cannot_restrict_network",
  AccessPlanBlocked = "access_plan_blocked",
  ToolSurfaceMismatch = "tool_surface_mismatch",
}

export enum ControlledAgentToolName {
  GoalOverview = "codex_goal_overview",
  GoalBrief = "codex_goal_brief",
  GoalStatus = "codex_goal_status",
  GoalListJobs = "codex_goal_list_jobs",
  GoalGetJob = "codex_goal_get_job",
  ProjectEvents = "codex_goal_project_events",
  ProjectOperationStatus = "codex_goal_project_operation_status",
  ProjectControllerConsumeGuidance = "codex_goal_project_controller_consume_guidance",
  ProjectCreateWorktree = "codex_goal_project_create_worktree",
  ProjectCreateJob = "codex_goal_project_create_job",
  ProjectStart = "codex_goal_project_start",
  ProjectRefillWorker = "codex_goal_project_refill_worker",
  ProjectStop = "codex_goal_project_stop",
  ProjectMarkReviewed = "codex_goal_project_mark_reviewed",
  ProjectOpenIntegrationAttempt = "codex_goal_project_open_integration_attempt",
  ProjectApplyWorkerOutput = "codex_goal_project_apply_worker_output",
  ProjectRunRequiredChecks = "codex_goal_project_run_required_checks",
  ProjectCommitApprovedChanges = "codex_goal_project_commit_approved_changes",
  ProjectPushApprovedCommit = "codex_goal_project_push_approved_commit",
  ProjectRejectIntegrationAttempt = "codex_goal_project_reject_integration_attempt",
}

export enum ControlledAgentToolGroup {
  Diagnostics = "diagnostics",
  ControllerLifecycle = "controller_lifecycle",
  WorkerLifecycle = "worker_lifecycle",
  IntegrationLifecycle = "integration_lifecycle",
}

export enum ControlledAgentRunStatus {
  Planned = "planned",
  Running = "running",
  Completed = "completed",
  Stopped = "stopped",
  Blocked = "blocked",
  Failed = "failed",
  Stale = "stale",
}

export function controlledAgentStatusAllowsLiveController(
  status: ControlledAgentRunStatus | undefined,
): boolean {
  return status === ControlledAgentRunStatus.Running;
}

export function isControlledAgentTerminalStatus(
  status: ControlledAgentRunStatus,
): boolean {
  return status === ControlledAgentRunStatus.Completed ||
    status === ControlledAgentRunStatus.Stopped ||
    status === ControlledAgentRunStatus.Blocked ||
    status === ControlledAgentRunStatus.Failed ||
    status === ControlledAgentRunStatus.Stale;
}

export enum ControlledAgentProcessOwnerKind {
  DurableMcp = "durable_mcp",
  HostSupervisor = "host_supervisor",
  Sdk = "sdk",
}

export type ControlledAgentProcessOwner = {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly kind: ControlledAgentProcessOwnerKind;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly runtimeVersion?: string;
  readonly runtimeSha?: string;
};

export enum ControlledAgentEventType {
  SessionCreated = "controlled_agent.session.created",
  RunStarted = "controlled_agent.run.started",
  RunStatusObserved = "controlled_agent.run.status_observed",
  RunStopped = "controlled_agent.run.stopped",
  RunReconciled = "controlled_agent.run.reconciled",
  RunBlocked = "controlled_agent.run.blocked",
}

export type ControlledAgentToolGrant = {
  readonly name: ControlledAgentToolName;
  readonly group: ControlledAgentToolGroup;
  readonly sideEffect: "read" | "write";
};

export type ControlledAgentToolSurfacePolicy = {
  readonly boundary: AccessBoundary.ProjectScopedControl;
  readonly allowedTools: readonly ControlledAgentToolGrant[];
  readonly deniedRawCapabilities: readonly string[];
};

export type ControlledAgentProviderEnforcementCapabilities = {
  readonly providerKind: RunEventProviderKind.Codex | RunEventProviderKind.Claude;
  readonly canRestrictToolSurface: boolean;
  readonly canDisableRawShell: boolean;
  readonly canEnforceFilesystemSandbox: boolean;
  readonly canIsolateHome: boolean;
  readonly canIsolateTemp: boolean;
  readonly canRestrictNetwork: boolean;
};

export type ControlledAgentIdentity = {
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly providerKind: RunEventProviderKind.Codex | RunEventProviderKind.Claude;
};

export type ControlledAgentSession = {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly identity: ControlledAgentIdentity;
  readonly stateDir: string;
  readonly status: ControlledAgentRunStatus;
  readonly activeRunId?: string;
  readonly owner?: ControlledAgentProcessOwner;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly toolSurface: ControlledAgentToolSurfacePolicy;
};

export type ControlledAgentRun = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly controllerJobId: string;
  readonly providerKind: RunEventProviderKind.Codex | RunEventProviderKind.Claude;
  readonly status: ControlledAgentRunStatus;
  readonly providerRunId?: string;
  readonly owner?: ControlledAgentProcessOwner;
  readonly capacityAccountId?: string;
  readonly capacityDemand?: WorkerRuntimeDemand;
  readonly safeMessage?: string;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly updatedAt: string;
};

export type ControlledAgentEvent = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly controllerJobId: string;
  readonly type: ControlledAgentEventType;
  readonly occurredAt: string;
  readonly payload: Record<string, string | number | boolean | null>;
};

export type ControlledAgentLaunchPlanInput = {
  readonly controllerJobId: string;
  readonly sessionId: string;
  readonly stateDir: string;
  readonly boundary: AccessBoundary;
  readonly projectAccessScope?: ProjectAccessScope;
  readonly provider: ControlledAgentProviderEnforcementCapabilities;
  readonly networkAccess?: NetworkAccessMode.Disabled | NetworkAccessMode.Restricted;
  readonly now?: Date;
};

export type ControlledAgentLaunchPlan =
  | {
      readonly status: LaunchPlanStatus.Ready;
      readonly session: ControlledAgentSession;
      readonly filesystemPolicy: FilesystemPolicy;
      readonly environmentPolicy: EnvironmentPolicy;
      readonly networkPolicy: { readonly mode: NetworkAccessMode };
      readonly commandPolicy: CommandPolicy;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: LaunchPlanStatus.Blocked;
      readonly controllerJobId: string;
      readonly boundary: AccessBoundary;
      readonly reason: ControlledAgentLaunchBlockReason;
      readonly accessReason?: AccessDecisionReason;
      readonly evidence: readonly string[];
    };
