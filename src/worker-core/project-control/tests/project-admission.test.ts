import { describe, expect, it } from "vitest";

import { ProjectOperation } from "../../access-control";
import {
  ProjectAdmissionDecisionReason,
  ProjectAdmissionDecisionStatus,
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  evaluateProjectAdmission,
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
