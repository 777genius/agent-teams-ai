import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./codex-goal-project-pre-start-admission-types";
import { isAdmittedInputPatchCapacityContinuation } from "./codex-goal-project-admitted-input-patch-continuation";
import { isCleanPreStartAdmissionCapacityContinuation } from "./codex-goal-project-clean-capacity-continuation";

export type ProjectPreStartCapacityContinuationMode = Extract<
  ProjectPreStartAdmissionLaunchWorkspaceMode,
  "admitted_input_patch_continuation" | "clean_capacity_continuation"
>;

export function projectPreStartCapacityContinuationMode(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly reviewedOutputId?: string;
  readonly status: CodexGoalStatus;
}): ProjectPreStartCapacityContinuationMode | undefined {
  if (input.reviewedOutputId || !input.manifest.projectPreStartAdmission) {
    return undefined;
  }
  if (isAdmittedInputPatchCapacityContinuation(input.status)) {
    return "admitted_input_patch_continuation";
  }
  return isCleanPreStartAdmissionCapacityContinuation(input.status)
    ? "clean_capacity_continuation"
    : undefined;
}
