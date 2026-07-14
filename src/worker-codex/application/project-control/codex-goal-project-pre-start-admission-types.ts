export type ProjectPreStartAdmissionDirtyContinuationMode =
  | "reviewed_dirty_continuation"
  | "terminal_handoff_dependency_recovery";

export type ProjectPreStartAdmissionLaunchWorkspaceMode =
  | "clean_first_launch"
  | "clean_capacity_continuation"
  | "admitted_input_patch"
  | "admitted_input_patch_continuation"
  | ProjectPreStartAdmissionDirtyContinuationMode;
