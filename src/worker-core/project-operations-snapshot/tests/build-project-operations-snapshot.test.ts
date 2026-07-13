import { describe, expect, it } from "vitest";

import {
  ProjectAdmissionDecisionReason,
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
} from "../../project-control";
import {
  buildProjectOperationsSnapshot,
  PROJECT_OPERATIONS_SNAPSHOT_MAX_EVIDENCE_LENGTH,
  PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS,
  PROJECT_OPERATIONS_SNAPSHOT_MAX_WORKER_EVIDENCE,
  ProjectOperationsSnapshotCompletenessStatus,
  ProjectOperationsSnapshotFreshnessStatus,
  ProjectOperationsSnapshotSection,
  ProjectOperationsWorkerState,
  ProjectOperationsWorkloadClass,
  type BuildProjectOperationsSnapshotInput,
  type ProjectOperationsWorkerObservation,
} from "../index";

const observedAt = new Date("2026-07-13T12:00:00.000Z");

describe("buildProjectOperationsSnapshot", () => {
  it("builds a complete provider-neutral controller projection", () => {
    const snapshot = buildProjectOperationsSnapshot(completeInput({
      workers: [
        worker("producer-1", ProjectAdmissionWorkerRole.Producer, ProjectOperationsWorkerState.Running),
        worker("producer-2", ProjectAdmissionWorkerRole.Producer, ProjectOperationsWorkerState.Running),
        worker("reviewer-1", ProjectAdmissionWorkerRole.Reviewer, ProjectOperationsWorkerState.Queued),
        worker(
          "verifier-1",
          ProjectAdmissionWorkerRole.Fastgate,
          ProjectOperationsWorkerState.Running,
          ProjectOperationsWorkloadClass.Heavy,
          ["typecheck", "lint"],
        ),
      ],
    }));

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      projectionVersion: 1,
      authoritative: false,
      projectId: "project-a",
      observedAt: observedAt.toISOString(),
      completeness: {
        status: ProjectOperationsSnapshotCompletenessStatus.Complete,
        missingSections: [],
      },
      freshness: {
        status: ProjectOperationsSnapshotFreshnessStatus.Fresh,
        ageMs: 30_000,
        staleAfterMs: 60_000,
      },
      pool: {
        total: 4,
        counts: [
          {
            role: ProjectAdmissionWorkerRole.Producer,
            state: ProjectOperationsWorkerState.Running,
            count: 2,
          },
          {
            role: ProjectAdmissionWorkerRole.Fastgate,
            state: ProjectOperationsWorkerState.Running,
            count: 1,
          },
          {
            role: ProjectAdmissionWorkerRole.Reviewer,
            state: ProjectOperationsWorkerState.Queued,
            count: 1,
          },
        ],
      },
      outputDebt: {
        available: true,
        count: 2,
        reasons: [
          ProjectDebtReason.UnconsumedCompletedJob,
          ProjectDebtReason.ActiveWriterConflict,
        ],
      },
      hostMemory: {
        available: true,
        totalBytes: 16_000,
        availableBytes: 4_000,
      },
      heavyWorkers: {
        running: 1,
        evidence: [{
          workerId: "verifier-1",
          role: ProjectAdmissionWorkerRole.Fastgate,
          evidence: ["typecheck", "lint"],
        }],
        truncated: 0,
      },
      admission: {
        available: true,
        allowed: false,
        reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      },
    });
  });

  it("marks unavailable source sections as partial without inventing facts", () => {
    const snapshot = buildProjectOperationsSnapshot({
      projectId: "project-a",
      observedAt,
      now: observedAt,
      staleAfterMs: 60_000,
    });

    expect(snapshot.completeness).toEqual({
      status: ProjectOperationsSnapshotCompletenessStatus.Partial,
      missingSections: [
        ProjectOperationsSnapshotSection.Pool,
        ProjectOperationsSnapshotSection.OutputDebt,
        ProjectOperationsSnapshotSection.HostMemory,
        ProjectOperationsSnapshotSection.Admission,
      ],
    });
    expect(snapshot.pool).toEqual({ total: 0, counts: [] });
    expect(snapshot.outputDebt).toEqual({
      available: false,
      count: null,
      reasons: [],
    });
    expect(snapshot.hostMemory).toEqual({
      available: false,
      totalBytes: null,
      availableBytes: null,
    });
    expect(snapshot.admission).toEqual({
      available: false,
      allowed: null,
      reason: null,
    });
  });

  it("marks an old projection stale while preserving completeness", () => {
    const snapshot = buildProjectOperationsSnapshot(completeInput({
      now: new Date(observedAt.getTime() + 60_001),
    }));

    expect(snapshot.completeness.status).toBe(
      ProjectOperationsSnapshotCompletenessStatus.Complete,
    );
    expect(snapshot.freshness).toEqual({
      status: ProjectOperationsSnapshotFreshnessStatus.Stale,
      ageMs: 60_001,
      staleAfterMs: 60_000,
    });
  });

  it("bounds and sanitizes heavy-worker evidence without changing counts", () => {
    const evidence = Array.from(
      { length: PROJECT_OPERATIONS_SNAPSHOT_MAX_WORKER_EVIDENCE + 3 },
      (_, index) => ` evidence-${index} ${"x".repeat(300)}`,
    );
    const workers = Array.from(
      { length: PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS + 3 },
      (_, index) => worker(
        `heavy-${index}`,
        ProjectAdmissionWorkerRole.Fastgate,
        ProjectOperationsWorkerState.Running,
        ProjectOperationsWorkloadClass.Heavy,
        index === 0 ? [evidence[0]!, evidence[0]!, ...evidence] : [],
      ),
    );

    const snapshot = buildProjectOperationsSnapshot(completeInput({ workers }));

    expect(snapshot.pool.total).toBe(PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS + 3);
    expect(snapshot.heavyWorkers.running).toBe(
      PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS + 3,
    );
    expect(snapshot.heavyWorkers.evidence).toHaveLength(
      PROJECT_OPERATIONS_SNAPSHOT_MAX_HEAVY_WORKERS,
    );
    expect(snapshot.heavyWorkers.truncated).toBe(3);
    expect(snapshot.heavyWorkers.evidence[0]?.evidence).toHaveLength(
      PROJECT_OPERATIONS_SNAPSHOT_MAX_WORKER_EVIDENCE,
    );
    expect(snapshot.heavyWorkers.evidence[0]?.evidence[0]).toHaveLength(
      PROJECT_OPERATIONS_SNAPSHOT_MAX_EVIDENCE_LENGTH,
    );
  });

  it("rejects duplicate worker identities and invalid memory facts", () => {
    const duplicate = worker(
      "worker-1",
      ProjectAdmissionWorkerRole.Producer,
      ProjectOperationsWorkerState.Running,
    );

    expect(() => buildProjectOperationsSnapshot(completeInput({
      workers: [duplicate, duplicate],
    }))).toThrow("Duplicate workerId: worker-1");
    expect(() => buildProjectOperationsSnapshot(completeInput({
      hostMemory: { totalBytes: 10, availableBytes: 11 },
    }))).toThrow("hostMemory.availableBytes must not exceed totalBytes");
  });
});

function completeInput(
  overrides: Partial<BuildProjectOperationsSnapshotInput> = {},
): BuildProjectOperationsSnapshotInput {
  return {
    projectId: "project-a",
    observedAt,
    now: new Date(observedAt.getTime() + 30_000),
    staleAfterMs: 60_000,
    workers: [],
    outputDebt: {
      count: 2,
      reasons: [
        ProjectDebtReason.ActiveWriterConflict,
        ProjectDebtReason.UnconsumedCompletedJob,
        ProjectDebtReason.ActiveWriterConflict,
      ],
    },
    hostMemory: { totalBytes: 16_000, availableBytes: 4_000 },
    admission: {
      allowed: false,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    },
    ...overrides,
  };
}

function worker(
  workerId: string,
  role: ProjectAdmissionWorkerRole,
  state: ProjectOperationsWorkerState,
  workloadClass = ProjectOperationsWorkloadClass.Standard,
  evidence: readonly string[] = [],
): ProjectOperationsWorkerObservation {
  return { workerId, role, state, workloadClass, evidence };
}
