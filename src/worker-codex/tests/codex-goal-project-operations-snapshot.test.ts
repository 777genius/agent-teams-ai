import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectOperation,
  evaluateProjectAdmission,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectOperationsSnapshot,
} from "../application/project-control/codex-goal-project-operations-snapshot";

describe("Codex project operations snapshot adapter", () => {
  it("projects pool, heavy workers, memory, debt and admission without authority", async () => {
    const admissionSnapshot = {
      schemaVersion: 1 as const,
      projectId: "project-1",
      observedAt: "2026-07-13T00:00:00.000Z",
      debt: [],
    };
    const admissionDecision = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.CreateJob,
        projectId: "project-1",
        workerRole: ProjectAdmissionWorkerRole.Producer,
      },
      snapshot: admissionSnapshot,
    });
    const snapshot = await buildCodexProjectOperationsSnapshot({
      registryRootDir: "/registry",
      scope: {
        projectId: "project-1",
        jobIdPrefixes: ["project-"],
      },
      admissionSnapshot,
      admissionDecision,
      now: new Date("2026-07-13T00:01:00.000Z"),
      staleAfterMs: 120_000,
      hostMemory: { totalBytes: 15_000, availableBytes: 4_000 },
      deps: {
        listJobs: async () => [{
          jobId: "project-reviewer-1",
          tags: ["worker-role-reviewer"],
          taskId: "task-1",
          workspacePath: "/worktrees/reviewer-1",
          promptPath: "/jobs/reviewer-1/prompt.md",
          accountNames: ["account-a"],
          updatedAt: "2026-07-13T00:00:30.000Z",
          manifestPath: "/registry/project-reviewer-1/job.json",
        }],
        buildOverviewItems: async () => [{
          ok: true,
          jobId: "project-reviewer-1",
          workerAlive: true,
          isStale: false,
          recommendedAction: "wait_for_worker",
          progressStatus: "running",
        }],
      },
    });

    expect(snapshot).toMatchObject({
      authoritative: false,
      projectId: "project-1",
      pool: { total: 1 },
      outputDebt: { available: true, count: 0 },
      hostMemory: {
        available: true,
        totalBytes: 15_000,
        availableBytes: 4_000,
      },
      heavyWorkers: { running: 1, truncated: 0 },
      admission: { available: true, allowed: true, reason: "allowed" },
    });
  });
});
