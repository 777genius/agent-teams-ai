import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob } from "../codex-goal-jobs";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  codexProjectControlBroker,
  loadJobLaunch,
  loadProjectControlController,
} from "../codex-goal-mcp-project-control-deps";
import {
  projectControlRecordFailedNoOutputView,
} from "../codex-goal-mcp-project-control-terminal-output";
import {
  assertCodexGoalProjectJobNotTerminal,
  readCodexGoalConsumedOutputLedgers,
} from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

describe("project failed_no_output lifecycle", () => {
  it("publishes the project-scoped MCP tool", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "failed-no-output-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) =>
        tool.name === "codex_goal_project_record_failed_no_output"
      )).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("corrects empty rejected output append-only and rejects dirty workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-failed-no-output-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const worktreeRoot = join(root, "worktrees");
    const controllerWorkspace = join(root, "repo");
    const authRoot = join(root, "auth");
    const controllerJobId = "project-controller-v1";
    const freshWorkerJobId = "project-worker-fresh-v1";
    const freshDirtyWorkerJobId = "project-worker-fresh-dirty-v1";
    const workerJobId = "project-worker-v1";
    const dirtyWorkerJobId = "project-worker-dirty-v1";
    const verifierJobId = "project-verifier-v1";

    try {
      await mkdir(authRoot, { recursive: true });
      await createCleanWorkspace(controllerWorkspace);
      await createCleanWorkspace(join(worktreeRoot, freshWorkerJobId));
      await createCleanWorkspace(join(worktreeRoot, freshDirtyWorkerJobId));
      await createCleanWorkspace(join(worktreeRoot, workerJobId));
      await createCleanWorkspace(join(worktreeRoot, dirtyWorkerJobId));
      await createCleanWorkspace(join(worktreeRoot, verifierJobId));
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: controllerJobId,
        workspacePath: controllerWorkspace,
        accessBoundary: AccessBoundary.ProjectScopedControl,
        projectAccessScope: {
          projectId: "project",
          readRoots: [],
          workspaceRoots: [controllerWorkspace],
          worktreeRoots: [worktreeRoot],
          registryRoot: registryRootDir,
          consumedOutputLedgerRoots: [ledgerRoot],
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: freshWorkerJobId,
        workspacePath: join(worktreeRoot, freshWorkerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: freshDirtyWorkerJobId,
        workspacePath: join(worktreeRoot, freshDirtyWorkerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: workerJobId,
        workspacePath: join(worktreeRoot, workerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: dirtyWorkerJobId,
        workspacePath: join(worktreeRoot, dirtyWorkerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: verifierJobId,
        workspacePath: join(worktreeRoot, verifierJobId),
      });
      await writeMislabeledNoOutput({ root, ledgerRoot, jobId: workerJobId });
      await writeMislabeledNoOutput({ root, ledgerRoot, jobId: dirtyWorkerJobId });

      const deps = {
        loadProjectControlController,
        loadJobLaunch,
        codexProjectControlBroker,
      };
      const args = {
        registryRootDir,
        controllerJobId,
        jobId: workerJobId,
        terminalAttemptId: "terminalize-project-worker-v1",
        failureCategory: "infrastructure",
        failureCode: "prewarm_failed_before_task",
      };
      const freshArgs = {
        ...args,
        jobId: freshWorkerJobId,
        terminalAttemptId: "terminalize-project-worker-fresh-v1",
        failureCode: "stale_source_before_task",
      };
      await expect(projectControlRecordFailedNoOutputView(freshArgs, deps)).resolves
        .toMatchObject({
          ok: false,
          reason: "confirm_failed_no_output_required",
          sourceRecord: null,
          decisionPreview: {
            status: "failed_no_output",
            failure: {
              category: "infrastructure",
              code: "stale_source_before_task",
            },
          },
        });
      const freshRecorded = await projectControlRecordFailedNoOutputView({
        ...freshArgs,
        confirmFailedNoOutput: true,
      }, deps);
      expect(freshRecorded).toMatchObject({
        ok: true,
        mode: "project_control_record_failed_no_output",
        decision: {
          jobId: freshWorkerJobId,
          status: "failed_no_output",
          failure: {
            category: "infrastructure",
            code: "stale_source_before_task",
          },
          output: { authoredChanges: false, workspaceDirty: false },
        },
      });
      const freshDecision = freshRecorded.decision as {
        readonly archivePath: string;
        readonly backup: {
          readonly statusPath: string;
          readonly patchPath: string;
          readonly numstatPath: string;
        };
      };
      await expect(readFile(freshDecision.backup.statusPath, "utf8")).resolves.toBe("");
      await expect(readFile(freshDecision.backup.patchPath, "utf8")).resolves.toBe("");
      await expect(readFile(freshDecision.backup.numstatPath, "utf8")).resolves.toBe("");
      expect(freshDecision.archivePath).toContain(
        `${freshWorkerJobId}-failed-no-output-terminalize-project-worker-fresh-v1`,
      );
      await expect(assertCodexGoalProjectJobNotTerminal({
        roots: [ledgerRoot],
        jobId: freshWorkerJobId,
        workspacePath: join(worktreeRoot, freshWorkerJobId),
      })).rejects.toThrow(
        "project_control_terminal_job_start_denied:failed_no_output",
      );
      await expect(projectControlRecordFailedNoOutputView({
        ...freshArgs,
        confirmFailedNoOutput: true,
      }, deps)).resolves.toMatchObject({
        ok: true,
        alreadyTerminal: true,
        idempotentReplay: true,
      });
      await writeFile(
        join(worktreeRoot, freshDirtyWorkerJobId, "dirty.txt"),
        "unarchived output\n",
      );
      await expect(projectControlRecordFailedNoOutputView({
        ...freshArgs,
        jobId: freshDirtyWorkerJobId,
        terminalAttemptId: "terminalize-project-worker-fresh-dirty-v1",
        confirmFailedNoOutput: true,
      }, deps)).rejects.toThrow("failed_no_output_clean_workspace_required");
      const unadmittedPatchPath = join(
        root,
        "worker-jobs",
        freshDirtyWorkerJobId,
        "unadmitted.patch",
      );
      const unadmittedPatch = "unadmitted input patch\n";
      await writeFile(unadmittedPatchPath, unadmittedPatch);
      await expect(projectControlRecordFailedNoOutputView({
        ...freshArgs,
        jobId: freshDirtyWorkerJobId,
        terminalAttemptId: "terminalize-unadmitted-dirty-v1",
        confirmFailedNoOutput: true,
        preexistingWorkspacePatchPath: unadmittedPatchPath,
        preexistingWorkspacePatchSha256: createHash("sha256")
          .update(unadmittedPatch)
          .digest("hex"),
        confirmPreexistingWorkspacePatch: true,
      }, deps)).rejects.toThrow("project_control_pre_start_admission_required");

      await expect(projectControlRecordFailedNoOutputView(args, deps)).resolves
        .toMatchObject({
          ok: false,
          reason: "confirm_failed_no_output_required",
        });
      const recorded = await projectControlRecordFailedNoOutputView({
        ...args,
        confirmFailedNoOutput: true,
      }, deps);
      expect(recorded).toMatchObject({
        ok: true,
        mode: "project_control_record_failed_no_output",
        decision: {
          status: "failed_no_output",
          output: { authoredChanges: false, workspaceDirty: false },
        },
      });
      await expect(readFile(String(recorded.ledgerPath), "utf8")).resolves
        .toContain('"status": "failed_no_output"');

      const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot] });
      expect(ledger.byJobId.get(workerJobId)).toMatchObject({
        status: "failed_no_output",
        valid: true,
      });
      await expect(projectControlRecordFailedNoOutputView({
        ...args,
        confirmFailedNoOutput: true,
      }, deps)).resolves.toMatchObject({
        ok: true,
        alreadyTerminal: true,
        idempotentReplay: true,
      });

      await writeFile(
        join(worktreeRoot, dirtyWorkerJobId, "dirty.txt"),
        "not authored evidence\n",
      );
      await expect(projectControlRecordFailedNoOutputView({
        ...args,
        jobId: dirtyWorkerJobId,
        terminalAttemptId: "terminalize-project-worker-dirty-v1",
        confirmFailedNoOutput: true,
      }, deps)).rejects.toThrow("failed_no_output_clean_workspace_required");

      const baseline = await writeBaselineFailedNoOutput({
        root,
        ledgerRoot,
        jobId: verifierJobId,
      });
      await writeFile(join(worktreeRoot, verifierJobId, "README.md"), "producer output\n");
      const verifierArgs = {
        ...args,
        jobId: verifierJobId,
        terminalAttemptId: "terminalize-project-verifier-v1",
        confirmFailedNoOutput: true,
        preexistingWorkspacePatchPath: baseline.path,
        preexistingWorkspacePatchSha256: baseline.sha256,
      };
      await expect(projectControlRecordFailedNoOutputView(verifierArgs, deps)).resolves
        .toMatchObject({
          ok: false,
          reason: "confirm_preexisting_workspace_patch_required",
        });
      const verifierRecorded = await projectControlRecordFailedNoOutputView({
        ...verifierArgs,
        confirmPreexistingWorkspacePatch: true,
      }, deps);
      expect(verifierRecorded).toMatchObject({
        ok: true,
        decision: {
          status: "failed_no_output",
          preexistingWorkspacePatch: {
            sha256: baseline.sha256,
          },
        },
      });
      const verifierDecision = verifierRecorded.decision as {
        readonly backup: { readonly statusPath: string };
        readonly preexistingWorkspacePatch: {
          readonly path: string;
          readonly sha256: string;
        };
      };
      expect(verifierDecision.preexistingWorkspacePatch.path).not.toBe(baseline.path);
      expect(verifierDecision.preexistingWorkspacePatch.path).toBe(
        join(
          dirname(verifierDecision.backup.statusPath),
          "preexisting-workspace.patch",
        ),
      );
      await expect(
        readFile(verifierDecision.preexistingWorkspacePatch.path, "utf8"),
      ).resolves.toBe("diff --git a/README.md b/README.md\n");
      const reconciled = await readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot] });
      expect(reconciled.byJobId.get(verifierJobId)).toMatchObject({
        status: "failed_no_output",
        preexistingWorkspacePatchValid: true,
        valid: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createCleanWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await gitInitRepository(path);
  await writeFile(join(path, "README.md"), "base\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "test: base"]);
}

async function writeBaselineFailedNoOutput(input: {
  readonly root: string;
  readonly ledgerRoot: string;
  readonly jobId: string;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  const evidenceRoot = join(
    input.root,
    "worker-jobs",
    "archives",
    `${input.jobId}-failed-test`,
  );
  const workspace = join(input.root, "worktrees", input.jobId);
  await mkdir(join(input.ledgerRoot, "items"), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const statusPath = join(evidenceRoot, "git-status.txt");
  const patchPath = join(evidenceRoot, "verifier-output.patch");
  const baselinePath = join(
    input.root,
    "worker-jobs",
    input.jobId,
    "producer-output.patch",
  );
  const baseline = "diff --git a/README.md b/README.md\n";
  const baselineSha256 = createHash("sha256").update(baseline).digest("hex");
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(statusPath, " M README.md\n");
  await writeFile(patchPath, "");
  await writeFile(baselinePath, baseline);
  await writeFile(
    join(input.ledgerRoot, "items", `${input.jobId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: input.jobId,
      status: "failed_no_output",
      closedAt: "2026-07-13T20:00:00.000Z",
      failure: { category: "infrastructure", code: "terminal_result_missing" },
      output: { authoredChanges: false, workspaceDirty: false },
      preexistingWorkspacePatch: {
        path: baselinePath,
        sha256: baselineSha256,
      },
      note: "Verifier failed after the producer patch was applied.",
      backup: { workspace, statusPath, patchPath },
    }, null, 2)}\n`,
  );
  return {
    path: baselinePath,
    sha256: baselineSha256,
  };
}

async function createStoredJob(input: {
  readonly registryRootDir: string;
  readonly root: string;
  readonly authRoot: string;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly accessBoundary?: AccessBoundary;
  readonly projectAccessScope?: {
    readonly projectId: string;
    readonly readRoots: readonly string[];
    readonly workspaceRoots: readonly string[];
    readonly worktreeRoots: readonly string[];
    readonly registryRoot: string;
    readonly consumedOutputLedgerRoots: readonly string[];
    readonly jobIdPrefixes: readonly string[];
    readonly tmuxSessionPrefixes: readonly string[];
    readonly allowedAccountIds: readonly string[];
  };
}): Promise<void> {
  const jobRootDir = join(input.root, "worker-jobs", input.jobId);
  await mkdir(jobRootDir, { recursive: true });
  await writeFile(join(jobRootDir, "prompt.md"), "test prompt\n");
  await createCodexGoalJob({
    registryRootDir: input.registryRootDir,
    manifest: {
      jobId: input.jobId,
      jobRootDir,
      authRootDir: input.authRoot,
      workspacePath: input.workspacePath,
      promptPath: join(jobRootDir, "prompt.md"),
      taskId: input.jobId,
      accounts: ["account-a"],
      ...(input.accessBoundary ? { accessBoundary: input.accessBoundary } : {}),
      ...(input.projectAccessScope
        ? { projectAccessScope: input.projectAccessScope }
        : {}),
      networkAccess: NetworkAccessMode.Restricted,
    },
  });
}

async function writeMislabeledNoOutput(input: {
  readonly root: string;
  readonly ledgerRoot: string;
  readonly jobId: string;
}): Promise<void> {
  const evidenceRoot = join(
    input.root,
    "worker-jobs",
    "archives",
    `${input.jobId}-rejected-test`,
  );
  const workspace = join(input.root, "worktrees", input.jobId);
  await mkdir(join(input.ledgerRoot, "items"), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const statusPath = join(evidenceRoot, "git-status.txt");
  const patchPath = join(evidenceRoot, "worker-output.patch");
  const numstatPath = join(evidenceRoot, "tracked.numstat");
  await writeFile(statusPath, "");
  await writeFile(patchPath, "");
  await writeFile(numstatPath, "");
  await writeFile(
    join(input.ledgerRoot, "items", `${input.jobId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: input.jobId,
      status: "rejected",
      closedAt: "2026-07-13T20:00:00.000Z",
      note: "Incorrectly classified infrastructure failure.",
      backup: { workspace, statusPath, patchPath, numstatPath },
    }, null, 2)}\n`,
  );
}
