import { describe, expect, it } from "vitest";
import {
  RunEventProviderKind,
  RunObservationService,
  compareRunObservationHistory,
  decideRunObservation,
  type RunObservationPort,
  type RunObservationSnapshot,
} from "../index";

describe("RunObservationService", () => {
  it("normalizes read-only observations from provider adapters", async () => {
    const port: RunObservationPort = {
      async listRunIds() {
        return ["run-a"];
      },
      async observeRun(input) {
        return snapshot({
          runId: input.runId,
          status: "running",
          liveness: "alive",
        });
      },
    };

    const service = new RunObservationService(port, {
      clock: { now: () => new Date("2026-06-30T00:00:00.000Z") },
    });

    const [observed] = await service.observeRuns();

    expect(observed).toMatchObject({
      runId: "run-a",
      providerKind: RunEventProviderKind.Unknown,
      observedAt: "2026-06-30T00:00:00.000Z",
      status: "running",
      liveness: "alive",
      readOnlyDecision: {
        kind: "keep_watching",
      },
    });
  });
});

describe("compareRunObservationHistory", () => {
  it("treats log, result and workspace changes as growth without using heartbeat-only progress", () => {
    const previous = {
      schemaVersion: 1 as const,
      runId: "run-a",
      providerKind: RunEventProviderKind.Codex,
      observedAt: "2026-07-01T00:00:00.000Z",
      workspaceDirty: false,
      changedFilesCount: 0,
      workspaceSignature: "clean",
      resultExists: false,
      logByteLength: 10,
    };

    expect(compareRunObservationHistory(previous, {
      ...previous,
      observedAt: "2026-07-01T00:01:00.000Z",
      logByteLength: 11,
    })).toMatchObject({
      logGrew: true,
      anyGrowth: true,
    });

    expect(compareRunObservationHistory(previous, {
      ...previous,
      observedAt: "2026-07-01T00:01:00.000Z",
      resultExists: true,
      resultStatus: "blocked",
      resultUpdatedAt: "2026-07-01T00:01:00.000Z",
    })).toMatchObject({
      resultChanged: true,
      anyGrowth: true,
    });

    expect(compareRunObservationHistory(previous, {
      ...previous,
      observedAt: "2026-07-01T00:01:00.000Z",
      workspaceDirty: true,
      changedFilesCount: 1,
      workspaceSignature: "dirty",
    })).toMatchObject({
      workspaceChanged: true,
      anyGrowth: true,
    });
  });
});

describe("decideRunObservation", () => {
  it("flags completed results that still have a live process", () => {
    expect(decideRunObservation({
      status: "completed",
      liveness: "alive",
      result: { exists: true, status: "completed" },
    })).toMatchObject({
      kind: "unsafe_state_mismatch",
      reason: "completed_result_with_live_process",
    });
  });

  it("flags stopped runs that still report running progress", () => {
    expect(decideRunObservation({
      status: "stopped",
      liveness: "dead",
      progress: { status: "running" },
    })).toMatchObject({
      kind: "unsafe_state_mismatch",
      reason: "stopped_run_with_running_progress",
    });
  });

  it("keeps fresh alive workers in watch-only mode", () => {
    expect(decideRunObservation({
      status: "running",
      liveness: "alive",
      progress: {
        status: "running",
        heartbeatAgeMs: 1_000,
        staleAfterMs: 60_000,
        stale: false,
      },
    })).toMatchObject({
      kind: "keep_watching",
    });
  });

  it("requires inspection for silent-stale workers", () => {
    expect(decideRunObservation({
      status: "running",
      liveness: "stale",
      progress: {
        heartbeatAgeMs: 120_000,
        staleAfterMs: 60_000,
        stale: true,
        silentStale: true,
      },
    })).toMatchObject({
      kind: "stale_needs_inspection",
    });
  });

  it("requires inspection for heartbeat-only workers without output", () => {
    expect(decideRunObservation({
      status: "running",
      liveness: "alive",
      progress: {
        status: "running",
        heartbeatAgeMs: 1_000,
        staleAfterMs: 60_000,
        stale: false,
        heartbeatOnlyNoOutput: true,
      },
      result: { exists: false },
      logs: { exists: false, byteLength: 0 },
      workspace: { dirty: false, changedFilesCount: 0 },
    })).toMatchObject({
      kind: "stale_needs_inspection",
      reason: "heartbeat_only_no_output",
    });
  });

  it("does not prescribe recovery for dirty stopped workspaces", () => {
    expect(decideRunObservation({
      status: "failed",
      liveness: "dead",
      workspace: {
        dirty: true,
        changedFilesCount: 1,
        changedFiles: ["M src/file.ts"],
      },
    })).toMatchObject({
      kind: "manual_review_required",
    });
  });

  it("treats completed runs with workspace changes as ready for review", () => {
    expect(decideRunObservation({
      status: "completed",
      liveness: "dead",
      result: { exists: true, status: "completed" },
      workspace: {
        dirty: true,
        changedFilesCount: 1,
        changedFiles: ["M src/file.ts"],
      },
    })).toMatchObject({
      kind: "review_completed",
      reason: "terminal_result_completed",
    });
  });

  it("surfaces account and capacity blockers read-only", () => {
    expect(decideRunObservation({
      status: "stopped",
      liveness: "dead",
      capacity: [{
        account: "account-a",
        status: "ready",
        availability: "cooldown",
        reason: "quota_limited",
      }],
    })).toMatchObject({
      kind: "capacity_blocked",
    });
  });

  it("keeps watching when at least one account remains available", () => {
    expect(decideRunObservation({
      status: "running",
      liveness: "alive",
      progress: {
        status: "running",
        heartbeatAgeMs: 1_000,
        staleAfterMs: 60_000,
        stale: false,
      },
      capacity: [
        {
          account: "account-g",
          status: "ready",
          availability: "cooldown",
          reason: "quota_limited",
        },
        {
          account: "account-d",
          status: "ready",
        },
      ],
    })).toMatchObject({
      kind: "keep_watching",
    });
  });

  it("requires review for stopped runs without a terminal result", () => {
    expect(decideRunObservation({
      status: "stopped",
      liveness: "dead",
      result: { exists: false },
    })).toMatchObject({
      kind: "manual_review_required",
      reason: "stopped_without_terminal_result",
    });
  });

  it("keeps watching running workers with pending control inbox guidance", () => {
    expect(decideRunObservation({
      status: "running",
      liveness: "alive",
      controlInbox: {
        pendingCount: 1,
        deliverableCount: 1,
        blockedDeliveryCount: 0,
        safeToContinue: true,
      },
    })).toMatchObject({
      kind: "keep_watching",
      reason: "guidance_pending",
    });
  });

  it("keeps watching after control inbox guidance was delivered", () => {
    expect(decideRunObservation({
      status: "running",
      liveness: "alive",
      controlInbox: {
        pendingCount: 0,
        deliveredCount: 1,
        latestDeliveredAt: "2026-06-30T00:00:00.000Z",
      },
    })).toMatchObject({
      kind: "keep_watching",
      reason: "guidance_delivered",
    });
  });
});

function snapshot(input: {
  readonly runId: string;
  readonly status: RunObservationSnapshot["status"];
  readonly liveness: RunObservationSnapshot["liveness"];
}): RunObservationSnapshot {
  return {
    runId: input.runId,
    providerKind: RunEventProviderKind.Unknown,
    observedAt: "",
    status: input.status,
    liveness: input.liveness,
    warnings: [],
    readOnlyDecision: decideRunObservation({
      status: input.status,
      liveness: input.liveness,
    }),
  };
}
