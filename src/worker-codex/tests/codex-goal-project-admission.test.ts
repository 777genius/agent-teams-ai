import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectAdmissionSnapshot,
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";

describe("Codex project admission snapshot", () => {
  it("admits a disjoint writer and denies a writer targeting the active workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-active-writer-admission-"));
    const workspacePath = join(root, "worktrees", "project-producer");
    const disjointWorkspacePath = join(root, "worktrees", "project-disjoint-producer");
    const previousCacheTtl = process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_CACHE_TTL_MS;
    let activeWriter = false;

    try {
      process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_CACHE_TTL_MS = "120000";
      await mkdir(workspacePath, { recursive: true });
      await mkdir(disjointWorkspacePath, { recursive: true });
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => [{
          jobId: "project-producer",
          tags: ["worker-role-producer"],
          taskId: "project-producer",
          workspacePath,
          promptPath: join(root, "producer.md"),
          accountNames: ["account-a"],
          updatedAt: "2026-07-14T00:00:00.000Z",
          manifestPath: join(root, "producer.json"),
        }],
        buildOverviewItems: async () => [{
          ok: true,
          jobId: "project-producer",
          workspacePath,
          workspaceDirty: false,
          workerAlive: activeWriter,
          activeWriterRisk: activeWriter ? "active_worker" : "none",
          activeWriterRiskReasons: activeWriter ? ["worker process is alive"] : [],
        }],
      };
      const gate = codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope: {
          projectId: "project",
          jobIdPrefixes: ["project-"],
        },
        deps,
      });

      await expect(gate.evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: disjointWorkspacePath,
      })).resolves.toMatchObject({ allowed: true });

      activeWriter = true;
      await expect(gate.evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: disjointWorkspacePath,
      })).resolves.toMatchObject({ allowed: true });

      await expect(gate.evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      })).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
          subject: "project-producer",
        })],
      });
    } finally {
      if (previousCacheTtl === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_CACHE_TTL_MS;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_CACHE_TTL_MS = previousCacheTtl;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps shared-worktree review markers separate from terminal job ledgers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-shared-review-admission-"));
    const sharedWorkspace = join(root, "worktrees", "project-producer-v1");
    const documentWorkspace = join(root, "worktrees", "project-document-navigation-h8");
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups");
    const producerStatusPath = join(backupRoot, "producer.status.txt");
    const producerPatchPath = join(backupRoot, "producer.patch");
    const reviewerStatusPath = join(backupRoot, "reviewer.status.txt");
    const reviewerPatchPath = join(backupRoot, "reviewer.patch");
    const scope: ProjectAccessScope = {
      projectId: "project",
      worktreeRoots: [join(root, "worktrees")],
      consumedOutputLedgerRoots: [ledgerRoot],
      jobIdPrefixes: ["project-"],
    };

    try {
      await mkdir(sharedWorkspace, { recursive: true });
      await mkdir(documentWorkspace, { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(producerStatusPath, " M src/example.ts\n");
      await writeFile(producerPatchPath, "diff --git a/src/example.ts b/src/example.ts\n");
      await writeFile(reviewerStatusPath, "");
      await writeFile(reviewerPatchPath, "");
      await writeFile(
        join(ledgerRoot, "items", "project-producer-v1.json"),
        `${JSON.stringify({
          jobId: "project-producer-v1",
          status: "archived",
          closedAt: "2026-07-11T00:00:00.000Z",
          backup: {
            workspace: sharedWorkspace,
            statusPath: producerStatusPath,
            patchPath: producerPatchPath,
          },
        })}\n`,
      );
      await writeFile(
        join(ledgerRoot, "items", "project-reviewer-terminal-v1.json"),
        `${JSON.stringify({
          jobId: "project-reviewer-terminal-v1",
          status: "reviewed_no_change",
          outcome: "reviewed_no_change",
          closedAt: "2026-07-11T00:02:00.000Z",
          backup: {
            workspace: sharedWorkspace,
            statusPath: reviewerStatusPath,
            patchPath: reviewerPatchPath,
          },
        })}\n`,
      );

      const summary = (jobId: string, workspacePath: string) => ({
        jobId,
        tags: ["worker-role-reviewer"],
        taskId: jobId,
        workspacePath,
        promptPath: join(root, `${jobId}.md`),
        accountNames: ["account-a"],
        updatedAt: "2026-07-11T00:03:00.000Z",
        manifestPath: join(root, `${jobId}.json`),
      });
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: {
          listJobs: async () => [
            summary("project-producer-v1", sharedWorkspace),
            summary("project-reviewer-terminal-v1", sharedWorkspace),
            summary("project-reviewer-marker-v2", sharedWorkspace),
            summary("project-document-navigation-h8", documentWorkspace),
          ],
          buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({
            ok: true,
            jobId,
            workspacePath: jobId === "project-document-navigation-h8"
              ? documentWorkspace
              : sharedWorkspace,
            workspaceDirty: true,
            workerAlive: false,
            resultStatus: "completed",
            recommendedAction: "review_completed",
            tags: ["worker-role-reviewer"],
            lifecycleMarkerTypes: ["review"],
          })),
        },
      });

      expect(snapshot.debt).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        }),
      ]));
      expect(snapshot.debt.filter(
        (item) => item.reason === ProjectDebtReason.UnconsumedCompletedJob,
      )).toEqual([
        expect.objectContaining({ subject: documentWorkspace }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a live worker overview omits the active-writer risk kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-live-reviewer-admission-"));
    const workspacePath = join(root, "worktrees", "project-producer-v1");
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups");
    const statusPath = join(backupRoot, "producer.status.txt");
    const patchPath = join(backupRoot, "producer.patch");
    const scope: ProjectAccessScope = {
      projectId: "project",
      worktreeRoots: [join(root, "worktrees")],
      consumedOutputLedgerRoots: [ledgerRoot],
      jobIdPrefixes: ["project-"],
    };

    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(statusPath, " M src/example.ts\n");
      await writeFile(patchPath, "diff --git a/src/example.ts b/src/example.ts\n");
      await writeFile(
        join(ledgerRoot, "items", "project-producer-v1.json"),
        `${JSON.stringify({
          jobId: "project-producer-v1",
          status: "archived",
          closedAt: "2026-07-11T00:00:00.000Z",
          backup: { workspace: workspacePath, statusPath, patchPath },
        })}\n`,
      );

      const reviewer = {
        jobId: "project-reviewer-v1",
        tags: ["worker-role-reviewer"],
        taskId: "project-reviewer-v1",
        workspacePath,
        promptPath: join(root, "reviewer.md"),
        accountNames: ["account-a"],
        updatedAt: "2026-07-11T00:01:00.000Z",
        manifestPath: join(root, "reviewer.json"),
      };
      const overview = {
        ok: true,
        jobId: reviewer.jobId,
        workspacePath,
        workspaceDirty: true,
        workerAlive: true,
        silentStale: false,
        workerFreshProgressAlive: true,
      };
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => [reviewer],
        buildOverviewItems: async () => [overview],
      };

      const liveSnapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps,
      });
      expect(liveSnapshot.debt).toEqual([]);
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope,
        deps,
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
        })],
      });

      const staleSnapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: {
          ...deps,
          buildOverviewItems: async () => [{
            ...overview,
            silentStale: true,
            workerFreshProgressAlive: false,
          }],
        },
      });
      expect(staleSnapshot.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.StaleDirtyWorker,
          subject: workspacePath,
          severity: "blocking",
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only consumes an inactive reused workspace when the ledger is newer", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-reused-workspace-"));
    const workspacePath = join(root, "worktrees", "project-router-r1");
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups");
    const statusPath = join(backupRoot, "router-r2.status.txt");
    const patchPath = join(backupRoot, "router-r2.patch");
    const scope: ProjectAccessScope = {
      projectId: "project",
      worktreeRoots: [join(root, "worktrees")],
      consumedOutputLedgerRoots: [ledgerRoot],
      jobIdPrefixes: ["project-"],
    };

    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(statusPath, " M docs/router.md\n");
      await writeFile(patchPath, "diff --git a/docs/router.md b/docs/router.md\n");
      await writeFile(
        join(ledgerRoot, "items", "project-router-r2.json"),
        `${JSON.stringify({
          jobId: "project-router-r2",
          status: "integrated",
          closedAt: "2026-07-13T13:34:16.281Z",
          commitSha: "b".repeat(40),
          backup: { workspace: workspacePath, statusPath, patchPath },
        })}\n`,
      );

      const summary = (jobId: string, updatedAt: string) => ({
        jobId,
        tags: ["worker-role-producer"],
        taskId: jobId,
        workspacePath,
        promptPath: join(root, `${jobId}.md`),
        accountNames: ["account-a"],
        updatedAt,
        manifestPath: join(root, `${jobId}.json`),
      });
      const deps = (input: {
        readonly currentUpdatedAt: string;
        readonly consumingUpdatedAt?: string;
        readonly activeWriterRisk?: string;
        readonly workspaceConflict?: boolean;
      }): CodexProjectAdmissionDeps => ({
        listJobs: async () => [
          summary("project-router-r1", input.currentUpdatedAt),
          ...(input.consumingUpdatedAt
            ? [summary("project-router-r2", input.consumingUpdatedAt)]
            : []),
        ],
        buildOverviewItems: async () => [{
          ok: true,
          jobId: "project-router-r1",
          workspacePath,
          workspaceDirty: true,
          workerAlive: false,
          activeWriterRisk:
            input.activeWriterRisk ?? "dirty_workspace_without_worker",
          activeWriterRiskReasons: [
            input.activeWriterRisk ?? "dirty_workspace_without_worker",
          ],
          workspaceConflict: input.workspaceConflict ?? false,
          resultStatus: "completed",
          tags: ["worker-role-producer"],
        }],
      });

      const consumed = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps({
          currentUpdatedAt: "2026-07-13T13:30:00.000Z",
          consumingUpdatedAt: "2026-07-13T13:32:00.000Z",
        }),
      });
      expect(consumed.counts).toMatchObject({
        activeWriterConflicts: 0,
        consumedDirtyWorkspaces: 1,
        incompleteConsumedOutputRecords: 0,
      });

      const stateMismatch = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps({
          currentUpdatedAt: "2026-07-13T13:30:00.000Z",
          consumingUpdatedAt: "2026-07-13T13:32:00.000Z",
          activeWriterRisk: "state_mismatch",
        }),
      });
      expect(stateMismatch.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
          severity: "blocking",
        }),
      ]));

      const workspaceConflict = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps({
          currentUpdatedAt: "2026-07-13T13:30:00.000Z",
          consumingUpdatedAt: "2026-07-13T13:32:00.000Z",
          workspaceConflict: true,
        }),
      });
      expect(workspaceConflict.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
          severity: "blocking",
        }),
      ]));

      const newerDirtyJob = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps({
          currentUpdatedAt: "2026-07-13T13:40:00.000Z",
          consumingUpdatedAt: "2026-07-13T13:32:00.000Z",
        }),
      });
      expect(newerDirtyJob.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
          severity: "blocking",
        }),
      ]));

      const missingConsumingJob = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps({ currentUpdatedAt: "2026-07-13T13:30:00.000Z" }),
      });
      expect(missingConsumingJob.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: "blocking" }),
      ]));

      const equalGeneration = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps({
          currentUpdatedAt: "2026-07-13T13:32:00.000Z",
          consumingUpdatedAt: "2026-07-13T13:32:00.000Z",
        }),
      });
      expect(equalGeneration.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: "blocking" }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
