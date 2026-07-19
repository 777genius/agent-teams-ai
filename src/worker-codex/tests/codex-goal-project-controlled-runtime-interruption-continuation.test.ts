import { describe, expect, it } from "vitest";
import type { WorkerControlSignalView } from "@vioxen/subscription-runtime/worker-core";
import {
  assertControlledRuntimeInterruptionSignal,
  isAdmittedInputPatchControlledRuntimeInterruption,
} from "../application/project-control/codex-goal-project-controlled-runtime-interruption-continuation";
import { isCapacityContinuationDecision } from "../application/project-control/codex-goal-project-pre-start-continuation";

describe("controlled runtime interruption signal", () => {
  const target = {
    jobId: "job-1",
    taskId: "task-1",
    workspaceId: "/workspace",
  } as const;
  const evidence = {
    signalId: "signal-1",
    resultUpdatedAt: "2026-07-19T04:10:48.657Z",
  } as const;

  it("requires the interruption result to remain visible in current status", () => {
    const status = {
      workspaceDirty: true,
      resultExists: true,
      resultStatus: "partial",
      resultReason: "runtime_interrupted",
    } as const;
    expect(
      isAdmittedInputPatchControlledRuntimeInterruption({ status, evidence }),
    ).toBe(true);
    expect(
      isAdmittedInputPatchControlledRuntimeInterruption({
        status: { ...status, resultExists: false },
        evidence,
      }),
    ).toBe(false);
    expect(
      isAdmittedInputPatchControlledRuntimeInterruption({
        status: { ...status, resultReason: "provider_failure" },
        evidence,
      }),
    ).toBe(false);
  });

  it("never authorizes supervisor reap for a controlled interruption", () => {
    expect(
      isCapacityContinuationDecision({
        kind: "controlled_runtime_interruption",
        workspaceMode: "admitted_input_patch_runtime_continuation",
        evidence,
      }),
    ).toBe(false);
    expect(
      isCapacityContinuationDecision({
        kind: "capacity",
        workspaceMode: "admitted_input_patch_continuation",
      }),
    ).toBe(true);
  });

  it("accepts the exact durable interrupt signal and rejects mismatches", () => {
    const view = signalView();
    expect(() =>
      assertControlledRuntimeInterruptionSignal({
        evidence,
        target,
        signals: [view],
      }),
    ).not.toThrow();
    expect(() =>
      assertControlledRuntimeInterruptionSignal({
        evidence,
        target,
        signals: [],
      }),
    ).toThrow("project_control_runtime_interrupt_signal_count_mismatch");
    expect(() =>
      assertControlledRuntimeInterruptionSignal({
        evidence,
        target,
        signals: [
          signalView({
            target: { ...target, workspaceId: "/different" },
          }),
        ],
      }),
    ).toThrow("project_control_runtime_interrupt_target_mismatch");
    expect(() =>
      assertControlledRuntimeInterruptionSignal({
        evidence,
        target,
        signals: [
          signalView({ createdAt: new Date("2026-07-19T04:10:49.000Z") }),
        ],
      }),
    ).toThrow("project_control_runtime_interrupt_timeline_mismatch");
  });

  function signalView(
    overrides: Partial<WorkerControlSignalView["signal"]> = {},
  ): WorkerControlSignalView {
    return {
      signal: {
        schemaVersion: 1,
        signalId: "signal-1",
        idempotencyKey: "idempotency-1",
        target,
        intent: "guidance",
        deliveryMode: "interrupt_then_continue",
        body: "continue",
        createdAt: new Date("2026-07-19T04:10:48.000Z"),
        createdBy: "orchestrator",
        priority: "high",
        supersedesSignalIds: [],
        metadata: {},
        ...overrides,
      },
      state: "pending",
      expired: false,
      deliverable: true,
    };
  }
});
