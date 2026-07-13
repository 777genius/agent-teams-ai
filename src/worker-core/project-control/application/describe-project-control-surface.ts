import type {
  ProjectControlSurface,
  ProjectControlToolCapability,
  ProjectControlToolKind,
} from "../domain/project-control-surface";

const workerLifecycleTools: readonly ProjectControlToolCapability[] = [
  capability("create_worktree", "worker_lifecycle", false),
  capability("create_job", "worker_lifecycle", false),
  capability("start_worker", "worker_lifecycle", false),
  capability("refill_worker", "worker_lifecycle", false),
  capability("prepare_verifier", "worker_lifecycle", false),
  capability("recover_operations", "worker_lifecycle", false),
  capability("mark_reviewed", "worker_lifecycle", false),
];

const integrationLifecycleTools: readonly ProjectControlToolCapability[] = [
  capability("open_integration_attempt", "integration_lifecycle", false),
  capability("apply_worker_output", "integration_lifecycle", true),
  capability("run_required_checks", "integration_lifecycle", false),
  capability("commit_approved_changes", "integration_lifecycle", true),
  capability("push_approved_commit", "integration_lifecycle", true),
];

export class DescribeProjectControlSurfaceUseCase {
  describe(): ProjectControlSurface {
    return {
      schemaVersion: 1,
      requiredBoundary: "project_scoped_control",
      childWorkerDefaultMode: "edit_test_handoff",
      policyOwner: "controller",
      tools: [
        ...workerLifecycleTools,
        ...integrationLifecycleTools,
      ],
      integrationSequence: [
        "open_integration_attempt",
        "apply_worker_output",
        "run_required_checks",
        "commit_approved_changes",
        "push_approved_commit",
      ],
    };
  }
}

export function describeProjectControlSurface(): ProjectControlSurface {
  return new DescribeProjectControlSurfaceUseCase().describe();
}

function capability(
  tool: ProjectControlToolKind,
  group: ProjectControlToolCapability["group"],
  writesSharedWorkspace: boolean,
): ProjectControlToolCapability {
  return {
    tool,
    group,
    requiredBoundary: "project_scoped_control",
    policyOwner: "controller",
    runtimeResponsibilities: [
      "policy_gate",
      "port_dispatch",
      "audit",
    ],
    writesSharedWorkspace,
  };
}
