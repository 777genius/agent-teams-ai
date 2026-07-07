import { AccessBoundary } from "../../access-control";
import {
  ControlledAgentToolGroup,
  ControlledAgentToolName,
  type ControlledAgentToolGrant,
  type ControlledAgentToolSurfacePolicy,
} from "../domain/controlled-agent";

export const projectScopedControllerToolGrants: readonly ControlledAgentToolGrant[] = [
  grant(ControlledAgentToolName.GoalOverview, ControlledAgentToolGroup.Diagnostics, "read"),
  grant(ControlledAgentToolName.GoalBrief, ControlledAgentToolGroup.Diagnostics, "read"),
  grant(ControlledAgentToolName.GoalStatus, ControlledAgentToolGroup.Diagnostics, "read"),
  grant(ControlledAgentToolName.GoalListJobs, ControlledAgentToolGroup.Diagnostics, "read"),
  grant(ControlledAgentToolName.GoalGetJob, ControlledAgentToolGroup.Diagnostics, "read"),
  grant(ControlledAgentToolName.ProjectEvents, ControlledAgentToolGroup.Diagnostics, "read"),
  grant(
    ControlledAgentToolName.ProjectOperationStatus,
    ControlledAgentToolGroup.Diagnostics,
    "read",
  ),
  grant(
    ControlledAgentToolName.ProjectControllerConsumeGuidance,
    ControlledAgentToolGroup.ControllerLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectCreateWorktree,
    ControlledAgentToolGroup.WorkerLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectCreateJob,
    ControlledAgentToolGroup.WorkerLifecycle,
    "write",
  ),
  grant(ControlledAgentToolName.ProjectStart, ControlledAgentToolGroup.WorkerLifecycle, "write"),
  grant(
    ControlledAgentToolName.ProjectRefillWorker,
    ControlledAgentToolGroup.WorkerLifecycle,
    "write",
  ),
  grant(ControlledAgentToolName.ProjectStop, ControlledAgentToolGroup.WorkerLifecycle, "write"),
  grant(
    ControlledAgentToolName.ProjectMarkReviewed,
    ControlledAgentToolGroup.WorkerLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectOpenIntegrationAttempt,
    ControlledAgentToolGroup.IntegrationLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectApplyWorkerOutput,
    ControlledAgentToolGroup.IntegrationLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectRunRequiredChecks,
    ControlledAgentToolGroup.IntegrationLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectCommitApprovedChanges,
    ControlledAgentToolGroup.IntegrationLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectPushApprovedCommit,
    ControlledAgentToolGroup.IntegrationLifecycle,
    "write",
  ),
  grant(
    ControlledAgentToolName.ProjectRejectIntegrationAttempt,
    ControlledAgentToolGroup.IntegrationLifecycle,
    "write",
  ),
];

export function projectScopedControllerToolSurfacePolicy(): ControlledAgentToolSurfacePolicy {
  return {
    boundary: AccessBoundary.ProjectScopedControl,
    allowedTools: projectScopedControllerToolGrants,
    deniedRawCapabilities: [
      "raw_shell",
      "raw_git",
      "raw_tmux",
      "direct_registry_write",
      "auth_root_read",
      "docker_socket",
      "nested_project_controller",
      "danger_full_access_child",
    ],
  };
}

export function projectScopedControllerToolNames(): readonly string[] {
  return projectScopedControllerToolGrants.map((tool) => tool.name);
}

function grant(
  name: ControlledAgentToolName,
  group: ControlledAgentToolGroup,
  sideEffect: ControlledAgentToolGrant["sideEffect"],
): ControlledAgentToolGrant {
  return { name, group, sideEffect };
}
