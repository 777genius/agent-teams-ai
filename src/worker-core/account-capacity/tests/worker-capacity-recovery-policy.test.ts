import { describe, expect, it } from "vitest";

import {
  assessWorkerCapacityRecovery,
  nextWorkerCapacityRecoveryAt,
  normalizeWorkerCapacitySnapshot,
  workerCapacityUnavailableDetails,
  type WorkerCapacityRecoveryDecision,
  type WorkerCapacityRecoverySnapshot,
} from "../domain";

describe("worker capacity recovery policy", () => {
  it("defers unavailable decisions when resettable capacity has a recovery time", () => {
    const recoveryAt = new Date("2026-06-01T01:00:00.000Z");
    const snapshots = [
      slot({
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: recoveryAt,
      }),
      slot({ availability: "disabled", reason: "auth_invalid" }),
    ];

    expect(workerCapacityUnavailableDetails(snapshots)).toBeNull();
    expect(assessWorkerCapacityRecovery(snapshots)).toEqual({
      kind: "defer",
    });
    expect(nextWorkerCapacityRecoveryAt(snapshots)).toBe(recoveryAt.getTime());
  });

  it("builds stable unavailable details with auth recovery hints", () => {
    expect(
      workerCapacityUnavailableDetails([
        slot({ availability: "disabled", reason: "auth_invalid" }),
        slot({ availability: "quota_exhausted", reason: "quota_limited" }),
      ]),
    ).toMatchObject({
      availability: "disabled:1,quota_exhausted:1",
      reasons: "auth_invalid:1,quota_limited:1",
      recoveryHint: expect.stringContaining("auth-stale"),
    });
  });

  it("treats provider session invalid signals as auth blocked", () => {
    const decision = assessWorkerCapacityRecovery([
      slot({
        availability: "disabled",
        reason: "provider_session_invalid",
      }),
    ]);

    expect(unavailableDetails(decision)).toMatchObject({
      availability: "disabled:1",
      reasons: "provider_session_invalid:1",
      recoveryHint: expect.stringContaining("sync the per-account auth root"),
    });
  });

  it("recognizes provider session invalid details codes", () => {
    const decision = assessWorkerCapacityRecovery([
      slot({
        availability: "disabled",
        details: { code: "provider_session_invalid" },
      }),
    ]);

    expect(unavailableDetails(decision)).toMatchObject({
      availability: "disabled:1",
      reasons: "provider_session_invalid:1",
      recoveryHint: expect.stringContaining("sync the per-account auth root"),
    });
  });

  it("normalizes expired resettable capacity while preserving safe details", () => {
    const normalized = normalizeWorkerCapacitySnapshot(
      {
        availability: "cooldown",
        reason: "rate_limit_threshold",
        cooldownUntil: new Date("2026-06-01T00:00:00.000Z"),
        lastLimitSignalAt: new Date("2026-05-31T23:59:00.000Z"),
        details: { accountId: "account-a" },
      },
      new Date("2026-06-01T00:00:00.001Z"),
    );

    expect(normalized).toEqual({
      availability: "available",
      details: { accountId: "account-a" },
    });
  });
});

function unavailableDetails(
  decision: WorkerCapacityRecoveryDecision,
): Readonly<Record<string, string>> {
  if (decision.kind !== "unavailable") {
    throw new Error("expected unavailable recovery decision");
  }
  return decision.details;
}

function slot(
  capacity: WorkerCapacityRecoverySnapshot["capacity"],
): WorkerCapacityRecoverySnapshot {
  return {
    busy: false,
    capacity,
  };
}
