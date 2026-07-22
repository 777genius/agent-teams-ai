import { describe, expect, it } from "vitest";

import { ProjectOperation } from "../../access-control";
import {
  ProjectAdmissionDecisionReason,
  ProjectAdmissionDecisionStatus,
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  evaluateProjectAdmission,
  summarizeProjectAdmissionDebt,
  type ProjectAdmissionSnapshot,
} from "../index";

describe("evaluateProjectAdmission", () => {
  it("allows producer work when the project snapshot has no blocking debt", () => {
    const decision = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      },
      snapshot: snapshot([]),
    });

    expect(decision).toMatchObject({
      allowed: true,
      status: ProjectAdmissionDecisionStatus.Allowed,
      reason: ProjectAdmissionDecisionReason.Allowed,
    });
  });

  it("denies producer work when completed dirty output is not consumed", () => {
    const decision = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.CreateJob,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.UnconsumedCompletedJob,
          subject: "infinity-context-memory-worker-v1",
          evidence: ["reviewed marker exists but output is not integrated"],
        },
      ]),
    });

    expect(decision).toMatchObject({
      allowed: false,
      status: ProjectAdmissionDecisionStatus.Denied,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      debt: [
        expect.objectContaining({
          reason: ProjectDebtReason.UnconsumedCompletedJob,
        }),
      ],
    });
  });

  it("admits only producer ownership proven disjoint from completed output", () => {
    const completedOutput = {
      reason: ProjectDebtReason.UnconsumedCompletedJob,
      subject: "infinity-context-memory-worker-v1",
      affectedPaths: ["src/memory/reader.ts", "docs/runtime.md"],
      evidence: ["reviewed marker exists but output is not integrated"],
    };
    const decide = (ownedPaths?: readonly string[]) => evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.CreateWorktree,
        workerRole: ProjectAdmissionWorkerRole.Producer,
        ...(ownedPaths ? { ownedPaths } : {}),
      },
      snapshot: snapshot([completedOutput]),
    });

    expect(decide(["src/billing/"])).toMatchObject({
      allowed: true,
      reason: ProjectAdmissionDecisionReason.Allowed,
      debt: [],
    });
    expect(decide(["src/memory/"])).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    });
    expect(decide(["src/memory/reader.ts/generated.ts"])).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    });
    expect(decide()).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    });
    expect(evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.CreateWorktree,
        workerRole: ProjectAdmissionWorkerRole.Producer,
        ownedPaths: ["src/billing/"],
      },
      snapshot: snapshot([{
        reason: ProjectDebtReason.UnconsumedCompletedJob,
        subject: "infinity-context-memory-worker-v1",
        evidence: ["completed output paths are missing"],
      }]),
    })).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    });
  });

  it("does not bypass non-terminal safety debt for disjoint producer paths", () => {
    for (const reason of [
      ProjectDebtReason.ActiveWriterConflict,
      ProjectDebtReason.StaleDirtyWorker,
      ProjectDebtReason.UnreadableWorkspace,
    ]) {
      expect(evaluateProjectAdmission({
        request: {
          operation: ProjectOperation.StartWorker,
          workerRole: ProjectAdmissionWorkerRole.Producer,
          ownedPaths: ["src/disjoint/"],
        },
        snapshot: snapshot([{
          reason,
          subject: "infinity-context-active-v1",
          affectedPaths: ["src/other.ts"],
          evidence: ["unsafe writer state"],
        }]),
      })).toMatchObject({
        allowed: false,
        reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      });
    }
  });

  it("allows reviewer and fastgate roles only as drain work when output debt exists", () => {
    const reviewer = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Reviewer,
      },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.InactiveDirtyWorkspace,
          subject: "/var/data/workspaces/infinity-context-old",
          evidence: ["dirty inactive workspace"],
        },
      ]),
    });
    const fastgate = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        tags: ["worker-role-fastgate"],
      },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.OrphanLegacyWorkspace,
          subject: "/var/data/workspaces/infinity-context-orphan",
          evidence: ["workspace is not represented in canonical registry"],
        },
      ]),
    });

    expect(reviewer).toMatchObject({
      allowed: true,
      status: ProjectAdmissionDecisionStatus.AllowedForDrainOnly,
    });
    expect(fastgate).toMatchObject({
      allowed: true,
      workerRole: ProjectAdmissionWorkerRole.Fastgate,
      status: ProjectAdmissionDecisionStatus.AllowedForDrainOnly,
    });
  });

  it("fails closed when snapshot state is unavailable, stale, unreadable or under disk pressure", () => {
    expect(evaluateProjectAdmission({
      request: { operation: ProjectOperation.StartWorker },
    })).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.SnapshotUnavailable,
    });
    expect(evaluateProjectAdmission({
      request: { operation: ProjectOperation.StartWorker },
      snapshot: snapshot([], { stale: true }),
    })).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.SnapshotStale,
    });
    expect(evaluateProjectAdmission({
      request: { operation: ProjectOperation.StartWorker },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.UnreadableRoot,
          subject: "/var/data/workspaces",
          evidence: ["git status timed out"],
        },
      ]),
    })).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.UnreadableProjectState,
    });
    expect(evaluateProjectAdmission({
      request: { operation: ProjectOperation.StartWorker },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.DiskPressure,
          subject: "/var/data",
          evidence: ["available bytes below threshold"],
        },
      ]),
    })).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.DiskPressure,
    });
  });

  it("treats an unreadable workspace as drainable output debt", () => {
    const producer = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.UnreadableWorkspace,
          subject: "/var/data/workspaces/infinity-context-broken",
          evidence: ["git status failed for a broken legacy worktree"],
        },
      ]),
    });
    const reviewer = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Reviewer,
      },
      snapshot: snapshot([
        {
          reason: ProjectDebtReason.UnreadableWorkspace,
          subject: "/var/data/workspaces/infinity-context-broken",
          evidence: ["git status failed for a broken legacy worktree"],
        },
      ]),
    });

    expect(producer).toMatchObject({
      allowed: false,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    });
    expect(reviewer).toMatchObject({
      allowed: true,
      status: ProjectAdmissionDecisionStatus.AllowedForDrainOnly,
    });
  });

  it("summarizes debt for admission decisions without letting consumed output block producers", () => {
    const consumedDebtItem = {
      reason: ProjectDebtReason.ConsumedDirtyWorkspace,
      subject: "/var/data/workspaces/infinity-context-consumed",
      severity: "info" as const,
      evidence: ["dirty output consumed by terminal ledger status: duplicate"],
    };
    const debt: ProjectAdmissionSnapshot["debt"] = [
      consumedDebtItem,
      {
        reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
        subject: "legacy-worker-ledger.json",
        severity: "info",
        evidence: ["retention-owned quarantine required"],
      },
      {
        reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        subject: "infinity-context-memory-v1",
        severity: "blocking",
        evidence: ["terminal consumed-output record is missing backup"],
      },
    ];

    expect(summarizeProjectAdmissionDebt(debt)).toMatchObject({
      blockingAdmissionDebt: [
        expect.objectContaining({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        }),
      ],
      counts: {
        consumedDirtyWorkspaces: 1,
        incompleteConsumedOutputRecords: 1,
        legacyOutputQuarantineRequired: 1,
      },
    });
    expect(evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      },
      snapshot: snapshot([consumedDebtItem]),
    })).toMatchObject({
      allowed: true,
      reason: ProjectAdmissionDecisionReason.Allowed,
    });
  });
});

function snapshot(
  debt: ProjectAdmissionSnapshot["debt"],
  extra: Partial<ProjectAdmissionSnapshot> = {},
): ProjectAdmissionSnapshot {
  return {
    schemaVersion: 1,
    projectId: "infinity-context",
    observedAt: "2026-07-05T00:00:00Z",
    debt,
    ...extra,
  };
}
