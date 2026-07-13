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
  it("lets a project-scoped controller create an isolated child job through broker policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-control-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });

      expect(created).toMatchObject({
        ok: true,
        mode: "project_control_create_job",
        controllerJobId: "infinity-context-controller-v1",
        manifest: {
          jobId: "infinity-context-child-v1",
          accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
          networkAccess: NetworkAccessMode.Restricted,
          tags: expect.arrayContaining(["worker-role-reviewer"]),
          projectAccessScope: {
            projectId: "infinity-context",
            isolatedWorkspaceRoot: childWorkspace,
            workspaceRoots: [childWorkspace],
          },
        },
      });
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(audit.some((event) => auditDecision(event).allowed === true)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults project-control child jobs to the ready account pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-accounts-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });
      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: new Date().toISOString(),
      });

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a", "account-b"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        confirmCreate: true,
      });

      expect(created).toMatchObject({
        ok: true,
        manifest: {
          accounts: ["account-a", "account-b"],
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs project child manifest accounts through the brokered repair tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-manifest-repair-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a", "account-b"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        confirmCreate: true,
      });
      expect(created).toMatchObject({
        ok: true,
        manifest: { accounts: ["account-a"] },
      });

      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: new Date().toISOString(),
      });
      const preview = await callToolJson(client, "brokered_project_manifest_repair", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
      });
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_repair_required",
        proposedPatch: { accounts: ["account-a", "account-b"] },
      });

      const repaired = await callToolJson(client, "brokered_project_manifest_repair", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        confirmRepair: true,
      });
      expect(repaired).toMatchObject({
        ok: true,
        manifest: { accounts: ["account-a", "account-b"] },
      });

      const denied = await callToolJson(client, "brokered_project_manifest_repair", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        accounts: ["account-c"],
        confirmRepair: true,
      });
      expect(denied).toMatchObject({
        ok: false,
        error: "project_control_repair_account_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates controller consumed-output ledger roots through scoped repair only", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-scope-repair-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const controlRoot = join(root, "control");
    const ledgerRoot = join(controlRoot, "dirty-worktree-drain");
    const baseScope = {
      projectId: "infinity-context",
      readRoots: [controlRoot, join(root, "workspaces")],
      workspaceRoots: [join(root, "workspaces")],
      worktreeRoots: [join(root, "worktrees")],
      registryRoot: registryRootDir,
      deniedRoots: [join(root, "secrets")],
      jobIdPrefixes: ["infinity-context-"],
      tmuxSessionPrefixes: ["infinity-context-"],
      allowedAccountIds: ["account-a"],
    };
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: baseScope,
      });

      const proposedScope = {
        ...baseScope,
        consumedOutputLedgerRoots: [ledgerRoot],
      };
      const preview = await callToolJson(
        client,
        "codex_goal_project_update_controller_scope",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          projectAccessScope: proposedScope,
        },
      );
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_update_required",
        proposedConsumedOutputLedgerRoots: [ledgerRoot],
      });

      const updated = await callToolJson(
        client,
        "codex_goal_project_update_controller_scope",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          projectAccessScope: proposedScope,
          confirmUpdate: true,
        },
      );
      expect(updated).toMatchObject({
        ok: true,
        manifest: {
          projectAccessScope: {
            consumedOutputLedgerRoots: [ledgerRoot],
          },
        },
      });

      const widened = await callToolJson(
        client,
        "codex_goal_project_update_controller_scope",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          projectAccessScope: {
            ...proposedScope,
            readRoots: [...baseScope.readRoots, "/outside"],
          },
          confirmUpdate: true,
        },
      );
      expect(widened).toMatchObject({
        ok: false,
        error: "project_control_scope_readRoots_repair_denied",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic start for project-scoped controller jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-generic-start-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const result = await callToolJson(client, "codex_goal_start", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
        confirmStart: true,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_controller_start",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic updates for project-owned job manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-generic-update-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_update_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        description: "operator mutation should be brokered",
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "brokered_project_manifest_repair",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic child creation when an existing controller owns the scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-generic-child-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
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

      const result = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-child-v1",
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        controllerJobId: "infinity-context-controller-v1",
        requiredTool: "codex_goal_project_create_job",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic lifecycle for legacy project-like jobs after controller adoption", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-legacy-generic-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const legacyWorkspace = join(root, "worktrees", "infinity-context-memory-legacy-v1");
    const legacyJobRoot = join(root, "worker-jobs", "infinity-context-memory-legacy-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        jobRootDir: legacyJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: legacyWorkspace,
        promptPath: join(legacyJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-legacy-v1",
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });
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

      const update = await callToolJson(client, "codex_goal_update_job", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        description: "legacy mutation should go through broker",
      });
      expect(update).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "brokered_project_manifest_repair",
      });
      const continued = await callToolJson(client, "codex_goal_continue", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        confirmContinue: true,
      });
      expect(continued).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_start",
      });
      const reviewed = await callToolJson(client, "codex_goal_mark_reviewed", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
      });
      expect(reviewed).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_mark_reviewed",
      });
      const reconciled = await callToolJson(client, "codex_goal_reconcile_result", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        forceWrite: true,
      });
      expect(reconciled).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_mark_reviewed",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies project start when an existing child manifest uses an account outside scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-start-account-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-child-v1");
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
      await writeFile(join(sourceWorkspacePath, "package.json"), JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
        },
      }));
      await writeFile(join(sourceWorkspacePath, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }));
      await git(sourceWorkspacePath, ["add", "README.md", "package.json", "package-lock.json"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await mkdir(childWorkspace, { recursive: true });
      await gitInitRepository(childWorkspace);
      await writeFile(join(childWorkspace, "README.md"), "child\n");
      await git(childWorkspace, ["add", "README.md"]);
      await git(childWorkspace, ["commit", "-m", "test: child base"]);
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, "prompt.md"), "child task\n");

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-child-v1",
        accounts: ["account-b"],
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          isolatedWorkspaceRoot: childWorkspace,
          workspaceRoots: [childWorkspace],
        },
      });
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

      await expect(callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-child-v1",
        confirmStart: true,
        skipDoctor: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:account_denied",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies project start when a child workspace symlink resolves outside scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-start-symlink-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-child-v1");
    const outsideChildTarget = join(root, "outside-project", "infinity-context-memory-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-child-v1");
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
      await mkdir(outsideChildTarget, { recursive: true });
      await gitInitRepository(outsideChildTarget);
      await writeFile(join(outsideChildTarget, "README.md"), "outside\n");
      await git(outsideChildTarget, ["add", "README.md"]);
      await git(outsideChildTarget, ["commit", "-m", "test: outside base"]);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await symlink(outsideChildTarget, childWorkspace, "dir");
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, "prompt.md"), "child task\n");

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-child-v1",
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });
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

      await expect(callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-child-v1",
        confirmStart: true,
        skipDoctor: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_workspace_real_path_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
