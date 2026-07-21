import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

describe("Codex project admission snapshot", () => {
  it("routes absent-registry legacy failed_no_output debt to retention without weakening current registry gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-legacy-ledger-admission-"));
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups", "project-legacy-worker-v1");
    const statusPath = join(backupRoot, "git-status.txt");
    const patchPath = join(backupRoot, "worker-output.patch");
    const workspacePath = join(root, "missing-worktrees", "project-legacy-worker-v1");
    const previousLimit = process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
    const scope: ProjectAccessScope = {
      projectId: "project",
      consumedOutputLedgerRoots: [ledgerRoot],
      jobIdPrefixes: ["project-"],
    };
    const summary = (jobId: string, updatedAt: string) => ({
      jobId,
      tags: ["worker-role-producer"],
      taskId: jobId,
      workspacePath: join(root, "worktrees", jobId),
      promptPath: join(root, `${jobId}.md`),
      accountNames: ["account-a"],
      updatedAt,
      manifestPath: join(root, `${jobId}.json`),
    });

    try {
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(statusPath, "?? docs/legacy-output/\n");
      await writeFile(patchPath, "");
      await writeFile(
        join(ledgerRoot, "items", "project-legacy-worker-v1.json"),
        `${JSON.stringify({
          jobId: "project-legacy-worker-v1",
          status: "failed_no_output",
          closedAt: "2026-07-12T00:00:00.000Z",
          failure: { category: "infrastructure", code: "legacy_failure" },
          output: { authoredChanges: false, workspaceDirty: false },
          note: "Legacy archive lost untracked payload evidence.",
          backup: { workspace: workspacePath, statusPath, patchPath },
        })}\n`,
      );
      const deps = (jobs: readonly ReturnType<typeof summary>[]): CodexProjectAdmissionDeps => ({
        listJobs: async () => jobs,
        buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({
          ok: true,
          jobId,
          workspacePath: join(root, "worktrees", jobId),
          workspaceDirty: false,
          workerAlive: false,
        })),
      });

      const absent = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps([]),
      });
      expect(absent.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
          severity: "info",
          evidence: expect.arrayContaining([
            expect.stringContaining("retention-owned immutable capture/quarantine"),
          ]),
        }),
      ]);
      expect(absent.counts).toMatchObject({
        incompleteConsumedOutputRecords: 0,
        legacyOutputQuarantineRequired: 1,
      });
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps([]),
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({ allowed: true });

      process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = "1";
      const current = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps([
          summary("project-legacy-worker-v1", "2026-07-12T00:01:00.000Z"),
          summary("project-newer-worker-v2", "2026-07-12T00:02:00.000Z"),
        ]),
      });
      expect(current.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
          severity: "blocking",
        }),
      ]));
      expect(current.counts).toMatchObject({
        incompleteConsumedOutputRecords: 1,
        legacyOutputQuarantineRequired: 0,
      });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = previousLimit;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("admits only the verified input-patch target through its self debt", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-admitted-patch-start-"));
    const workspacePath = join(root, "worktrees", "project-remediation");
    let activeWriterRisk = "dirty_workspace_without_worker";
    try {
      await mkdir(workspacePath, { recursive: true });
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => [{
          jobId: "project-remediation",
          tags: ["worker-role-producer"],
          taskId: "project-remediation",
          workspacePath,
          promptPath: join(root, "remediation.md"),
          accountNames: ["account-a"],
          updatedAt: "2026-07-15T00:00:00.000Z",
          manifestPath: join(root, "remediation.json"),
        }],
        buildOverviewItems: async () => [{
          ok: true,
          jobId: "project-remediation",
          workspacePath,
          workspaceDirty: true,
          workerAlive: activeWriterRisk === "active_worker",
          activeWriterRisk,
          activeWriterRiskReasons: [activeWriterRisk],
          lifecycleMarkerTypes: [],
        }],
      };
      const gate = codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope: { projectId: "project", jobIdPrefixes: ["project-"] },
        deps,
        admittedInputPatchTarget: {
          jobId: "project-remediation",
          workspacePath,
        },
      });

      await expect(gate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-remediation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      })).resolves.toMatchObject({ allowed: true, debt: [] });
      await expect(gate.evaluate({
        operation: ProjectOperation.CreateWorktree,
        jobId: "project-remediation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      })).resolves.toMatchObject({ allowed: true, debt: [] });
      await expect(gate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-other",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      })).resolves.toMatchObject({ allowed: false });

      activeWriterRisk = "active_worker";
      await expect(gate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-remediation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      })).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
        })],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits a bound input patch past only unrelated held output debt", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-admitted-patch-debt-"));
    const worktreeRoot = join(root, "worktrees");
    const workspacePath = join(worktreeRoot, "project-remediation");
    const siblingWorkspacePath = join(worktreeRoot, "project-held-sibling");
    const previousMinFreeKb = process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MIN_FREE_KB;
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(siblingWorkspacePath, { recursive: true });
      const summary = (jobId: string, path: string) => ({
        jobId,
        tags: ["worker-role-producer"],
        taskId: jobId,
        workspacePath: path,
        promptPath: join(root, `${jobId}.md`),
        accountNames: ["account-a"],
        updatedAt: "2026-07-16T00:00:00.000Z",
        manifestPath: join(root, `${jobId}.json`),
      });
      const targetOverview = (overrides: Record<string, unknown> = {}) => ({
        ok: true,
        jobId: "project-remediation",
        workspacePath,
        workspaceDirty: true,
        workerAlive: false,
        activeWriterRisk: "dirty_workspace_without_worker",
        activeWriterRiskReasons: ["dirty_workspace_without_worker"],
        lifecycleMarkerTypes: [],
        ...overrides,
      });
      const heldSiblingOverview = {
        ok: true,
        jobId: "project-held-sibling",
        workspacePath: siblingWorkspacePath,
        workspaceDirty: true,
        workerAlive: false,
        activeWriterRisk: "dirty_workspace_without_worker",
        activeWriterRiskReasons: ["dirty_workspace_without_worker"],
        resultStatus: "completed",
        recommendedAction: "review_completed",
        lifecycleMarkerTypes: ["review"],
      };
      const deps = (
        target: Readonly<Record<string, unknown>> = targetOverview(),
        sibling: Readonly<Record<string, unknown>> = heldSiblingOverview,
      ): CodexProjectAdmissionDeps => ({
        listJobs: async () => [
          summary("project-remediation", workspacePath),
          summary("project-held-sibling", siblingWorkspacePath),
        ],
        buildOverviewItems: async () => [target, sibling],
      });
      const gate = (admissionDeps: CodexProjectAdmissionDeps) =>
        codexProjectAdmissionGate({
          registryRootDir: join(root, "registry"),
          scope: {
            projectId: "project",
            jobIdPrefixes: ["project-"],
          },
          deps: admissionDeps,
          admittedInputPatchTarget: {
            jobId: "project-remediation",
            workspacePath,
          },
        });
      const request = (operation: ProjectOperation) => ({
        operation,
        jobId: "project-remediation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      });

      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope: { projectId: "project", jobIdPrefixes: ["project-"] },
        deps: deps(),
      }).evaluate(request(ProjectOperation.StartWorker))).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
      });
      await expect(gate(deps()).evaluate(
        request(ProjectOperation.CreateWorktree),
      )).resolves.toMatchObject({ allowed: true, debt: [] });
      await expect(gate(deps()).evaluate(
        request(ProjectOperation.StartWorker),
      )).resolves.toMatchObject({ allowed: true, debt: [] });
      await expect(gate(deps()).evaluate({
        ...request(ProjectOperation.StartWorker),
        jobId: "project-other",
      })).resolves.toMatchObject({ allowed: false });
      await expect(gate(deps()).evaluate({
        ...request(ProjectOperation.StartWorker),
        workspacePath: siblingWorkspacePath,
      })).resolves.toMatchObject({ allowed: false });
      await expect(gate(deps()).evaluate(
        request(ProjectOperation.CreateJob),
      )).resolves.toMatchObject({
        allowed: false,
        debt: expect.arrayContaining([
          expect.objectContaining({
            reason: ProjectDebtReason.UnconsumedCompletedJob,
            subject: siblingWorkspacePath,
          }),
          expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict,
            subject: "project-held-sibling",
          }),
        ]),
      });

      const orphanJobId = "project-orphan-remediation";
      const orphanWorkspacePath = join(worktreeRoot, orphanJobId);
      await mkdir(orphanWorkspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: orphanWorkspacePath });
      await writeFile(join(orphanWorkspacePath, "seeded.txt"), "seeded output\n");
      const orphanGate = codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope: {
          projectId: "project",
          jobIdPrefixes: ["project-"],
          worktreeRoots: [worktreeRoot],
        },
        deps: {
          listJobs: async () => [],
          buildOverviewItems: async () => [],
        },
        admittedInputPatchTarget: {
          jobId: orphanJobId,
          workspacePath: orphanWorkspacePath,
        },
      });
      await expect(orphanGate.evaluate({
        operation: ProjectOperation.CreateJob,
        jobId: orphanJobId,
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: orphanWorkspacePath,
      })).resolves.toMatchObject({ allowed: true, debt: [] });

      await expect(gate(deps(targetOverview(), {
        ...heldSiblingOverview,
        resultStatus: undefined,
        recommendedAction: undefined,
        lifecycleMarkerTypes: [],
      })).evaluate(request(ProjectOperation.StartWorker))).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.InactiveDirtyWorkspace,
          subject: siblingWorkspacePath,
        })],
      });

      await expect(gate(deps(targetOverview({
        resultStatus: "completed",
        recommendedAction: "review_completed",
        lifecycleMarkerTypes: ["review"],
      }))).evaluate(request(ProjectOperation.StartWorker))).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.UnconsumedCompletedJob,
          subject: workspacePath,
        })],
      });

      await expect(gate(deps(targetOverview(), {
        ...heldSiblingOverview,
        workspacePath,
        workerAlive: true,
        activeWriterRisk: "active_worker",
        activeWriterRiskReasons: ["active worker overlaps admitted workspace"],
      })).evaluate(request(ProjectOperation.StartWorker))).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
        })],
      });

      await expect(gate({
        listJobs: async () => {
          throw new Error("registry unavailable");
        },
        buildOverviewItems: async () => [],
      }).evaluate(request(ProjectOperation.StartWorker))).resolves.toMatchObject({
        allowed: false,
        reason: "unreadable_project_state",
      });

      process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MIN_FREE_KB =
        String(Number.MAX_SAFE_INTEGER);
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        scope: {
          projectId: "project",
          jobIdPrefixes: ["project-"],
          worktreeRoots: [worktreeRoot],
        },
        deps: deps(),
        admittedInputPatchTarget: {
          jobId: "project-remediation",
          workspacePath,
        },
      }).evaluate(request(ProjectOperation.StartWorker))).resolves.toMatchObject({
        allowed: false,
        reason: "disk_pressure",
      });
    } finally {
      if (previousMinFreeKb === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MIN_FREE_KB;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MIN_FREE_KB = previousMinFreeKb;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-admit same-job capacity continuation against sibling held output", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-capacity-continuation-admission-"));
    const continuationWorkspace = join(root, "worktrees", "project-continuation");
    const siblingWorkspace = join(root, "worktrees", "project-reviewed-sibling");
    try {
      await mkdir(continuationWorkspace, { recursive: true });
      await mkdir(siblingWorkspace, { recursive: true });
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => [
          {
            jobId: "project-continuation",
            tags: ["worker-role-producer"],
            taskId: "project-continuation",
            workspacePath: continuationWorkspace,
            promptPath: join(root, "continuation.md"),
            accountNames: ["account-a"],
            updatedAt: "2026-07-16T00:00:00.000Z",
            manifestPath: join(root, "continuation.json"),
          },
          {
            jobId: "project-reviewed-sibling",
            tags: ["worker-role-producer"],
            taskId: "project-reviewed-sibling",
            workspacePath: siblingWorkspace,
            promptPath: join(root, "sibling.md"),
            accountNames: ["account-b"],
            updatedAt: "2026-07-16T00:01:00.000Z",
            manifestPath: join(root, "sibling.json"),
          },
        ],
        buildOverviewItems: async () => [
          {
            ok: true,
            jobId: "project-continuation",
            workspacePath: continuationWorkspace,
            workspaceDirty: true,
            workerAlive: false,
            activeWriterRisk: "dirty_workspace_without_worker",
            activeWriterRiskReasons: ["dirty_workspace_without_worker"],
            resultStatus: "blocked",
            resultReason: "account_unavailable",
            recommendedAction: "continue_after_capacity",
          },
          {
            ok: true,
            jobId: "project-reviewed-sibling",
            workspacePath: siblingWorkspace,
            workspaceDirty: true,
            workerAlive: false,
            activeWriterRisk: "dirty_workspace_without_worker",
            activeWriterRiskReasons: ["dirty_workspace_without_worker"],
            resultStatus: "completed",
            recommendedAction: "review_completed",
            lifecycleMarkerTypes: ["review"],
          },
        ],
      };
      const input = {
        registryRootDir: join(root, "registry"),
        scope: { projectId: "project", jobIdPrefixes: ["project-"] },
        deps,
      };
      const ordinaryGate = codexProjectAdmissionGate(input);
      const continuationGate = codexProjectAdmissionGate({
        ...input,
        capacityContinuationTarget: {
          jobId: "project-continuation",
          workspacePath: continuationWorkspace,
        },
      });

      await expect(ordinaryGate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-continuation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: continuationWorkspace,
      })).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
      });
      await expect(continuationGate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-continuation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: continuationWorkspace,
      })).resolves.toMatchObject({ allowed: true, debt: [] });
      await expect(continuationGate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-new-producer",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: join(root, "worktrees", "project-new-producer"),
      })).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
      });
      await expect(continuationGate.evaluate({
        operation: ProjectOperation.CreateWorktree,
        jobId: "project-continuation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: continuationWorkspace,
      })).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
      });

      const completedTargetGate = codexProjectAdmissionGate({
        ...input,
        deps: {
          ...deps,
          buildOverviewItems: async () => [{
            ok: true,
            jobId: "project-continuation",
            workspacePath: continuationWorkspace,
            workspaceDirty: true,
            workerAlive: false,
            activeWriterRisk: "dirty_workspace_without_worker",
            activeWriterRiskReasons: ["dirty_workspace_without_worker"],
            resultStatus: "completed",
            recommendedAction: "review_completed",
            lifecycleMarkerTypes: ["review"],
          }],
        },
        capacityContinuationTarget: {
          jobId: "project-continuation",
          workspacePath: continuationWorkspace,
        },
      });
      await expect(completedTargetGate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-continuation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: continuationWorkspace,
      })).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.UnconsumedCompletedJob,
        })],
      });

      const liveTargetGate = codexProjectAdmissionGate({
        ...input,
        deps: {
          ...deps,
          buildOverviewItems: async () => [{
            ok: true,
            jobId: "project-continuation",
            workspacePath: continuationWorkspace,
            workspaceDirty: true,
            workerAlive: true,
            activeWriterRisk: "active_worker",
            activeWriterRiskReasons: ["active worker overlaps workspace"],
          }],
        },
        capacityContinuationTarget: {
          jobId: "project-continuation",
          workspacePath: continuationWorkspace,
        },
      });
      await expect(liveTargetGate.evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-continuation",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: continuationWorkspace,
      })).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
        debt: [expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
        })],
      });
    } finally {
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
