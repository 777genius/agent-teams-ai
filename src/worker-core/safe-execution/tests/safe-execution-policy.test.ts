import { describe, expect, it } from "vitest";

import { SubscriptionWorkerError } from "../../errors";
import {
  defaultSafeExecutionErrorClassifier,
  normalizeSafeExecutionPolicy,
  safeExecutionFinalStatusForFailure,
  safeExecutionWaitingStatusForBlockedFailure,
  safeExecutionWaitingStatusForFailure,
  shouldContinueSafeExecutionAfterFailure,
  shouldDeliverSafeExecutionControlForContinuation,
  shouldReplaceSafeExecutionWorkspaceLock,
  type SafeExecutionFailureClassification,
} from "../index";

const unknownFailure: SafeExecutionFailureClassification = {
  reason: "unknown_error",
  safeMessage: "Worker failed.",
  retryable: true,
};

describe("safe execution policy decisions", () => {
  it("normalizes retry defaults and lets run input override continuation mode", () => {
    expect(normalizeSafeExecutionPolicy({})).toEqual({
      retryOnCapacity: true,
      retryOnAccountUnavailable: true,
      retryOnReconnectRequired: true,
      retryUnknownCleanWorkspace: true,
      retryUnknownChangedWorkspace: false,
      maxAttempts: 1,
      continuationMode: "packet_first",
    });

    expect(normalizeSafeExecutionPolicy({
      continuationMode: "disabled",
      policy: {
        continuationMode: "packet_first",
        maxAttempts: 0,
        retryUnknownChangedWorkspace: true,
      },
    })).toMatchObject({
      continuationMode: "disabled",
      maxAttempts: 1,
      retryUnknownChangedWorkspace: true,
    });
  });

  it("preserves stopped retry safe messages for policy denials", () => {
    const policy = normalizeSafeExecutionPolicy({ policy: { maxAttempts: 2 } });

    expect(shouldContinueSafeExecutionAfterFailure({
      classification: unknownFailure,
      policy,
      effectMode: "workspace_patch",
      workspaceChanged: false,
      attemptsRemaining: false,
    })).toEqual({
      allowed: false,
      safeMessage: "Safe execution has no attempts remaining.",
    });

    expect(shouldContinueSafeExecutionAfterFailure({
      classification: unknownFailure,
      policy: normalizeSafeExecutionPolicy({
        policy: { continuationMode: "disabled", maxAttempts: 2 },
      }),
      effectMode: "workspace_patch",
      workspaceChanged: false,
      attemptsRemaining: true,
    })).toEqual({
      allowed: false,
      safeMessage: "Safe execution continuation is disabled.",
    });

    expect(shouldContinueSafeExecutionAfterFailure({
      classification: unknownFailure,
      policy,
      effectMode: "external_side_effects",
      workspaceChanged: false,
      attemptsRemaining: true,
    })).toEqual({
      allowed: false,
      safeMessage: "Safe execution will not retry external side effects.",
    });

    expect(shouldContinueSafeExecutionAfterFailure({
      classification: unknownFailure,
      policy,
      effectMode: "workspace_patch",
      workspaceChanged: true,
      attemptsRemaining: true,
    })).toEqual({
      allowed: false,
      safeMessage: "Safe execution stopped after an unknown error changed the workspace.",
    });

    expect(shouldContinueSafeExecutionAfterFailure({
      classification: {
        reason: "provider_output_invalid",
        safeMessage: "Provider output invalid.",
        retryable: true,
      },
      policy,
      effectMode: "workspace_patch",
      workspaceChanged: true,
      attemptsRemaining: true,
    })).toEqual({
      allowed: false,
      safeMessage:
        "Safe execution stopped after provider_output_invalid changed the workspace.",
    });
  });

  it("keeps waiting and final task status mapping stable", () => {
    expect(safeExecutionWaitingStatusForFailure("capacity_unavailable")).toBe(
      "waiting_capacity",
    );
    expect(safeExecutionWaitingStatusForBlockedFailure({
      reason: "capacity_unavailable",
      workspaceChanged: true,
    })).toBeNull();
    expect(safeExecutionFinalStatusForFailure("user_abort")).toBe("aborted");
    expect(safeExecutionFinalStatusForFailure("provider_output_invalid")).toBe(
      "failed",
    );
    expect(safeExecutionFinalStatusForFailure("model_unavailable")).toBe(
      "failed",
    );
    expect(safeExecutionWaitingStatusForFailure("model_unavailable")).toBe(
      "waiting_capacity",
    );
    expect(safeExecutionFinalStatusForFailure("quota_limited")).toBe("partial");
  });

  it("delivers guidance while rotating an unavailable account", () => {
    expect(shouldDeliverSafeExecutionControlForContinuation("unknown_error"))
      .toBe(true);
    expect(shouldDeliverSafeExecutionControlForContinuation("account_unavailable"))
      .toBe(true);
    expect(shouldDeliverSafeExecutionControlForContinuation("model_unavailable"))
      .toBe(false);
    expect(shouldDeliverSafeExecutionControlForContinuation("reconnect_required"))
      .toBe(false);
  });

  it("replaces dead-owner workspace locks and keeps live or ownerless locks", () => {
    const acquiredAt = new Date("2026-01-01T00:00:00.000Z");
    const beforeStale = new Date("2026-01-01T00:00:09.000Z");
    const afterStale = new Date("2026-01-01T00:00:11.000Z");

    expect(shouldReplaceSafeExecutionWorkspaceLock({
      acquiredAt,
      now: beforeStale,
      ownerPid: 123,
      ownerProcessAlive: false,
    })).toBe(true);

    expect(shouldReplaceSafeExecutionWorkspaceLock({
      acquiredAt,
      now: afterStale,
      ownerPid: 123,
      ownerProcessAlive: true,
      staleLockMs: 10_000,
    })).toBe(false);

    expect(shouldReplaceSafeExecutionWorkspaceLock({
      acquiredAt,
      now: beforeStale,
      ownerPid: 123,
      ownerProcessAlive: false,
      staleLockMs: 10_000,
    })).toBe(true);

    expect(shouldReplaceSafeExecutionWorkspaceLock({
      acquiredAt,
      now: afterStale,
      staleLockMs: 10_000,
    })).toBe(false);
  });

  it("classifies backend and auth failures with stable safe messages", () => {
    const backendFailure = Object.assign(
      new Error("node_process_runner_failed:1:codex_app_server_goal_blocked"),
      {
        exitCode: 1,
        stdout: "",
        stderr: "codex_app_server_goal_blocked",
      },
    );

    expect(defaultSafeExecutionErrorClassifier(backendFailure)).toMatchObject({
      reason: "capacity_unavailable",
      safeMessage: "Codex app-server goal backend is temporarily blocked.",
      retryable: true,
    });

    const authFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Provider auth failed.",
      { details: { code: "provider_session_invalid" } },
    );

    expect(defaultSafeExecutionErrorClassifier(authFailure)).toEqual({
      reason: "account_unavailable",
      safeMessage: "Provider auth failed.",
      retryable: true,
    });

    const modelFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      'Codex model "gpt-5.6" is unavailable.',
      {
        details: {
          code: "model_unavailable",
          availableModels: "gpt-5.6-sol,gpt-5.5",
        },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(modelFailure)).toMatchObject({
      reason: "model_unavailable",
      safeMessage: 'Codex model "gpt-5.6" is unavailable.',
      retryable: true,
      details: { availableModels: "gpt-5.6-sol,gpt-5.5" },
    });
  });
});
