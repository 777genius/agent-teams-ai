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

describe("codex goal MCP project-control server", () => {
  it("builds a fail-closed controlled-agent launch plan for project controllers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-plan-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
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
        workspacePath: join(root, "workspaces", "controller"),
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

      const defaultPlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
        },
      );
      expect(defaultPlan).toMatchObject({
        ok: true,
        mode: "project_controller_launch_plan",
        controllerJobId: "infinity-context-controller-v1",
        status: "ready",
        rawShellMode: "disabled-by-provider",
      });
      expect(defaultPlan.allowedTools).toEqual(projectScopedControllerToolNames());

      const denyOnlyPlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          rawShellMode: "sandboxed-deny-rules-only",
        },
      );
      expect(denyOnlyPlan).toMatchObject({
        ok: false,
        mode: "project_controller_launch_plan",
        controllerJobId: "infinity-context-controller-v1",
        status: "blocked",
        reason: "provider_cannot_disable_raw_shell",
      });

      const readyPlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          rawShellMode: "disabled-by-provider",
          stateDir: join(root, "controller-state"),
          mcpArgs: ["--stdio"],
        },
      );
      expect(readyPlan).toMatchObject({
        ok: true,
        mode: "project_controller_launch_plan",
        controllerJobId: "infinity-context-controller-v1",
        status: "ready",
        rawShellMode: "disabled-by-provider",
        session: {
          identity: {
            controllerJobId: "infinity-context-controller-v1",
            projectId: "infinity-context",
          },
        },
      });
      expect(readyPlan.allowedTools).toEqual(projectScopedControllerToolNames());
      expect(String(readyPlan.configToml)).toContain("enabled_tools");
      expect(String(readyPlan.configToml)).not.toContain("danger-full-access");
      expect(String(readyPlan.rulesText)).toContain('pattern = ["git"]');

      const claudePlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          providerKind: "claude",
          stateDir: join(root, "controller-state"),
          mcpArgs: ["--stdio"],
        },
      );
      expect(claudePlan).toMatchObject({
        ok: true,
        mode: "project_controller_launch_plan",
        providerKind: "claude",
        controllerJobId: "infinity-context-controller-v1",
        sessionId: "infinity-context-controller-v1:controlled-agent:claude",
        status: "ready",
        strictMcpConfig: true,
      });
      expect((claudePlan.allowedTools as readonly string[]).every((tool) =>
        tool.startsWith("mcp__subscription_runtime_project_control__")
      )).toBe(true);
      expect(claudePlan.disallowedTools).toEqual(
        expect.arrayContaining(["Bash", "Edit", "Write", "Read"]),
      );

      const blockedStart = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
        },
      );
      expect(blockedStart).toMatchObject({
        ok: false,
        error: "project_control_controller_auth_root_scope_required",
      });

      const blockedWithoutScopedAuth = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          rawShellMode: "disabled-by-provider",
          stateDir: join(root, "controller-state"),
        },
      );
      expect(blockedWithoutScopedAuth).toMatchObject({
        ok: false,
        error: "project_control_controller_auth_root_scope_required",
      });

      const missingStatus = await callToolJson(
        client,
        "codex_goal_project_controller_status",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          stateDir: join(root, "controller-state"),
        },
      );
      expect(missingStatus).toMatchObject({
        ok: false,
        mode: "project_controller_status",
        reason: "session_missing",
        liveController: {
          providerRunnerAttached: false,
          live: false,
          ownerMatches: false,
        },
      });

      const stateDir = join(root, "controller-state");
      const sessionId = "infinity-context-controller-v1:controlled-agent";
      const store = new LocalControlledAgentStateStore({ rootDir: stateDir });
      const owner = {
        schemaVersion: 1 as const,
        ownerId: "old-owner",
        kind: ControlledAgentProcessOwnerKind.DurableMcp,
        pid: 1111,
        hostname: "old-host",
        runtimeVersion: "0.1.0-old",
        runtimeSha: "old-sha",
        startedAt: "2026-07-05T10:00:00.000Z",
        heartbeatAt: "2026-07-05T10:00:00.000Z",
      };
      await store.saveSession({
        schemaVersion: 1,
        sessionId,
        identity: {
          controllerJobId: "infinity-context-controller-v1",
          projectId: "infinity-context",
          providerKind: RunEventProviderKind.Codex,
        },
        stateDir,
        status: ControlledAgentRunStatus.Running,
        activeRunId: "run-old",
        owner,
        createdAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:00:00.000Z",
        toolSurface: {
          boundary: AccessBoundary.ProjectScopedControl,
          allowedTools: [],
          deniedRawCapabilities: [],
        },
      });
      await store.saveRun({
        schemaVersion: 1,
        runId: "run-old",
        sessionId,
        controllerJobId: "infinity-context-controller-v1",
        providerKind: RunEventProviderKind.Codex,
        status: ControlledAgentRunStatus.Running,
        owner,
        startedAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:00:00.000Z",
      });

      const persistedOnlyStatus = await callToolJson(
        client,
        "codex_goal_project_controller_status",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          stateDir,
        },
      );
      expect(persistedOnlyStatus).toMatchObject({
        ok: true,
        mode: "project_controller_status",
        reason: "provider_status_unavailable",
        liveController: {
          providerRunnerAttached: false,
          live: false,
          ownerMatches: false,
          persistedOwner: {
            ownerId: "old-owner",
            runtimeSha: "old-sha",
          },
          persistedStatus: "running",
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets project controllers consume only their own pending guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-guidance-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
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

      const controllerCreate = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: join(root, "workspaces", "controller"),
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
          authRoot: authRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      expect(controllerCreate).toMatchObject({ ok: true });
      const childCreate = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        workspacePath: join(root, "worktrees", "infinity-context-child-v1"),
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        logPath: join(childJobRoot, "infinity-context-child-v1.log"),
        confirmCreate: true,
      });
      expect(childCreate).toMatchObject({
        ok: true,
        manifest: { jobRootDir: childJobRoot, authRootDir },
      });

      await callToolJson(client, "codex_goal_control_enqueue", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        intent: "guidance",
        body: "Stop spawning broad feature-owned workers; drain memory backlog first.",
        idempotencyKey: "controller-memory-guidance",
      });
      await callToolJson(client, "codex_goal_control_enqueue", {
        registryRootDir,
        jobId: "infinity-context-child-v1",
        intent: "guidance",
        body: "Child worker guidance must remain pending.",
        idempotencyKey: "child-guidance",
      });

      const consumed = await callToolJson(
        client,
        "codex_goal_project_controller_consume_guidance",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          deliveryAttemptId: "controller-loop-1",
        },
      );

      expect(consumed).toMatchObject({
        ok: true,
        mode: "project_controller_consume_guidance",
        controllerJobId: "infinity-context-controller-v1",
        deliveryAttemptId: "controller-loop-1",
        consumedCount: 1,
        decision: {
          pendingCount: 0,
          deliverableCount: 0,
        },
      });
      expect(String(consumed.message)).toContain("drain memory backlog first");

      const controllerSignals = await callToolJson(client, "codex_goal_control_list", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
      });
      expect(controllerSignals.signals).toMatchObject([
        {
          state: "delivered",
          latestReceipt: {
            state: "delivered",
            deliveryAttemptId: "controller-loop-1",
          },
        },
      ]);

      const childDecision = await callToolJson(client, "codex_goal_control_decision", {
        registryRootDir,
        jobId: "infinity-context-child-v1",
      });
      expect(childDecision).toMatchObject({
        ok: true,
        decision: {
          pendingCount: 1,
          deliverableCount: 1,
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a Claude project controller lacks a scoped session artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-claude-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const authRootDir = join(root, "auth");
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
        authRootDir,
        workspacePath: join(root, "workspaces", "controller"),
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
          authRoot: authRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const missingPath = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          providerKind: "claude",
        },
      );
      expect(missingPath).toMatchObject({
        ok: false,
        error: "project_control_controller_session_artifact_path_required",
      });

      const outsidePath = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          providerKind: "claude",
          sessionArtifactPath: join(root, "outside-session.json"),
        },
      );
      expect(outsidePath).toMatchObject({
        ok: false,
        error: "project_control_controller_session_artifact_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects project-control child jobs outside controller job and account scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-deny-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
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
        workspacePath: join(root, "workspaces", "controller"),
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

      const foreignJob = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "quanta-child-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-disguised"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", "infinity-context-disguised"),
        promptPath: join(root, "worker-jobs", "infinity-context-disguised", "prompt.md"),
        taskId: "quanta-child-v1",
        accounts: ["account-a"],
        tmuxSession: "infinity-context-disguised",
        confirmCreate: true,
      });
      expect(foreignJob).toMatchObject({
        ok: false,
        error: "project_control_denied:job_prefix_denied",
      });

      const foreignAccount = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-account-denied-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-account-denied-v1"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", "infinity-context-account-denied-v1"),
        promptPath: join(root, "worker-jobs", "infinity-context-account-denied-v1", "prompt.md"),
        taskId: "infinity-context-account-denied-v1",
        accounts: ["account-b"],
        confirmCreate: true,
      });
      expect(foreignAccount).toMatchObject({
        ok: false,
        error: "project_control_denied:account_denied",
      });

      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(policyAuditDecisions(audit).map((decision) => decision.reason)).toEqual([
        "job_prefix_denied",
        "allowed",
        "account_denied",
      ]);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs project-scoped worktree, integration and push operations through broker policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-git-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const worktreePath = join(root, "worktrees", "infinity-context-integration");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "base.txt"), "base\n");
      await git(sourceWorkspacePath, ["add", "base.txt"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, ["branch", "integration-target"]);
      await git(sourceWorkspacePath, ["checkout", "-b", "feature/source-change"]);
      await writeFile(join(sourceWorkspacePath, "feature.txt"), "feature\n");
      await git(sourceWorkspacePath, ["add", "feature.txt"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: feature"]);
      const commitSha = await gitStdout(sourceWorkspacePath, ["rev-parse", "HEAD"]);
      await git(sourceWorkspacePath, ["checkout", "main"]);
      await execFileAsync("git", ["init", "--bare", remotePath]);
      await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);

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
          allowedBranches: ["integration-target"],
          allowedGitRemotes: ["origin"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_create_worktree", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        sourceWorkspacePath,
        path: worktreePath,
        baseBranch: "integration-target",
        confirmCreateWorktree: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_control_create_worktree",
      });

      await expect(callToolJson(client, "codex_goal_project_integrate_commit", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        commitSha: commitSha.trim(),
        confirmIntegrate: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_control_integrate_commit",
      });

      await expect(callToolJson(client, "codex_goal_project_push_branch", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        remote: "origin",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_control_push_branch",
        result: {
          status: "applied",
          outcome: "fast_forwarded",
          localCommit: commitSha.trim(),
          remoteCommitAfter: commitSha.trim(),
        },
      });

      await expect(callToolJson(client, "codex_goal_project_push_branch", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        remote: "upstream",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:remote_denied",
      });

      await expect(callToolJson(client, "codex_goal_project_push_branch", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        remote: "origin",
        force: true,
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:force_push_denied",
      });

      const pushedSha = await execFileAsync("git", [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/integration-target",
      ]);
      expect(pushedSha.stdout.trim()).toBe(commitSha.trim());
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(policyAuditDecisions(audit).map((decision) => decision.operation)).toEqual([
        "create_worktree",
        "create_worktree",
        "integrate_commit",
        "push_branch",
        "push_branch",
        "push_branch",
      ]);
      expect(policyAuditDecisions(audit).map((decision) => decision.reason)).toEqual([
        "allowed",
        "allowed",
        "allowed",
        "allowed",
        "remote_denied",
        "force_push_denied",
      ]);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs project integration lifecycle tools through policy and local adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-integration-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const ledgerRoot = join(root, "worker-jobs", "consumed-output-ledger");
    const workspacePath = join(root, "workspaces", "infinity-context-main");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(join(workspacePath, "src"), { recursive: true });
      await gitInitRepository(workspacePath);
      await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 1;\n");
      await git(workspacePath, ["add", "."]);
      await git(workspacePath, ["commit", "-m", "test: base"]);
      await execFileAsync("git", ["init", "--bare", remotePath]);
      await git(workspacePath, ["remote", "add", "origin", remotePath]);
      await git(workspacePath, ["checkout", "-b", "infinity-context-worker-v1"]);
      await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 2;\n");
      await git(workspacePath, ["add", "."]);
      await git(workspacePath, ["commit", "-m", "fix: worker output"]);
      const workerCommitSha = (await gitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
      await git(workspacePath, ["checkout", "main"]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspacePath],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedBranches: ["main"],
          allowedGitRemotes: ["origin"],
          consumedOutputLedgerRoots: [ledgerRoot],
          commitIdentity: {
            name: "Subscription Runtime Tests",
            email: "tests@example.com",
          },
        },
      });

      await expect(callToolJson(client, "codex_goal_project_open_integration_attempt", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        workerJobId: "infinity-context-worker-v1",
        workerWorkspacePath: workspacePath,
        workerCommitSha,
        targetWorkspacePath: workspacePath,
        targetBranch: "main",
        targetRemote: "origin",
        changedFiles: ["src/memory.ts"],
        approvedFiles: ["src/memory.ts"],
        allowedPathPrefixes: ["src"],
        requiredCheckIds: ["check:unit"],
        requiredChecks: [{
          checkId: "check:unit",
          command: [process.execPath, "-e", "process.exit(0)"],
        }],
        confirmOpen: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_open_attempt",
        attempt: {
          status: "opened",
          expectedFiles: ["src/memory.ts"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_apply_worker_output", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmApply: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_apply_worker_output",
        attempt: {
          status: "applied",
        },
      });

      await expect(callToolJson(client, "codex_goal_project_run_required_checks", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmRunChecks: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_run_required_checks",
        attempt: {
          status: "checks_passed",
        },
      });

      const committed = await callToolJson(client, "codex_goal_project_commit_approved_changes", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        message: "fix(memory): integrate worker output",
        allowedPathPrefixes: ["src"],
        requiredCheckIds: ["check:unit"],
        confirmCommit: true,
      });
      expect(committed).toMatchObject({
        ok: true,
        mode: "project_integration_commit_approved_changes",
        attempt: {
          status: "commit_created",
        },
      });
      const commitSha = (((committed.attempt as Record<string, unknown>)
        .commitCandidate as Record<string, unknown>).commitSha);
      expect(String(commitSha)).toMatch(/^[a-f0-9]{40}$/);

      await expect(callToolJson(client, "codex_goal_project_push_approved_commit", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_push_approved_commit",
        attempt: {
          status: "pushed",
        },
      });

      const pushedSha = await execFileAsync("git", [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ]);
      expect(pushedSha.stdout.trim()).toBe(commitSha);
      await expect(readFile(
        join(ledgerRoot, "items", "infinity-context-worker-v1--attempt-1.json"),
        "utf8",
      ).then((contents) => JSON.parse(contents) as Record<string, unknown>))
        .resolves.toMatchObject({
          jobId: "infinity-context-worker-v1",
          status: "integrated",
          commitSha,
          backup: {
            workspace: workspacePath,
          },
        });
      await expect(callToolJson(client, "codex_goal_project_push_approved_commit", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_push_approved_commit",
        attempt: {
          status: "pushed",
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
