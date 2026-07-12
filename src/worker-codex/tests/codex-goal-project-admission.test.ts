import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectDebtReason,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectAdmissionSnapshot,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";

describe("Codex project admission snapshot", () => {
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

  it("does not assign consumed producer output to a live reviewer sharing its workspace", async () => {
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
      expect(staleSnapshot.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.StaleDirtyWorker,
          subject: workspacePath,
          severity: "blocking",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
