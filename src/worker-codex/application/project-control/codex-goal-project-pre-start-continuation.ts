import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import type { ControlledRuntimeInterruptionEvidence } from "../../codex-goal-runtime-control-evidence";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./codex-goal-project-pre-start-admission-types";
import { projectPreStartCapacityContinuationMode } from "./codex-goal-project-capacity-continuation";
import { isAdmittedInputPatchControlledRuntimeInterruption } from "./codex-goal-project-controlled-runtime-interruption-continuation";

type ContinuationWorkspaceMode = Extract<
  ProjectPreStartAdmissionLaunchWorkspaceMode,
  "admitted_input_patch_continuation" | "clean_capacity_continuation"
>;

export type ProjectPreStartContinuationDecision =
  | {
      readonly kind: "capacity";
      readonly workspaceMode: ContinuationWorkspaceMode;
    }
  | {
      readonly kind: "controlled_runtime_interruption";
      readonly workspaceMode: "admitted_input_patch_continuation";
      readonly evidence: ControlledRuntimeInterruptionEvidence;
    };

export function isCapacityContinuationDecision(
  decision: ProjectPreStartContinuationDecision | undefined,
): decision is Extract<
  ProjectPreStartContinuationDecision,
  { kind: "capacity" }
> {
  return decision?.kind === "capacity";
}

/** Runtime facts only. The caller still owns force-start orchestration policy. */
export function projectPreStartContinuationDecision(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly reviewedOutputId?: string;
  readonly status: CodexGoalStatus;
  readonly controlledInterruptionEvidence?: ControlledRuntimeInterruptionEvidence;
}): ProjectPreStartContinuationDecision | undefined {
  const capacityMode = projectPreStartCapacityContinuationMode(input);
  if (capacityMode) {
    return { kind: "capacity", workspaceMode: capacityMode };
  }
  const controlledInterruption = {
    status: input.status,
    evidence: input.controlledInterruptionEvidence,
  };
  if (
    input.reviewedOutputId ||
    !input.manifest.projectPreStartAdmission ||
    !isAdmittedInputPatchControlledRuntimeInterruption(controlledInterruption)
  ) {
    return undefined;
  }
  return {
    kind: "controlled_runtime_interruption",
    workspaceMode: "admitted_input_patch_continuation",
    evidence: controlledInterruption.evidence,
  };
}
