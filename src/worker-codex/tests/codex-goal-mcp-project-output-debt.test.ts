import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  LocalFileRunEventStore,
  LocalFileWorkerAccountCapacityStore,
  LocalFileWorkerControlInboxStore,
  LocalControlledAgentStateStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  AccessBoundary,
  ControlledAgentProcessOwnerKind,
  ControlledAgentRunStatus,
  InMemoryActiveAttemptRegistry,
  NetworkAccessMode,
  ProjectControlAuditEventType,
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
  projectScopedControllerToolNames,
  type WorkerControlDeliveryReceipt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexGoalBrief,
  createCodexGoalMcpServer,
  projectControllerPendingGuidancePromptContext,
} from "../codex-goal-mcp";
import {
  auditDecision,
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
  hasTmux,
  policyAuditDecisions,
  readProjectControlAudit,
  removeStoredTmuxSession,
  workerControlReceipt,
  writeClaudeRunArtifacts,
  writeFakeAuth,
} from "./codex-goal-mcp-test-support";

const execFileAsync = promisify(execFile);

describe("codex goal MCP server", () => {
  it("blocks producer refill but allows reviewer drain when orphan dirty output exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-admission-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const legacyWorkspaceRoot = join(root, "legacy-workspaces");
    const realLegacyWorkspaceRoot = join(root, "real-legacy-workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const orphanWorkspace = join(realLegacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const observedOrphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const linkedOrphanTarget = join(root, "linked-workspaces", "infinity-context-memory-linked-target-v1");
    const linkedOrphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-linked-v1");
    const brokenWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-broken-v1");
    const producerWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const reviewerWorkspace = join(root, "worktrees", "infinity-context-memory-reviewer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");
      await mkdir(legacyWorkspaceRoot, { recursive: true });
      await symlink(orphanWorkspace, observedOrphanWorkspace);
      await mkdir(linkedOrphanTarget, { recursive: true });
      await gitInitRepository(linkedOrphanTarget);
      await writeFile(join(linkedOrphanTarget, "linked.py"), "value = 1\n");
      await git(linkedOrphanTarget, ["add", "linked.py"]);
      await git(linkedOrphanTarget, ["commit", "-m", "test: linked orphan base"]);
      await writeFile(join(linkedOrphanTarget, "linked.py"), "value = 2\n");
      await symlink(linkedOrphanTarget, linkedOrphanWorkspace, "dir");
      await mkdir(brokenWorkspace, { recursive: true });
      await writeFile(
        join(brokenWorkspace, ".git"),
        `gitdir: ${join(root, "missing-gitdir")}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [legacyWorkspaceRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: false,
          reason: "output_debt_present",
        },
        snapshot: {
          counts: {
            orphanLegacyWorkspaces: 2,
            unreadableWorkspaces: 1,
          },
        },
      });

      const producer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-producer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: producerWorkspace,
        promptPath: join(root, "worker-jobs", "infinity-context-memory-producer-v1", "prompt.md"),
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(producer).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      const directProducer = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-direct-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-direct-producer-v1"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", "infinity-context-memory-direct-producer-v1"),
        promptPath: join(
          root,
          "worker-jobs",
          "infinity-context-memory-direct-producer-v1",
          "prompt.md",
        ),
        taskId: "infinity-context-memory-direct-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        confirmCreate: true,
      });
      expect(directProducer).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      await expect(access(
        join(root, "worker-jobs", "registry", "infinity-context-memory-direct-producer-v1"),
      )).rejects.toThrow();
      const directWorktreePath = join(
        root,
        "worktrees",
        "infinity-context-memory-direct-worktree-v1",
      );
      const directWorktree = await callToolJson(
        client,
        "codex_goal_project_create_worktree",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          sourceWorkspacePath,
          path: directWorktreePath,
          baseBranch: "origin/main",
          workerRole: "producer",
          confirmCreateWorktree: true,
        },
      );
      expect(directWorktree).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      await expect(access(directWorktreePath)).rejects.toThrow();

      const reviewer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-reviewer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: reviewerWorkspace,
        promptPath: join(root, "worker-jobs", "infinity-context-memory-reviewer-v1", "prompt.md"),
        promptBody: "Review and drain old memory output.\n",
        taskId: "infinity-context-memory-reviewer-v1",
        accounts: ["account-a"],
        workerRole: "reviewer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(reviewer).toMatchObject({
        ok: true,
        workerRole: "reviewer",
        startSkipped: true,
      });

      const legacyTarget = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-legacy-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-reviewer-legacy-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: join(legacyWorkspaceRoot, "infinity-context-memory-reviewer-legacy-v1"),
        promptPath: join(
          root,
          "worker-jobs",
          "infinity-context-memory-reviewer-legacy-v1",
          "prompt.md",
        ),
        promptBody: "Review and drain old memory output.\n",
        taskId: "infinity-context-memory-reviewer-legacy-v1",
        accounts: ["account-a"],
        workerRole: "reviewer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(legacyTarget).toMatchObject({
        ok: false,
        error: "project_control_denied:path_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits producer refill when dirty legacy output has valid consumed ledger evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-consumed-output-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const legacyWorkspaceRoot = join(root, "legacy-workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const orphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const ledgerRoot = join(root, "dirty-worktree-drain");
    const backupRoot = join(root, "dirty-worktree-backups");
    const producerWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");

      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const statusPath = join(backupRoot, "infinity-context-memory-old-v1.status.txt");
      const patchPath = join(backupRoot, "infinity-context-memory-old-v1.patch");
      await writeFile(statusPath, " M memory.py\n");
      await writeFile(patchPath, "diff --git a/memory.py b/memory.py\n");
      await writeFile(
        join(ledgerRoot, "items", "infinity-context-memory-old-v1.json"),
        `${JSON.stringify({
          jobId: "infinity-context-memory-old-v1",
          status: "duplicate",
          closedAt: "2026-07-06T00:00:00.000Z",
          backup: {
            workspace: orphanWorkspace,
            statusPath,
            patchPath,
          },
        }, null, 2)}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [legacyWorkspaceRoot],
          consumedOutputLedgerRoots: [ledgerRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: true,
          reason: "allowed",
          debt: [],
          detailsIncluded: false,
        },
        snapshot: {
          counts: {
            orphanLegacyWorkspaces: 0,
            consumedDirtyWorkspaces: 1,
            incompleteConsumedOutputRecords: 0,
          },
          debt: [],
          debtCount: 1,
          debtOmittedCount: 1,
          detailsIncluded: false,
        },
      });

      const detailedSnapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
          includeDetails: true,
          maxDebtItems: 1,
        },
      );
      expect(detailedSnapshot).toMatchObject({
        ok: true,
        snapshot: {
          debtCount: 1,
          debtOmittedCount: 0,
          detailsIncluded: true,
          debt: [{
            reason: "consumed_dirty_workspace",
          }],
        },
      });

      const producer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-producer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: producerWorkspace,
        promptPath: join(root, "worker-jobs", "infinity-context-memory-producer-v1", "prompt.md"),
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(producer).toMatchObject({
        ok: true,
        workerRole: "producer",
        startSkipped: true,
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts consumed registry jobs without requiring live overview status", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-consumed-registry-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const retiredWorkspace = join(root, "worktrees", "infinity-context-memory-retired-v1");
    const retiredJobRoot = join(root, "worker-jobs", "infinity-context-memory-retired-v1");
    const ledgerRoot = join(root, "dirty-worktree-drain");
    const backupRoot = join(root, "dirty-worktree-backups");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const statusPath = join(backupRoot, "infinity-context-memory-retired-v1.status.txt");
      const patchPath = join(backupRoot, "infinity-context-memory-retired-v1.patch");
      await writeFile(statusPath, " M memory.py\n");
      await writeFile(patchPath, "diff --git a/memory.py b/memory.py\n");
      await writeFile(
        join(ledgerRoot, "items", "infinity-context-memory-retired-v1.json"),
        `${JSON.stringify({
          jobId: "infinity-context-memory-retired-v1",
          status: "archived",
          closedAt: "2026-07-06T00:00:00.000Z",
          backup: {
            workspace: retiredWorkspace,
            statusPath,
            patchPath,
          },
        }, null, 2)}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          consumedOutputLedgerRoots: [ledgerRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      const retiredJob = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-retired-v1",
        jobRootDir: retiredJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: retiredWorkspace,
        promptPath: join(retiredJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-retired-v1",
        accounts: ["account-a"],
        tags: ["worker-role-producer"],
        workerRole: "producer",
        confirmCreate: true,
      });
      expect(retiredJob).toMatchObject({ ok: true });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: true,
          reason: "allowed",
        },
        snapshot: {
          counts: {
            consumedDirtyWorkspaces: 1,
            incompleteConsumedOutputRecords: 0,
          },
          debtCount: 1,
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks producer refill when terminal consumed ledger evidence is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-incomplete-output-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const legacyWorkspaceRoot = join(root, "legacy-workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const orphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const ledgerRoot = join(root, "dirty-worktree-drain");
    const backupRoot = join(root, "dirty-worktree-backups");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");

      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const statusPath = join(backupRoot, "infinity-context-memory-old-v1.status.txt");
      await writeFile(statusPath, " M memory.py\n");
      await writeFile(
        join(ledgerRoot, "items", "infinity-context-memory-old-v1.json"),
        `${JSON.stringify({
          jobId: "infinity-context-memory-old-v1",
          status: "duplicate",
          closedAt: "2026-07-06T00:00:00.000Z",
          backup: {
            workspace: orphanWorkspace,
            statusPath,
          },
          notes: [{ status: "duplicate", text: "output already represented" }],
        }, null, 2)}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [legacyWorkspaceRoot],
          consumedOutputLedgerRoots: [ledgerRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: false,
          reason: "output_debt_present",
        },
        snapshot: {
          counts: {
            orphanLegacyWorkspaces: 0,
            consumedDirtyWorkspaces: 0,
            incompleteConsumedOutputRecords: 1,
          },
        },
      });

      const producer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-producer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: join(root, "worktrees", "infinity-context-memory-producer-v1"),
        promptPath: join(root, "worker-jobs", "infinity-context-memory-producer-v1", "prompt.md"),
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(producer).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
