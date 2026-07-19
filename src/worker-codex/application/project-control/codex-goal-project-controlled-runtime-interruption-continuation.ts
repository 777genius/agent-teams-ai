import type {
  WorkerControlSignalView,
  WorkerControlTarget,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import type { ControlledRuntimeInterruptionEvidence } from "../../codex-goal-runtime-control-evidence";

export function isAdmittedInputPatchControlledRuntimeInterruption(input: {
  readonly status: Pick<
    CodexGoalStatus,
    "workspaceDirty" | "resultExists" | "resultStatus" | "resultReason"
  >;
  readonly evidence: ControlledRuntimeInterruptionEvidence | undefined;
}): input is {
  readonly status: Pick<
    CodexGoalStatus,
    "workspaceDirty" | "resultExists" | "resultStatus" | "resultReason"
  >;
  readonly evidence: ControlledRuntimeInterruptionEvidence;
} {
  return (
    input.status.workspaceDirty === true &&
    input.status.resultExists === true &&
    input.status.resultStatus === "partial" &&
    input.status.resultReason === "runtime_interrupted" &&
    input.evidence !== undefined
  );
}

export function assertControlledRuntimeInterruptionSignal(input: {
  readonly evidence: ControlledRuntimeInterruptionEvidence;
  readonly target: WorkerControlTarget;
  readonly signals: readonly WorkerControlSignalView[];
}): void {
  if (input.signals.length !== 1) {
    throw new Error("project_control_runtime_interrupt_signal_count_mismatch");
  }
  const signal = input.signals[0]?.signal;
  if (!signal || signal.signalId !== input.evidence.signalId) {
    throw new Error("project_control_runtime_interrupt_signal_id_mismatch");
  }
  if (signal.deliveryMode !== "interrupt_then_continue") {
    throw new Error("project_control_runtime_interrupt_delivery_mismatch");
  }
  if (
    signal.target.jobId !== input.target.jobId ||
    signal.target.taskId !== input.target.taskId ||
    signal.target.workspaceId !== input.target.workspaceId
  ) {
    throw new Error("project_control_runtime_interrupt_target_mismatch");
  }
  if (signal.createdAt.getTime() > Date.parse(input.evidence.resultUpdatedAt)) {
    throw new Error("project_control_runtime_interrupt_timeline_mismatch");
  }
}
