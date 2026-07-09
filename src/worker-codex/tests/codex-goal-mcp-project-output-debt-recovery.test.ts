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
  it("rolls back a newly created refill worktree when prompt materialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-refill-rollback-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-producer-v1");
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
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, "prompt.md"), "old prompt\n");

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
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "new prompt\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("project_control_existing_prompt_mismatch"),
      });

      await expect(access(childWorkspace)).rejects.toThrow();
      await expect(readFile(join(childJobRoot, "prompt.md"), "utf8")).resolves.toBe(
        "old prompt\n",
      );
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the original refill error when rollback removes an empty job root", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-refill-rollback-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-producer-v1");
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
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-b"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });

      expect(result).toMatchObject({ ok: false });
      expect(String(result.error ?? result.reason ?? "")).toContain("project_control");
      expect(String(result.error ?? result.reason ?? "")).not.toContain("EISDIR");
      await expect(access(childWorkspace)).rejects.toThrow();
      await expect(access(join(childJobRoot, "prompt.md"))).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks stored producer start when output debt appears after job creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-admission-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const observedWorkspaceRoot = join(root, "legacy-workspaces");
    const orphanWorkspace = join(observedWorkspaceRoot, "infinity-context-memory-old-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-producer-v1");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
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
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [observedWorkspaceRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        tmuxSession: "infinity-context-memory-producer-v1",
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      })).resolves.toMatchObject({
        ok: true,
        startSkipped: true,
      });

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");

      const start = await callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        forceStart: true,
        confirmStart: true,
      });
      expect(start).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(audit.some((event) =>
        event.type === ProjectControlAuditEventType.AdmissionDecisionRecorded &&
        auditDecision(event).allowed === false
      )).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to start a stored project worker when its prompt file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-no-prompt-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-reviewer-v1");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-reviewer-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
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
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await expect(callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Review memory output.\n",
        taskId: "infinity-context-memory-reviewer-v1",
        accounts: ["account-a"],
        tmuxSession: "infinity-context-memory-reviewer-v1",
        workerRole: "reviewer",
        startWorker: false,
        confirmRefill: true,
      })).resolves.toMatchObject({ ok: true });
      await rm(join(childJobRoot, "prompt.md"), { force: true });

      await expect(callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-v1",
        forceStart: true,
        confirmStart: true,
      })).resolves.toMatchObject({
        ok: false,
        reason: "project_control_prompt_missing_before_start",
        mode: "project_control_start",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
