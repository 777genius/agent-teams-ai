import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const workerJobId = "project-worker-v1";
    const dirtyWorkerJobId = "project-worker-dirty-v1";

    try {
      await mkdir(authRoot, { recursive: true });
      await createCleanWorkspace(controllerWorkspace);
      await createCleanWorkspace(join(worktreeRoot, workerJobId));
      await createCleanWorkspace(join(worktreeRoot, dirtyWorkerJobId));
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: controllerJobId,
        workspacePath: controllerWorkspace,
        accessBoundary: AccessBoundary.ProjectScopedControl,
        projectAccessScope: {
          projectId: "project",
          readRoots: [root],
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
  const evidenceRoot = join(input.root, "evidence", input.jobId);
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
