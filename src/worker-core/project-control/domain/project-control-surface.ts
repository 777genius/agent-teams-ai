export type ProjectControlToolKind =
  | "create_worktree"
  | "create_job"
  | "start_worker"
  | "refill_worker"
  | "prepare_verifier"
  | "recover_operations"
  | "mark_reviewed"
  | "record_failed_no_output"
  | "open_integration_attempt"
  | "apply_worker_output"
  | "run_required_checks"
  | "commit_approved_changes"
  | "push_approved_commit";

export type ProjectControlToolGroup =
  | "worker_lifecycle"
  | "integration_lifecycle";

export type ProjectControlPolicyOwner = "controller";

export type ProjectControlRuntimeResponsibility =
  | "policy_gate"
  | "port_dispatch"
  | "audit";

export type ProjectControlToolCapability = {
  readonly tool: ProjectControlToolKind;
  readonly group: ProjectControlToolGroup;
  readonly requiredBoundary: "project_scoped_control";
  readonly policyOwner: ProjectControlPolicyOwner;
  readonly runtimeResponsibilities: readonly ProjectControlRuntimeResponsibility[];
  readonly writesSharedWorkspace: boolean;
};

export type ProjectControlSurface = {
  readonly schemaVersion: 1;
  readonly requiredBoundary: "project_scoped_control";
  readonly childWorkerDefaultMode: "edit_test_handoff";
  readonly policyOwner: ProjectControlPolicyOwner;
  readonly tools: readonly ProjectControlToolCapability[];
  readonly integrationSequence: readonly ProjectControlToolKind[];
};
