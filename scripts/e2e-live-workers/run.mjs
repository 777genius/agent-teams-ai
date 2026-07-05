#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AccessBoundary,
  LaunchPlanStatus,
  NetworkAccessMode,
  buildLaunchPlan,
} from "../../dist/worker-core/access-control.js";
import {
  ControlledAgentRunStatus,
  startControlledAgentRun,
  stopControlledAgentRun,
} from "../../dist/worker-core/index.js";
import {
  sessionArtifactFromCodexAuthJson,
} from "../../dist/provider-codex/index.js";
import {
  sessionArtifactFromClaudeOAuth,
} from "../../dist/provider-claude/index.js";
import { FileBackendClaudeWorker } from "../../dist/worker-claude/file-backend-claude-worker.js";
import {
  ClaudeControlledAgentProvider,
  buildClaudeControlledAgentProfile,
} from "../../dist/worker-claude/index.js";
import { CommandPolicyRunner } from "../../dist/worker-codex/command-policy-runner.js";
import {
  CodexControlledAgentProvider,
  buildCodexControlledAgentProfile,
} from "../../dist/worker-codex/index.js";
import { createCodexGoalMcpServer } from "../../dist/worker-codex/codex-goal-mcp.js";
import { FileBackendCodexSafeExecutor } from "../../dist/worker-codex/file-backend-codex-safe-executor.js";
import {
  LocalControlledAgentStateStore,
} from "../../dist/store-local-file/index.js";
import { LocalFileWorkerControlInboxStore } from "../../dist/store-local-file/local-worker-control-inbox-store.js";
import { WorkerControlService } from "../../dist/worker-core/control/worker-control-service.js";

const allowLive = process.argv.includes("--allow-live") ||
  process.env.SUBSCRIPTION_RUNTIME_LIVE_WORKERS === "1";
const keepArtifacts = process.argv.includes("--keep-artifacts") ||
  process.env.SUBSCRIPTION_RUNTIME_KEEP_LIVE_E2E_ARTIFACTS === "1";
const onlyScenarios = scenarioFilter();
const codexAuthRoot = resolveHome(
  process.env.CODEX_LIVE_AUTH_ROOT ??
    "~/.cache/subscription-runtime/live-codex-auth",
);
const requestedCodexAccounts = codexAccountsFromEnv();
const codexAccounts = requestedCodexAccounts.filter((account) =>
  existsSync(codexAuthJsonPathFor(account))
);
const codexAccount = codexAccounts[0] ?? requestedCodexAccounts[0] ?? "account-a";
const codexAuthJsonPath = codexAuthJsonPathFor(codexAccount);
const claudeLiveSessionArtifactPath = process.env.CLAUDE_LIVE_SESSION_ARTIFACT_PATH
  ? resolveHome(process.env.CLAUDE_LIVE_SESSION_ARTIFACT_PATH)
  : undefined;

const results = [];

async function main() {
  await run("codex real app-server sandbox", codexRealAppServerSandbox);
  await run("codex broken auth skips account", codexBrokenAuthSkipsAccount);
  await run("codex quota continuation delivers inbox to real account", codexQuotaContinuationInbox);
  await run("codex project integration lifecycle tools", codexProjectIntegrationLifecycleTools);
  await run("codex command policy rejects project bypass", codexCommandPolicyRejectsProjectBypass);
  await run(
    "codex project controller manifest liveness contract",
    codexProjectControllerManifestLivenessContract,
  );
  await run(
    "codex controlled controller real app-server launcher",
    codexControlledControllerRealAppServerLauncher,
  );
  await run(
    "codex real app-server command approval denies raw push",
    codexRealAppServerCommandApprovalDeniesRawPush,
  );
  await run("codex project controller starts real child worker", codexProjectControllerStartsChildWorker);
  await run(
    "claude controlled controller real cli launcher",
    claudeControlledControllerRealCliLauncher,
  );
  await run(
    "claude project controller production mcp start",
    claudeProjectControllerProductionMcpStart,
  );
  await run(
    "claude controlled controller integrates reviewed worker output",
    claudeControlledControllerIntegratesReviewedOutput,
  );
  await run(
    "claude controlled controller starts real child worker",
    claudeControlledControllerStartsChildWorker,
  );
  await run("claude real cli safe-point inbox read-only", claudeInboxReadOnly);
  await run("claude real cli safe-point inbox edit", claudeInboxEdit);

  const failed = results.filter((result) => result.status === "failed");
  const skipped = results.filter((result) => result.status === "skipped");
  const passed = results.filter((result) => result.status === "passed");
  console.log(JSON.stringify({
    ok: failed.length === 0,
    passed: passed.length,
    skipped: skipped.length,
    failed: failed.length,
    results,
  }, null, 2));
  if (failed.length > 0) process.exit(1);
}

async function run(name, fn) {
  if (!shouldRunScenario(name)) return;
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({
      name,
      status: detail?.skipped ? "skipped" : "passed",
      durationMs: Date.now() - startedAt,
      ...(detail ? sanitizeDetail(detail) : {}),
    });
  } catch (error) {
    results.push({
      name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: safeError(error),
    });
  }
}

async function codexRealAppServerSandbox() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-real-app-server-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex live app-server sandbox only.\n",
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      maxAccountCycles: 1,
      accounts: [realCodexAccount(root, "real-a")],
    });
    const result = await executor.run({
      jobId: "codex-live-real-app-server",
      taskId: "codex-live-real-app-server-task",
      prompt:
        "Create result.txt with exactly two lines: codex-live-e2e-ok and codex-real-account-used. Do not modify other files.",
      controls: { editMode: "allow-edits" },
    });
    await executor.dispose();
    const providerSkip = codexProviderUnavailableSkip(result);
    if (providerSkip) return providerSkip;
    const content = await readFile(join(workspacePath, "result.txt"), "utf8");
    assert(result.status === "completed", "codex result must complete");
    assertEqual(content.trim(), "codex-live-e2e-ok\ncodex-real-account-used");
    assertGitStatus(workspacePath, "?? result.txt");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function codexBrokenAuthSkipsAccount() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-broken-auth-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex broken auth sandbox only.\n",
    });
    const authRoot = join(root, "auth");
    await mkdir(join(authRoot, "account-invalid"), { recursive: true });
    await writeFile(
      join(authRoot, "account-invalid", "auth.json"),
      `${JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "invalid-access-token",
          refresh_token: "invalid-refresh-token",
        },
      })}\n`,
      { mode: 0o600 },
    );
    await symlink(
      join(codexAuthRoot, codexAccount),
      join(authRoot, "account-real-a"),
    );
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      maxAccountCycles: 1,
      accounts: [
        {
          codexAuthJsonPath: join(authRoot, "account-invalid", "auth.json"),
          worker: codexWorker(root, "invalid", {
            capacityAccountId: "account-invalid",
          }),
        },
        realCodexAccount(root, "real-a", {
          authJsonPath: join(authRoot, "account-real-a", "auth.json"),
        }),
      ],
    });
    const result = await executor.run({
      jobId: "codex-live-broken-auth",
      taskId: "codex-live-broken-auth-task",
      prompt:
        "Create result.txt with exactly two lines: codex-broken-auth-ok and real-account-used. Do not modify other files.",
      controls: { editMode: "allow-edits" },
    });
    await executor.dispose();
    const providerSkip = codexProviderUnavailableSkip(result);
    if (providerSkip) return providerSkip;
    const content = await readFile(join(workspacePath, "result.txt"), "utf8");
    assert(result.status === "completed", "codex broken-auth run must complete");
    assertEqual(content.trim(), "codex-broken-auth-ok\nreal-account-used");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function codexQuotaContinuationInbox() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-quota-continuation-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex quota continuation sandbox only.\n",
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir: join(root, "state") }),
    });
    const signal = await controlInbox.enqueueSignal({
      target: { jobId: "codex-live-control-job" },
      intent: "guidance",
      deliveryMode: "next_safe_point",
      body:
        "For this live continuation e2e, create result.txt with exactly two lines: CODEX_CONTROL_INBOX_OK and real-codex-continuation-used. Do not use the base file content.",
      createdBy: "operator",
      idempotencyKey: "codex-live-control-guidance",
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      controlInbox,
      maxAccountCycles: 1,
      accounts: [
        {
          codexAuthJson: fakeCodexAuthJson("fake-quota-account"),
          worker: codexWorker(root, "fake-quota", {
            executionEngine: "plain-exec",
            capacityAccountId: "fake-quota-account",
            runner: new StaticRunner({
              exitCode: 1,
              stdout: "",
              stderr: "You've hit your usage limit.",
            }),
          }),
        },
        realCodexAccount(root, "real-a"),
      ],
    });
    const result = await executor.run({
      jobId: "codex-live-control-job",
      taskId: "codex-live-control-task",
      prompt:
        "Create result.txt with exactly two lines: CODEX_BASE and base-instruction-used.",
      controls: { editMode: "allow-edits" },
    });
    await executor.dispose();
    const providerSkip = codexProviderUnavailableSkip(result);
    if (providerSkip) return providerSkip;
    const content = await readFile(join(workspacePath, "result.txt"), "utf8");
    const views = await controlInbox.listSignals({
      target: { jobId: "codex-live-control-job" },
      includeBodies: false,
    });
    assert(result.status === "completed", "codex continuation must complete");
    assertEqual(result.attempts?.[0]?.failureReason, "quota_limited");
    assertEqual(content.trim(), "CODEX_CONTROL_INBOX_OK\nreal-codex-continuation-used");
    assertEqual(views[0]?.state, "delivered");
    assertEqual(views[0]?.signal.signalId, signal.signalId);
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function codexProjectControllerStartsChildWorker() {
  const skip = codexProjectControlSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-project-control-");
  let childTmuxSession = null;
  try {
    const sourceWorkspace = await gitSandbox(join(root, "source"), {
      "README.md": "Codex project-control live sandbox only.\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: sourceWorkspace,
    }).stdout.trim();
    const remotePath = join(root, "remote.git");
    runChecked("git", ["init", "--bare", remotePath]);
    runChecked("git", ["remote", "add", "origin", remotePath], {
      cwd: sourceWorkspace,
    });
    const registryRootDir = join(root, "registry");
    const jobsRoot = join(root, "jobs");
    const worktreesRoot = join(root, "worktrees");
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });

    const prefix = "pc-live-e2e-";
    const controllerJobId = `${prefix}controller`;
    const childJobId = `${prefix}child`;
    childTmuxSession = childJobId;
    const controllerJobRoot = join(jobsRoot, controllerJobId);
    const childJobRoot = join(jobsRoot, childJobId);
    const childWorkspace = join(worktreesRoot, childJobId);
    const childOutputFile = "project-control-real-codex-ok.txt";
    const childPatchPath = join(childWorkspace, "project-control-real-codex-ok.patch");
    const controllerPrompt = join(controllerJobRoot, "prompt.md");
    const childPrompt = join(childJobRoot, "prompt.md");
    await mkdir(controllerJobRoot, { recursive: true });
    await mkdir(childJobRoot, { recursive: true });
    await writeFile(
      controllerPrompt,
      "Controller manifest only. Use project-control broker tools, not raw shell.\n",
    );
    await writeFile(
      childPrompt,
      "Create project-control-real-codex-ok.txt with exact content PROJECT_CONTROL_REAL_CODEX_OK. Do not print secrets.\n",
    );

    const projectAccessScope = {
      projectId: "codex-project-control-live-e2e",
      registryRoot: registryRootDir,
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreesRoot],
      jobIdPrefixes: [prefix],
      tmuxSessionPrefixes: [prefix],
      allowedBranches: ["main", "master"],
      allowedGitRemotes: ["origin"],
      allowedAccountIds: codexAccounts,
    };

    await codexGoalTool("codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      description: "Sandbox project-scoped controller live e2e",
      jobRootDir: controllerJobRoot,
      authRootDir: codexAuthRoot,
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath: sourceWorkspace,
      promptPath: controllerPrompt,
      taskId: controllerJobId,
      progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
      accounts: codexAccounts,
      tmuxSession: controllerJobId,
      model: process.env.CODEX_LIVE_MODEL ?? "gpt-5.5",
      reasoningEffort: process.env.CODEX_LIVE_EFFORT ?? "high",
      serviceTier: process.env.CODEX_LIVE_SERVICE_TIER ?? "fast",
      executionEngine: "app-server-goal",
      taskTimeoutMs: 10 * 60 * 1000,
      maxAccountCycles: 1,
      accessBoundary: "project_scoped_control",
      projectAccessScope,
      networkAccess: "restricted",
      confirmCreate: true,
    });

    await codexGoalTool("codex_goal_project_create_worktree", {
      registryRootDir,
      controllerJobId,
      sourceWorkspacePath: sourceWorkspace,
      path: childWorkspace,
      confirmCreateWorktree: true,
    });
    await codexGoalTool("codex_goal_project_create_job", {
      registryRootDir,
      controllerJobId,
      jobId: childJobId,
      description: "Sandbox child real Codex worker live e2e",
      jobRootDir: childJobRoot,
      authRootDir: codexAuthRoot,
      stateRootDir: join(childJobRoot, "state"),
      workspacePath: childWorkspace,
      promptPath: childPrompt,
      taskId: childJobId,
      progressPath: join(childJobRoot, `${childJobId}.progress.json`),
      accounts: codexAccounts,
      tmuxSession: childTmuxSession,
      model: process.env.CODEX_LIVE_MODEL ?? "gpt-5.5",
      reasoningEffort: process.env.CODEX_LIVE_EFFORT ?? "high",
      serviceTier: process.env.CODEX_LIVE_SERVICE_TIER ?? "fast",
      executionEngine: "app-server-goal",
      taskTimeoutMs: 10 * 60 * 1000,
      maxAccountCycles: 1,
      accessBoundary: "isolated_workspace_write",
      networkAccess: "restricted",
      confirmCreate: true,
    });
    await codexGoalTool("codex_goal_project_start", {
      registryRootDir,
      controllerJobId,
      jobId: childJobId,
      confirmStart: true,
    });

    const result = await waitForCodexProjectChildResult({
      registryRootDir,
      jobId: childJobId,
      workspacePath: childWorkspace,
    });
    if (result.skipped) return result;
    runChecked("git", ["add", "-N", childOutputFile], { cwd: childWorkspace });
    const childPatch = runChecked("git", ["diff", "--", childOutputFile], {
      cwd: childWorkspace,
    }).stdout;
    assert(childPatch.includes(childOutputFile), "child output patch must include marker file");
    await writeFile(childPatchPath, childPatch);

    const attemptId = `${prefix}attempt`;
    assertToolOk(codexGoalTool("codex_goal_project_open_integration_attempt", {
      registryRootDir,
      controllerJobId,
      attemptId,
      workerJobId: childJobId,
      workerWorkspacePath: childWorkspace,
      workerPatchPath: childPatchPath,
      targetWorkspacePath: sourceWorkspace,
      targetBranch: branch,
      targetRemote: "origin",
      changedFiles: [childOutputFile],
      approvedFiles: [childOutputFile],
      allowedPathPrefixes: [childOutputFile],
      requiredCheckIds: ["check:marker"],
      requiredChecks: [{
        checkId: "check:marker",
        command: [
          process.execPath,
          "-e",
          "const fs=require('fs');if(fs.readFileSync('project-control-real-codex-ok.txt','utf8').trim()!=='PROJECT_CONTROL_REAL_CODEX_OK')process.exit(1)",
        ],
      }],
      reviewedBy: controllerJobId,
      reviewReason: "live child marker output reviewed by e2e controller",
      confirmOpen: true,
    }), "open live child integration attempt");
    assertToolOk(codexGoalTool("codex_goal_project_apply_worker_output", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmApply: true,
    }), "apply live child output");
    assertToolOk(codexGoalTool("codex_goal_project_run_required_checks", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmRunChecks: true,
    }), "run live child integration checks");
    const committed = assertToolOk(codexGoalTool(
      "codex_goal_project_commit_approved_changes",
      {
        registryRootDir,
        controllerJobId,
        attemptId,
        message: "test(worker): integrate live child output",
        allowedPathPrefixes: [childOutputFile],
        requiredCheckIds: ["check:marker"],
        confirmCommit: true,
      },
    ), "commit live child output");
    assertToolOk(codexGoalTool("codex_goal_project_push_approved_commit", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmPush: true,
    }), "push live child output");

    const commitSha = committed.attempt?.commitCandidate?.commitSha;
    const pushedSha = runChecked("git", [
      "--git-dir",
      remotePath,
      "rev-parse",
      `refs/heads/${branch}`,
    ]).stdout.trim();
    assertEqual(pushedSha, commitSha);
    const auditPath = join(
      controllerJobRoot,
      `${controllerJobId}.project-control-events.jsonl`,
    );
    const auditText = await readFile(auditPath, "utf8");
    assert(
      auditText.includes('"operation":"start_worker"'),
      "project controller audit must record start_worker",
    );
    return {
      root: keepArtifacts ? root : undefined,
      changedFiles: result.changedFiles,
      integrationCommit: commitSha,
    };
  } finally {
    if (childTmuxSession) killTmuxSession(childTmuxSession);
    await cleanup(root);
  }
}

async function codexProjectIntegrationLifecycleTools() {
  const root = await sandboxRoot("codex-project-integration-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "memory.txt": "before\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspacePath,
    }).stdout.trim();
    const remotePath = join(root, "remote.git");
    runChecked("git", ["init", "--bare", remotePath]);
    runChecked("git", ["remote", "add", "origin", remotePath], {
      cwd: workspacePath,
    });
    runChecked("git", ["checkout", "-b", "pc-integration-worker"], {
      cwd: workspacePath,
    });
    await writeFile(join(workspacePath, "memory.txt"), "after\n");
    runChecked("git", ["add", "memory.txt"], { cwd: workspacePath });
    runChecked("git", ["commit", "-m", "fix: worker output"], {
      cwd: workspacePath,
    });
    const workerCommitSha = runChecked("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
    }).stdout.trim();
    runChecked("git", ["checkout", branch], { cwd: workspacePath });

    const registryRootDir = join(root, "registry");
    const controllerJobId = "pc-integration-controller";
    const controllerJobRoot = join(root, "jobs", controllerJobId);
    await codexGoalTool("codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      description: "Sandbox project integration lifecycle e2e",
      jobRootDir: controllerJobRoot,
      authRootDir: join(root, "auth"),
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath,
      promptPath: join(controllerJobRoot, "prompt.md"),
      taskId: controllerJobId,
      accounts: ["account-a"],
      accessBoundary: "project_scoped_control",
      networkAccess: "restricted",
      projectAccessScope: {
        projectId: "codex-project-integration-e2e",
        registryRoot: registryRootDir,
        workspaceRoots: [workspacePath],
        jobIdPrefixes: ["pc-integration-"],
        tmuxSessionPrefixes: ["pc-integration-"],
        allowedBranches: [branch],
        allowedGitRemotes: ["origin"],
      },
      confirmCreate: true,
    });

    const attemptId = "pc-integration-attempt";
    assertToolOk(codexGoalTool("codex_goal_project_open_integration_attempt", {
      registryRootDir,
      controllerJobId,
      attemptId,
      workerJobId: "pc-integration-worker",
      workerWorkspacePath: workspacePath,
      workerCommitSha,
      targetWorkspacePath: workspacePath,
      targetBranch: branch,
      targetRemote: "origin",
      changedFiles: ["memory.txt"],
      approvedFiles: ["memory.txt"],
      allowedPathPrefixes: ["memory.txt"],
      requiredCheckIds: ["check:noop"],
      requiredChecks: [{
        checkId: "check:noop",
        command: [process.execPath, "-e", "process.exit(0)"],
      }],
      confirmOpen: true,
    }), "open integration attempt");
    assertToolOk(codexGoalTool("codex_goal_project_apply_worker_output", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmApply: true,
    }), "apply worker output");
    assertToolOk(codexGoalTool("codex_goal_project_run_required_checks", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmRunChecks: true,
    }), "run required checks");
    const committed = assertToolOk(codexGoalTool(
      "codex_goal_project_commit_approved_changes",
      {
        registryRootDir,
        controllerJobId,
        attemptId,
        message: "fix(memory): integrate worker output",
        allowedPathPrefixes: ["memory.txt"],
        requiredCheckIds: ["check:noop"],
        confirmCommit: true,
      },
    ), "commit approved changes");
    const denied = codexGoalTool("codex_goal_project_push_approved_commit", {
      registryRootDir,
      controllerJobId,
      attemptId,
      remote: "upstream",
      confirmPush: true,
    });
    assertEqual(denied.ok, false);
    assert(
      String(denied.error).includes("remote_denied"),
      "push to unapproved remote must be denied",
    );
    assertToolOk(codexGoalTool("codex_goal_project_push_approved_commit", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmPush: true,
    }), "push approved commit");

    const commitSha = committed.attempt?.commitCandidate?.commitSha;
    const pushedSha = runChecked("git", [
      "--git-dir",
      remotePath,
      "rev-parse",
      `refs/heads/${branch}`,
    ]).stdout.trim();
    assertEqual(pushedSha, commitSha);
    return { root: keepArtifacts ? root : undefined, branch };
  } finally {
    await cleanup(root);
  }
}

async function codexProjectControllerManifestLivenessContract() {
  const root = await sandboxRoot("codex-project-controller-liveness-");
  try {
    const sourceWorkspace = await gitSandbox(join(root, "source"), {
      "README.md": "Project controller manifest liveness sandbox only.\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: sourceWorkspace,
    }).stdout.trim();
    const registryRootDir = join(root, "registry");
    const jobsRoot = join(root, "jobs");
    const worktreesRoot = join(root, "worktrees");
    const authRoot = join(root, "auth");
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });
    await mkdir(authRoot, { recursive: true });

    const prefix = "pc-liveness-e2e-";
    const controllerJobId = `${prefix}controller`;
    const childJobId = `${prefix}child`;
    const controllerJobRoot = join(jobsRoot, controllerJobId);
    const childJobRoot = join(jobsRoot, childJobId);
    const childWorkspace = join(worktreesRoot, childJobId);
    const controllerPrompt = join(controllerJobRoot, "prompt.md");
    const childPrompt = join(childJobRoot, "prompt.md");
    await mkdir(controllerJobRoot, { recursive: true });
    await mkdir(childJobRoot, { recursive: true });
    await writeFile(
      controllerPrompt,
      "Controller manifest only. A live LLM launcher must expose broker/status tools only.\n",
    );
    await writeFile(
      childPrompt,
      "Sandbox child worker placeholder. Do not print secrets.\n",
    );

    const projectAccessScope = {
      projectId: "codex-project-controller-liveness-e2e",
      registryRoot: registryRootDir,
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreesRoot],
      jobIdPrefixes: [prefix],
      tmuxSessionPrefixes: [prefix],
      allowedBranches: [branch],
      allowedGitRemotes: ["origin"],
      allowedAccountIds: ["account-a"],
    };

    assertToolOk(codexGoalTool("codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      description: "Project-scoped controller manifest liveness e2e",
      jobRootDir: controllerJobRoot,
      authRootDir: authRoot,
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath: sourceWorkspace,
      promptPath: controllerPrompt,
      taskId: controllerJobId,
      progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
      accounts: ["account-a"],
      tmuxSession: controllerJobId,
      accessBoundary: "project_scoped_control",
      projectAccessScope,
      networkAccess: "restricted",
      confirmCreate: true,
    }), "create controller manifest");

    const ordinaryStart = codexGoalTool("codex_goal_start", {
      registryRootDir,
      jobId: controllerJobId,
      jobRootDir: controllerJobRoot,
      authRootDir: authRoot,
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath: sourceWorkspace,
      promptPath: controllerPrompt,
      taskId: controllerJobId,
      progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
      accounts: ["account-a"],
      tmuxSession: controllerJobId,
      accessBoundary: "project_scoped_control",
      projectAccessScope,
      networkAccess: "restricted",
      confirmStart: true,
      skipDoctor: true,
    });
    assertEqual(ordinaryStart.ok, false);
    assert(
      String(ordinaryStart.error).includes("codex_goal_access_boundary_blocked"),
      "ordinary controller launch must fail closed without a broker-only LLM surface",
    );

    assertToolOk(codexGoalTool("codex_goal_project_create_worktree", {
      registryRootDir,
      controllerJobId,
      sourceWorkspacePath: sourceWorkspace,
      path: childWorkspace,
      confirmCreateWorktree: true,
    }), "create child worktree through controller broker");

    const child = assertToolOk(codexGoalTool("codex_goal_project_create_job", {
      registryRootDir,
      controllerJobId,
      jobId: childJobId,
      description: "Sandbox child manifest from project controller",
      jobRootDir: childJobRoot,
      authRootDir: authRoot,
      stateRootDir: join(childJobRoot, "state"),
      workspacePath: childWorkspace,
      promptPath: childPrompt,
      taskId: childJobId,
      progressPath: join(childJobRoot, `${childJobId}.progress.json`),
      accounts: ["account-a"],
      tmuxSession: childJobId,
      networkAccess: "restricted",
      confirmCreate: true,
    }), "create child manifest through controller broker");
    assertEqual(child.manifest?.accessBoundary, "isolated_workspace_write");

    const dangerChild = codexGoalTool("codex_goal_project_create_job", {
      registryRootDir,
      controllerJobId,
      jobId: `${prefix}danger-child`,
      jobRootDir: join(jobsRoot, `${prefix}danger-child`),
      authRootDir: authRoot,
      workspacePath: join(worktreesRoot, `${prefix}danger-child`),
      promptPath: join(jobsRoot, `${prefix}danger-child`, "prompt.md"),
      taskId: `${prefix}danger-child`,
      accounts: ["account-a"],
      tmuxSession: `${prefix}danger-child`,
      accessBoundary: "danger_full_access",
      allowDangerFullAccess: true,
      confirmCreate: true,
    });
    assertEqual(dangerChild.ok, false);
    assert(
      String(dangerChild.error).includes("project_control_child_danger_full_access_denied") ||
        String(dangerChild.error).includes("project_control_child_boundary_denied"),
      "controller broker must reject danger_full_access child jobs",
    );

    const controllerChild = codexGoalTool("codex_goal_project_create_job", {
      registryRootDir,
      controllerJobId,
      jobId: `${prefix}controller-child`,
      jobRootDir: join(jobsRoot, `${prefix}controller-child`),
      authRootDir: authRoot,
      workspacePath: join(worktreesRoot, `${prefix}controller-child`),
      promptPath: join(jobsRoot, `${prefix}controller-child`, "prompt.md"),
      taskId: `${prefix}controller-child`,
      accounts: ["account-a"],
      tmuxSession: `${prefix}controller-child`,
      accessBoundary: "project_scoped_control",
      confirmCreate: true,
    });
    assertEqual(controllerChild.ok, false);
    assert(
      String(controllerChild.error).includes("project_control_child_boundary_denied"),
      "controller broker must reject nested project_scoped_control child jobs",
    );

    const auditText = await readFile(
      join(controllerJobRoot, `${controllerJobId}.project-control-events.jsonl`),
      "utf8",
    );
    assert(
      auditText.includes('"operation":"create_worktree"') &&
        auditText.includes('"operation":"create_job"'),
      "controller audit must record broker worktree and child-job operations",
    );

    return {
      root: keepArtifacts ? root : undefined,
      ordinaryStartError: ordinaryStart.error,
      childAccessBoundary: child.manifest?.accessBoundary,
    };
  } finally {
    await cleanup(root);
  }
}

async function codexControlledControllerRealAppServerLauncher() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-controlled-controller-");
  let provider = null;
  let stateStore = null;
  let started = null;
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex controlled controller live sandbox only.\n",
    });
    const registryRootDir = join(root, "registry");
    const worktreesRoot = join(root, "worktrees");
    const stateDir = join(root, "controller-state");
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });

    const profile = buildCodexControlledAgentProfile({
      stateDir,
      mcpCommand: process.execPath,
      mcpArgs: [join(process.cwd(), "dist/worker-codex/codex-goal-mcp.js")],
      mcpCwd: process.cwd(),
      rawShellMode: "disabled-by-provider",
    });
    stateStore = new LocalControlledAgentStateStore({ rootDir: stateDir });
    provider = new CodexControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromCodexAuthJson(
        await readFile(codexAuthJsonPath, "utf8"),
      ),
      workspacePath,
      codexBinaryPath: "codex",
      model: process.env.CODEX_LIVE_MODEL ?? "gpt-5.5",
      reasoningEffort: process.env.CODEX_LIVE_EFFORT ?? "high",
      serviceTier: process.env.CODEX_LIVE_SERVICE_TIER ?? "fast",
      maxGoalTurns: Number(process.env.CODEX_CONTROLLED_LIVE_MAX_GOAL_TURNS ?? "1"),
      controllerObjective: [
        "This is a subscription-runtime live controlled-agent e2e.",
        "Inspect the broker/status tool surface only.",
        "Do not create child workers, do not edit files, do not use raw shell/git/tmux.",
        "Finish after confirming the controller launch surface is available.",
      ].join("\n"),
    });

    started = await startControlledAgentRun({
      controllerJobId: "controlled-live-controller",
      sessionId: "controlled-live-controller:controlled-agent",
      stateDir,
      boundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        projectId: "codex-controlled-controller-live-e2e",
        registryRoot: registryRootDir,
        authRoot: codexAuthRoot,
        workspaceRoots: [workspacePath],
        worktreeRoots: [worktreesRoot],
        jobIdPrefixes: ["controlled-live-"],
        tmuxSessionPrefixes: ["controlled-live-"],
        allowedBranches: ["main", "master"],
        allowedGitRemotes: ["origin"],
        allowedAccountIds: [codexAccount],
      },
      provider: profile.enforcement,
      networkAccess: NetworkAccessMode.Restricted,
    }, {
      provider,
      stateStore,
      events: stateStore,
    });
    assert(started.ok === true, "controlled controller live start must pass launch policy");
    assertEqual(started.run.status, ControlledAgentRunStatus.Running);
    assert(
      started.provider?.safeMessage?.includes("native environments disabled"),
      "controlled provider must report native environment disablement",
    );

    const configPath = join(profile.codexHome, "config.toml");
    const beforeConfig = await waitForControlledFileOrTerminal({
      path: configPath,
      provider,
      session: started.session,
      run: started.run,
      timeoutMs: 120_000,
    });
    const beforeConfigSkip = codexControlledProviderUnavailableSkip(beforeConfig);
    if (beforeConfigSkip) return beforeConfigSkip;
    assert(
      existsSync(configPath),
      `controlled config was not materialized before provider status ${beforeConfig?.status ?? "unknown"}: ${safeTail(beforeConfig?.safeMessage ?? "")}`,
    );
    const configToml = await readFile(configPath, "utf8");
    assert(configToml.includes("enabled_tools"), "controlled config must pin enabled broker tools");
    assert(configToml.includes("codex_goal_project_start"), "controlled config must include broker start tool");
    assert(!configToml.includes("danger-full-access"), "controlled config must not request danger-full-access");

    const observed = await waitForControlledStatus({
      provider,
      session: started.session,
      run: started.run,
      timeoutMs: 180_000,
    });
    const providerSkip = codexControlledProviderUnavailableSkip(observed);
    if (providerSkip) return providerSkip;
    assert(
      [
        ControlledAgentRunStatus.Running,
        ControlledAgentRunStatus.Completed,
        ControlledAgentRunStatus.Blocked,
      ].includes(observed.status),
      `unexpected controlled provider status: ${observed.status}: ${safeTail(observed.safeMessage ?? "")}`,
    );
    return {
      root: keepArtifacts ? root : undefined,
      providerStatus: observed.status,
      allowedTools: profile.enabledTools.length,
    };
  } finally {
    if (provider && started?.ok === true && stateStore) {
      await stopControlledAgentRun({
        sessionId: started.session.sessionId,
        reason: "live_e2e_cleanup",
      }, {
        stateStore,
        provider,
        events: stateStore,
      }).catch(() => undefined);
    }
    await cleanup(root);
  }
}

async function codexCommandPolicyRejectsProjectBypass() {
  const root = await sandboxRoot("codex-command-policy-bypass-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Command policy bypass sandbox only.\n",
    });
    const registryRootDir = join(root, "registry");
    const plan = buildLaunchPlan({
      boundary: AccessBoundary.ProjectScopedControl,
      networkAccess: NetworkAccessMode.Restricted,
      scope: {
        projectId: "codex-command-policy-bypass-e2e",
        registryRoot: registryRootDir,
        workspaceRoots: [workspacePath],
        worktreeRoots: [join(root, "worktrees")],
        jobIdPrefixes: ["pc-bypass-"],
        tmuxSessionPrefixes: ["pc-bypass-"],
        allowedBranches: ["main", "master"],
        allowedGitRemotes: ["origin"],
      },
      adapter: {
        canEnforceFilesystemPolicy: true,
        canIsolateHome: true,
        canIsolateTemp: true,
        canDisableRawShell: true,
        canBrokerProjectControl: true,
        canRestrictNetwork: true,
      },
    });
    assertEqual(plan.status, LaunchPlanStatus.Ready);
    const runner = new CommandPolicyRunner(new E2EStaticRunner(), plan.commandPolicy);
    await assertCommandPolicyDenied(runner, {
      command: "git",
      args: ["push", "origin", "main"],
      cwd: workspacePath,
    }, "denied_git_subcommand");
    await assertCommandPolicyDenied(runner, {
      command: "tmux",
      args: ["new-session", "-s", "pc-bypass-child"],
      cwd: workspacePath,
    }, "denied_executable");
    await assertCommandPolicyDenied(runner, {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspacePath,
    }, "inline_code_denied");
    await assertCommandPolicyDenied(runner, {
      command: "cat",
      args: [join(registryRootDir, "jobs.json")],
      cwd: workspacePath,
    }, "denied_path_prefix");

    const allowed = await runner.run({
      command: "git",
      args: ["status", "--short"],
      cwd: workspacePath,
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
    assertEqual(allowed.exitCode, 0);
    return { root: keepArtifacts ? root : undefined, deniedCommands: 4 };
  } finally {
    await cleanup(root);
  }
}

async function claudeControlledControllerRealCliLauncher() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-controlled-controller-");
  let provider = null;
  let stateStore = null;
  let started = null;
  try {
    const sourceWorkspace = await gitSandbox(join(root, "source"), {
      "README.md": "Claude controlled controller live sandbox only.\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: sourceWorkspace,
    }).stdout.trim();
    const registryRootDir = join(root, "registry");
    const jobsRoot = join(root, "jobs");
    const worktreesRoot = join(root, "worktrees");
    const authRoot = join(root, "auth");
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });
    await mkdir(authRoot, { recursive: true });

    const prefix = "claude-controlled-live-";
    const controllerJobId = `${prefix}controller`;
    const controllerJobRoot = join(jobsRoot, controllerJobId);
    const controllerPrompt = join(controllerJobRoot, "prompt.md");
    const brokerWorktree = join(worktreesRoot, `${prefix}broker-worktree`);
    await mkdir(controllerJobRoot, { recursive: true });
    await writeFile(
      controllerPrompt,
      "Claude controller launcher smoke. Use only broker MCP tools.\n",
    );

    const projectAccessScope = {
      projectId: "claude-controlled-controller-live-e2e",
      registryRoot: registryRootDir,
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreesRoot],
      jobIdPrefixes: [prefix],
      tmuxSessionPrefixes: [prefix],
      allowedBranches: [branch],
      allowedGitRemotes: ["origin"],
      allowedAccountIds: ["account-a"],
    };
    assertToolOk(codexGoalTool("codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      description: "Sandbox Claude project-scoped controller live e2e",
      jobRootDir: controllerJobRoot,
      authRootDir: authRoot,
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath: sourceWorkspace,
      promptPath: controllerPrompt,
      taskId: controllerJobId,
      progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
      accounts: ["account-a"],
      tmuxSession: controllerJobId,
      accessBoundary: "project_scoped_control",
      projectAccessScope,
      networkAccess: "restricted",
      confirmCreate: true,
    }), "create Claude controller manifest");

    const stateDir = join(root, "controlled-state");
    const profile = buildClaudeControlledAgentProfile({
      stateDir,
      mcpCommand: process.execPath,
      mcpArgs: [join(process.cwd(), "dist/worker-codex/codex-goal-mcp.js")],
      mcpCwd: process.cwd(),
    });
    const createWorktreeTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_create_worktree`;
    stateStore = new LocalControlledAgentStateStore({ rootDir: stateDir });
    provider = new ClaudeControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromClaudeOAuth({
        oauthToken: "ambient-claude-live-e2e-token-not-used",
      }),
      workspacePath: sourceWorkspace,
      engine: new RealClaudeControlledEngine(),
      model: process.env.CLAUDE_LIVE_MODEL ?? "sonnet",
      controllerObjective: [
        "This is a subscription-runtime Claude controlled-agent live e2e.",
        `Call the MCP broker tool ${createWorktreeTool} exactly once with this JSON:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          sourceWorkspacePath: sourceWorkspace,
          path: brokerWorktree,
          confirmCreateWorktree: true,
        }),
        "After the tool succeeds, reply with CLAUDE_CONTROLLED_WORKTREE_OK.",
        "Do not use Bash, Read, Edit, Write, raw git, raw tmux or direct filesystem access.",
      ].join("\n"),
    });

    started = await startControlledAgentRun({
      controllerJobId,
      sessionId: `${controllerJobId}:claude-controlled-agent`,
      stateDir,
      boundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope,
      provider: profile.enforcement,
      networkAccess: NetworkAccessMode.Restricted,
    }, {
      provider,
      stateStore,
      events: stateStore,
    });
    assert(started.ok === true, "Claude controlled controller live start must pass launch policy");
    assertEqual(started.run.status, ControlledAgentRunStatus.Running);

    const observed = await waitForControlledStatus({
      provider,
      session: started.session,
      run: started.run,
      timeoutMs: 240_000,
    });
    const providerSkip = claudeControlledProviderUnavailableSkip(observed);
    if (providerSkip) return providerSkip;
    assertEqual(observed.status, ControlledAgentRunStatus.Completed);
    assert(existsSync(brokerWorktree), "Claude controller must create the broker worktree through MCP");
    const auditText = await readFile(
      join(controllerJobRoot, `${controllerJobId}.project-control-events.jsonl`),
      "utf8",
    );
    assert(
      auditText.includes('"operation":"create_worktree"'),
      "Claude controller broker smoke must audit create_worktree",
    );
    return {
      root: keepArtifacts ? root : undefined,
      providerStatus: observed.status,
      allowedTools: profile.allowedTools.length,
    };
  } finally {
    if (provider && started?.ok === true && stateStore) {
      await stopControlledAgentRun({
        sessionId: started.session.sessionId,
        reason: "live_e2e_cleanup",
      }, {
        stateStore,
        provider,
        events: stateStore,
      }).catch(() => undefined);
    }
    await cleanup(root);
  }
}

async function claudeProjectControllerProductionMcpStart() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  if (!claudeLiveSessionArtifactPath) {
    return {
      skipped: true,
      reason: "CLAUDE_LIVE_SESSION_ARTIFACT_PATH is not set",
    };
  }
  if (!existsSync(claudeLiveSessionArtifactPath)) {
    return {
      skipped: true,
      reason: "CLAUDE_LIVE_SESSION_ARTIFACT_PATH does not exist",
    };
  }

  const root = await sandboxRoot("claude-controller-production-mcp-");
  let started = null;
  try {
    const sourceWorkspace = await gitSandbox(join(root, "source"), {
      "README.md": "Claude production MCP controller live sandbox only.\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: sourceWorkspace,
    }).stdout.trim();
    const registryRootDir = join(root, "registry");
    const jobsRoot = join(root, "jobs");
    const worktreesRoot = join(root, "worktrees");
    const authRoot = dirname(claudeLiveSessionArtifactPath);
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });

    const prefix = "claude-production-controller-";
    const controllerJobId = `${prefix}v1`;
    const controllerJobRoot = join(jobsRoot, controllerJobId);
    const controllerPrompt = join(controllerJobRoot, "prompt.md");
    await mkdir(controllerJobRoot, { recursive: true });
    await writeFile(
      controllerPrompt,
      [
        "Production MCP Claude controller smoke.",
        "Do not create workers, do not edit files, do not use raw host tools.",
        "Reply with CLAUDE_PRODUCTION_CONTROLLER_OK and finish.",
      ].join("\n"),
    );

    const projectAccessScope = {
      projectId: "claude-production-controller-live-e2e",
      registryRoot: registryRootDir,
      authRoot,
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreesRoot],
      jobIdPrefixes: [prefix],
      tmuxSessionPrefixes: [prefix],
      allowedBranches: [branch],
      allowedGitRemotes: ["origin"],
      allowedAccountIds: ["claude-session"],
    };
    return await withCodexGoalMcpClient(async (client) => {
      try {
        assertToolOk(await codexGoalMcpTool(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: controllerJobId,
          description: "Production MCP Claude project controller live e2e",
          jobRootDir: controllerJobRoot,
          authRootDir: authRoot,
          stateRootDir: join(controllerJobRoot, "state"),
          workspacePath: sourceWorkspace,
          promptPath: controllerPrompt,
          taskId: controllerJobId,
          progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
          accounts: ["claude-session"],
          tmuxSession: controllerJobId,
          accessBoundary: "project_scoped_control",
          projectAccessScope,
          networkAccess: "restricted",
          model: process.env.CLAUDE_LIVE_MODEL ?? "sonnet",
          confirmCreate: true,
        }), "create production Claude controller manifest");

        const plan = assertToolOk(await codexGoalMcpTool(
          client,
          "codex_goal_project_controller_launch_plan",
          {
            registryRootDir,
            controllerJobId,
            providerKind: "claude",
            mcpCommand: process.execPath,
            mcpArgs: [join(process.cwd(), "dist/worker-codex/codex-goal-mcp.js")],
            mcpCwd: process.cwd(),
          },
        ), "production Claude controller launch plan");
        assertEqual(plan.providerKind, "claude");
        assert(
          String(plan.sessionId).endsWith(":controlled-agent:claude"),
          "Claude production controller must use provider-specific session id",
        );

        started = assertToolOk(await codexGoalMcpTool(
          client,
          "codex_goal_project_controller_start",
          {
            registryRootDir,
            controllerJobId,
            providerKind: "claude",
            sessionArtifactPath: claudeLiveSessionArtifactPath,
            mcpCommand: process.execPath,
            mcpArgs: [join(process.cwd(), "dist/worker-codex/codex-goal-mcp.js")],
            mcpCwd: process.cwd(),
            maxGoalTurns: Number(process.env.CLAUDE_CONTROLLED_LIVE_MAX_TURNS ?? "1"),
          },
        ), "production Claude controller start");
        assertEqual(started.providerKind, "claude");
        assertEqual(started.status, ControlledAgentRunStatus.Running);
        assert(
          !JSON.stringify(started).includes("oauth"),
          "production start response must not include Claude oauth payloads",
        );

        const observed = await waitForProjectControllerMcpStatus({
          client,
          registryRootDir,
          controllerJobId,
          providerKind: "claude",
          timeoutMs: Number(process.env.CLAUDE_CONTROLLED_LIVE_TIMEOUT_MS ?? "180000"),
        });
        const providerStatus = projectControllerProviderStatus(observed);
        const providerSkip = claudeControlledProviderUnavailableSkip({
          status: providerStatus,
          safeMessage: projectControllerProviderSafeMessage(observed),
        });
        if (providerSkip) return providerSkip;
        assertEqual(providerStatus, ControlledAgentRunStatus.Completed);
        assert(
          !JSON.stringify(observed).includes("oauth"),
          "production status response must not include Claude oauth payloads",
        );

        return {
          root: keepArtifacts ? root : undefined,
          providerKind: started.providerKind,
          providerStatus,
          sessionArtifactSha256Prefix: started.sessionArtifact?.sha256Prefix,
        };
      } finally {
        if (started?.ok === true) {
          await codexGoalMcpTool(client, "codex_goal_project_controller_stop", {
            registryRootDir,
            controllerJobId,
            providerKind: "claude",
            reason: "live_e2e_cleanup",
          }).catch(() => undefined);
        }
      }
    });
  } finally {
    await cleanup(root);
  }
}

async function claudeControlledControllerIntegratesReviewedOutput() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-controller-integration-");
  let provider = null;
  let stateStore = null;
  let started = null;
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "memory.txt": "before\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspacePath,
    }).stdout.trim();
    const remotePath = join(root, "remote.git");
    runChecked("git", ["init", "--bare", remotePath]);
    runChecked("git", ["remote", "add", "origin", remotePath], {
      cwd: workspacePath,
    });
    runChecked("git", ["checkout", "-b", "claude-integration-worker"], {
      cwd: workspacePath,
    });
    await writeFile(join(workspacePath, "memory.txt"), "after\n");
    runChecked("git", ["add", "memory.txt"], { cwd: workspacePath });
    runChecked("git", ["commit", "-m", "fix: claude worker output"], {
      cwd: workspacePath,
    });
    const workerCommitSha = runChecked("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
    }).stdout.trim();
    runChecked("git", ["checkout", branch], { cwd: workspacePath });

    const registryRootDir = join(root, "registry");
    const jobsRoot = join(root, "jobs");
    const authRoot = join(root, "auth");
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(authRoot, { recursive: true });
    const prefix = "claude-integration-e2e-";
    const controllerJobId = `${prefix}controller`;
    const controllerJobRoot = join(jobsRoot, controllerJobId);
    const controllerPrompt = join(controllerJobRoot, "prompt.md");
    await mkdir(controllerJobRoot, { recursive: true });
    await writeFile(
      controllerPrompt,
      "Claude controller integrates reviewed worker output through broker MCP tools.\n",
    );
    const projectAccessScope = {
      projectId: "claude-controller-integration-e2e",
      registryRoot: registryRootDir,
      workspaceRoots: [workspacePath],
      jobIdPrefixes: [prefix, "claude-integration-worker"],
      tmuxSessionPrefixes: [prefix],
      allowedBranches: [branch],
      allowedGitRemotes: ["origin"],
    };
    assertToolOk(codexGoalTool("codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      description: "Sandbox Claude controller integration lifecycle e2e",
      jobRootDir: controllerJobRoot,
      authRootDir: authRoot,
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath,
      promptPath: controllerPrompt,
      taskId: controllerJobId,
      progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
      accounts: ["account-a"],
      tmuxSession: controllerJobId,
      accessBoundary: "project_scoped_control",
      projectAccessScope,
      networkAccess: "restricted",
      confirmCreate: true,
    }), "create Claude integration controller manifest");

    const stateDir = join(root, "controlled-state");
    const profile = buildClaudeControlledAgentProfile({
      stateDir,
      mcpCommand: process.execPath,
      mcpArgs: [join(process.cwd(), "dist/worker-codex/codex-goal-mcp.js")],
      mcpCwd: process.cwd(),
    });
    const openTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_open_integration_attempt`;
    const applyTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_apply_worker_output`;
    const checksTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_run_required_checks`;
    const commitTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_commit_approved_changes`;
    const pushTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_push_approved_commit`;
    const attemptId = `${prefix}attempt`;
    stateStore = new LocalControlledAgentStateStore({ rootDir: stateDir });
    provider = new ClaudeControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromClaudeOAuth({
        oauthToken: "ambient-claude-live-e2e-token-not-used",
      }),
      workspacePath,
      engine: new RealClaudeControlledEngine(),
      model: process.env.CLAUDE_LIVE_MODEL ?? "sonnet",
      controllerObjective: [
        "This is a subscription-runtime Claude controlled-agent integration lifecycle e2e.",
        "Use only MCP broker tools. Call these tools in order with the exact JSON shown.",
        `1. ${openTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          attemptId,
          workerJobId: "claude-integration-worker",
          workerWorkspacePath: workspacePath,
          workerCommitSha,
          targetWorkspacePath: workspacePath,
          targetBranch: branch,
          targetRemote: "origin",
          changedFiles: ["memory.txt"],
          approvedFiles: ["memory.txt"],
          allowedPathPrefixes: ["memory.txt"],
          requiredCheckIds: ["check:memory"],
          requiredChecks: [{
            checkId: "check:memory",
            command: [
              process.execPath,
              "-e",
              "const fs=require('fs');if(fs.readFileSync('memory.txt','utf8').trim()!=='after')process.exit(1)",
            ],
          }],
          reviewedBy: controllerJobId,
          reviewReason: "live Claude controlled controller reviewed sandbox worker output",
          confirmOpen: true,
        }),
        `2. ${applyTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          attemptId,
          confirmApply: true,
        }),
        `3. ${checksTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          attemptId,
          confirmRunChecks: true,
        }),
        `4. ${commitTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          attemptId,
          message: "test(worker): integrate claude controller output",
          allowedPathPrefixes: ["memory.txt"],
          requiredCheckIds: ["check:memory"],
          confirmCommit: true,
        }),
        `5. ${pushTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          attemptId,
          confirmPush: true,
        }),
        "After the fifth tool succeeds, reply with CLAUDE_CONTROLLED_INTEGRATION_OK.",
        "Do not use raw shell/git/tmux/filesystem tools.",
      ].join("\n"),
    });

    started = await startControlledAgentRun({
      controllerJobId,
      sessionId: `${controllerJobId}:claude-controlled-agent`,
      stateDir,
      boundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope,
      provider: profile.enforcement,
      networkAccess: NetworkAccessMode.Restricted,
    }, {
      provider,
      stateStore,
      events: stateStore,
    });
    assert(started.ok === true, "Claude integration controller live start must pass launch policy");

    const observed = await waitForControlledStatus({
      provider,
      session: started.session,
      run: started.run,
      timeoutMs: 360_000,
    });
    const providerSkip = claudeControlledProviderUnavailableSkip(observed);
    if (providerSkip) return providerSkip;
    assertEqual(observed.status, ControlledAgentRunStatus.Completed);
    const content = await readFile(join(workspacePath, "memory.txt"), "utf8");
    assertEqual(content.trim(), "after");
    const pushedSha = runChecked("git", [
      "--git-dir",
      remotePath,
      "rev-parse",
      `refs/heads/${branch}`,
    ]).stdout.trim();
    const localSha = runChecked("git", ["rev-parse", branch], {
      cwd: workspacePath,
    }).stdout.trim();
    assertEqual(pushedSha, localSha);
    const eventsText = await readFile(
      integrationAttemptEventsPath(controllerJobRoot, attemptId),
      "utf8",
    );
    assert(
      eventsText.includes('"type":"integration_attempt.opened"') &&
        eventsText.includes('"type":"integration_attempt.pushed"'),
      "Claude controller integration store must record lifecycle events",
    );
    return {
      root: keepArtifacts ? root : undefined,
      providerStatus: observed.status,
      pushedCommit: pushedSha,
    };
  } finally {
    if (provider && started?.ok === true && stateStore) {
      await stopControlledAgentRun({
        sessionId: started.session.sessionId,
        reason: "live_e2e_cleanup",
      }, {
        stateStore,
        provider,
        events: stateStore,
      }).catch(() => undefined);
    }
    await cleanup(root);
  }
}

async function claudeControlledControllerStartsChildWorker() {
  const skip = claudeProjectControlSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-project-control-");
  let provider = null;
  let stateStore = null;
  let started = null;
  let childTmuxSession = null;
  try {
    const sourceWorkspace = await gitSandbox(join(root, "source"), {
      "README.md": "Claude controller child-worker live sandbox only.\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: sourceWorkspace,
    }).stdout.trim();
    const remotePath = join(root, "remote.git");
    runChecked("git", ["init", "--bare", remotePath]);
    runChecked("git", ["remote", "add", "origin", remotePath], {
      cwd: sourceWorkspace,
    });
    const registryRootDir = join(root, "registry");
    const jobsRoot = join(root, "jobs");
    const worktreesRoot = join(root, "worktrees");
    const authRoot = codexAuthRoot;
    await mkdir(registryRootDir, { recursive: true });
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });

    const prefix = "claude-pc-live-e2e-";
    const controllerJobId = `${prefix}controller`;
    const childJobId = `${prefix}child`;
    childTmuxSession = childJobId;
    const controllerJobRoot = join(jobsRoot, controllerJobId);
    const childJobRoot = join(jobsRoot, childJobId);
    const childWorkspace = join(worktreesRoot, childJobId);
    const childOutputFile = "claude-controller-real-child-ok.txt";
    const childPatchPath = join(childWorkspace, "claude-controller-real-child-ok.patch");
    const controllerPrompt = join(controllerJobRoot, "prompt.md");
    const childPrompt = join(childJobRoot, "prompt.md");
    await mkdir(controllerJobRoot, { recursive: true });
    await mkdir(childJobRoot, { recursive: true });
    await writeFile(
      controllerPrompt,
      "Claude controller starts a real child worker through broker MCP tools.\n",
    );
    await writeFile(
      childPrompt,
      "Create claude-controller-real-child-ok.txt with exact content CLAUDE_CONTROLLER_REAL_CHILD_OK. Do not print secrets.\n",
    );

    const projectAccessScope = {
      projectId: "claude-project-control-live-e2e",
      registryRoot: registryRootDir,
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreesRoot],
      jobIdPrefixes: [prefix],
      tmuxSessionPrefixes: [prefix],
      allowedBranches: ["main", "master"],
      allowedGitRemotes: ["origin"],
      allowedAccountIds: codexAccounts,
    };
    assertToolOk(codexGoalTool("codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      description: "Sandbox Claude project-scoped controller child-worker e2e",
      jobRootDir: controllerJobRoot,
      authRootDir: join(root, "controller-auth"),
      stateRootDir: join(controllerJobRoot, "state"),
      workspacePath: sourceWorkspace,
      promptPath: controllerPrompt,
      taskId: controllerJobId,
      progressPath: join(controllerJobRoot, `${controllerJobId}.progress.json`),
      accounts: codexAccounts,
      tmuxSession: controllerJobId,
      accessBoundary: "project_scoped_control",
      projectAccessScope,
      networkAccess: "restricted",
      confirmCreate: true,
    }), "create Claude child-controller manifest");

    const stateDir = join(root, "controlled-state");
    const profile = buildClaudeControlledAgentProfile({
      stateDir,
      mcpCommand: process.execPath,
      mcpArgs: [join(process.cwd(), "dist/worker-codex/codex-goal-mcp.js")],
      mcpCwd: process.cwd(),
    });
    const createWorktreeTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_create_worktree`;
    const createJobTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_create_job`;
    const startTool =
      `mcp__${profile.mcpServerName}__codex_goal_project_start`;
    stateStore = new LocalControlledAgentStateStore({ rootDir: stateDir });
    provider = new ClaudeControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromClaudeOAuth({
        oauthToken: "ambient-claude-live-e2e-token-not-used",
      }),
      workspacePath: sourceWorkspace,
      engine: new RealClaudeControlledEngine(),
      model: process.env.CLAUDE_LIVE_MODEL ?? "sonnet",
      controllerObjective: [
        "This is a subscription-runtime Claude controlled-agent child-worker e2e.",
        "Use only MCP broker tools. Call these tools in order with the exact JSON shown.",
        `1. ${createWorktreeTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          sourceWorkspacePath: sourceWorkspace,
          path: childWorkspace,
          confirmCreateWorktree: true,
        }),
        `2. ${createJobTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          jobId: childJobId,
          description: "Sandbox child real Codex worker started by Claude controller",
          jobRootDir: childJobRoot,
          authRootDir: authRoot,
          stateRootDir: join(childJobRoot, "state"),
          workspacePath: childWorkspace,
          promptPath: childPrompt,
          taskId: childJobId,
          progressPath: join(childJobRoot, `${childJobId}.progress.json`),
          accounts: codexAccounts,
          tmuxSession: childTmuxSession,
          model: process.env.CODEX_LIVE_MODEL ?? "gpt-5.5",
          reasoningEffort: process.env.CODEX_LIVE_EFFORT ?? "high",
          serviceTier: process.env.CODEX_LIVE_SERVICE_TIER ?? "fast",
          executionEngine: "app-server-goal",
          taskTimeoutMs: 10 * 60 * 1000,
          maxAccountCycles: 1,
          accessBoundary: "isolated_workspace_write",
          networkAccess: "restricted",
          confirmCreate: true,
        }),
        `3. ${startTool}:`,
        JSON.stringify({
          registryRootDir,
          controllerJobId,
          jobId: childJobId,
          confirmStart: true,
        }),
        "After the third tool succeeds, reply with CLAUDE_CONTROLLER_STARTED_CHILD_OK.",
        "Do not wait for the child result and do not use raw shell/git/tmux/filesystem tools.",
      ].join("\n"),
    });

    started = await startControlledAgentRun({
      controllerJobId,
      sessionId: `${controllerJobId}:claude-controlled-agent`,
      stateDir,
      boundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope,
      provider: profile.enforcement,
      networkAccess: NetworkAccessMode.Restricted,
    }, {
      provider,
      stateStore,
      events: stateStore,
    });
    assert(started.ok === true, "Claude child-controller live start must pass launch policy");

    const observed = await waitForControlledStatus({
      provider,
      session: started.session,
      run: started.run,
      timeoutMs: 360_000,
    });
    const providerSkip = claudeControlledProviderUnavailableSkip(observed);
    if (providerSkip) return providerSkip;
    assertEqual(observed.status, ControlledAgentRunStatus.Completed);

    const result = await waitForClaudeControllerChildResult({
      registryRootDir,
      jobId: childJobId,
      workspacePath: childWorkspace,
      outputFile: childOutputFile,
      expectedContent: "CLAUDE_CONTROLLER_REAL_CHILD_OK",
    });
    if (result.skipped) return result;
    runChecked("git", ["add", "-N", childOutputFile], { cwd: childWorkspace });
    const childPatch = runChecked("git", ["diff", "--", childOutputFile], {
      cwd: childWorkspace,
    }).stdout;
    assert(childPatch.includes(childOutputFile), "Claude child output patch must include marker file");
    await writeFile(childPatchPath, childPatch);

    const attemptId = `${prefix}attempt`;
    assertToolOk(codexGoalTool("codex_goal_project_open_integration_attempt", {
      registryRootDir,
      controllerJobId,
      attemptId,
      workerJobId: childJobId,
      workerWorkspacePath: childWorkspace,
      workerPatchPath: childPatchPath,
      targetWorkspacePath: sourceWorkspace,
      targetBranch: branch,
      targetRemote: "origin",
      changedFiles: [childOutputFile],
      approvedFiles: [childOutputFile],
      allowedPathPrefixes: [childOutputFile],
      requiredCheckIds: ["check:marker"],
      requiredChecks: [{
        checkId: "check:marker",
        command: [
          process.execPath,
          "-e",
          "const fs=require('fs');if(fs.readFileSync('claude-controller-real-child-ok.txt','utf8').trim()!=='CLAUDE_CONTROLLER_REAL_CHILD_OK')process.exit(1)",
        ],
      }],
      reviewedBy: controllerJobId,
      reviewReason: "live Claude controller child marker output reviewed by e2e",
      confirmOpen: true,
    }), "open Claude child integration attempt");
    assertToolOk(codexGoalTool("codex_goal_project_apply_worker_output", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmApply: true,
    }), "apply Claude child output");
    assertToolOk(codexGoalTool("codex_goal_project_run_required_checks", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmRunChecks: true,
    }), "run Claude child integration checks");
    const committed = assertToolOk(codexGoalTool(
      "codex_goal_project_commit_approved_changes",
      {
        registryRootDir,
        controllerJobId,
        attemptId,
        message: "test(worker): integrate claude controller child output",
        allowedPathPrefixes: [childOutputFile],
        requiredCheckIds: ["check:marker"],
        confirmCommit: true,
      },
    ), "commit Claude child output");
    assertToolOk(codexGoalTool("codex_goal_project_push_approved_commit", {
      registryRootDir,
      controllerJobId,
      attemptId,
      confirmPush: true,
    }), "push Claude child output");

    const commitSha = committed.attempt?.commitCandidate?.commitSha;
    const pushedSha = runChecked("git", [
      "--git-dir",
      remotePath,
      "rev-parse",
      `refs/heads/${branch}`,
    ]).stdout.trim();
    assertEqual(pushedSha, commitSha);
    const auditText = await readFile(
      join(controllerJobRoot, `${controllerJobId}.project-control-events.jsonl`),
      "utf8",
    );
    assert(
      auditText.includes('"operation":"start_worker"'),
      "Claude controller audit must record start_worker",
    );
    return {
      root: keepArtifacts ? root : undefined,
      providerStatus: observed.status,
      changedFiles: result.changedFiles,
      integrationCommit: commitSha,
    };
  } finally {
    if (provider && started?.ok === true && stateStore) {
      await stopControlledAgentRun({
        sessionId: started.session.sessionId,
        reason: "live_e2e_cleanup",
      }, {
        stateStore,
        provider,
        events: stateStore,
      }).catch(() => undefined);
    }
    if (childTmuxSession) killTmuxSession(childTmuxSession);
    await cleanup(root);
  }
}

async function codexRealAppServerCommandApprovalDeniesRawPush() {
  const skip = codexSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("codex-real-command-approval-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Codex raw push approval sandbox only.\n",
    });
    const branch = runChecked("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspacePath,
    }).stdout.trim();
    const remotePath = join(root, "remote.git");
    runChecked("git", ["init", "--bare", remotePath]);
    runChecked("git", ["remote", "add", "origin", remotePath], {
      cwd: workspacePath,
    });
    const plan = buildLaunchPlan({
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Restricted,
      scope: {
        projectId: "codex-real-command-approval-e2e",
        registryRoot: join(root, "registry"),
        isolatedWorkspaceRoot: workspacePath,
        workspaceRoots: [workspacePath],
        allowedBranches: [branch],
        allowedGitRemotes: ["origin"],
      },
      adapter: {
        canEnforceFilesystemPolicy: true,
        canIsolateHome: true,
        canIsolateTemp: true,
        canDisableRawShell: false,
        canBrokerProjectControl: false,
        canRestrictNetwork: true,
      },
    });
    assertEqual(plan.status, LaunchPlanStatus.Ready);
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath,
      maxAccountCycles: 1,
      accounts: [
        realCodexAccount(root, "command-approval", {
          commandPolicy: plan.commandPolicy,
        }),
      ],
    });
    const result = await executor.run({
      jobId: "codex-live-command-approval",
      taskId: "codex-live-command-approval-task",
      prompt: [
        "This is a subscription-runtime sandbox e2e.",
        "Attempt exactly this shell command once:",
        "git push origin HEAD:refs/heads/raw-bypass-test",
        "Do not create or edit files.",
        "If the command is denied, reply with COMMAND_DENIED.",
      ].join("\n"),
      controls: { editMode: "allow-edits" },
    });
    await executor.dispose();
    const providerSkip = codexProviderUnavailableSkip(result);
    if (providerSkip) return providerSkip;
    const pushed = spawnSync("git", [
      "--git-dir",
      remotePath,
      "rev-parse",
      "refs/heads/raw-bypass-test",
    ], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert(pushed.status !== 0, "raw push bypass must not update sandbox remote");
    runChecked("git", [
      "push",
      "origin",
      "HEAD:refs/heads/control-push-test",
    ], {
      cwd: workspacePath,
    });
    const denialEvidence = codexRawPushDenialEvidence(result);
    assert(
      denialEvidence !== null,
      "real app-server raw push attempt must produce denial evidence",
    );
    return {
      root: keepArtifacts ? root : undefined,
      denialEvidence,
    };
  } finally {
    await cleanup(root);
  }
}

function codexRawPushDenialEvidence(result) {
  const serialized = JSON.stringify(result);
  if (serialized.includes("codex_app_server_command_approval_denied")) {
    return "app_server_command_approval";
  }
  if (serialized.includes("command_policy.denied")) {
    return "runtime_command_policy";
  }
  if (result?.result?.outputText === "COMMAND_DENIED") {
    return "agent_denied_marker";
  }
  if (result?.outputSummary === "COMMAND_DENIED") {
    return "agent_denied_marker";
  }
  const outputText = String(
    result?.result?.outputText ?? result?.outputSummary ?? "",
  ).toLowerCase();
  if (
    outputText.includes("remote rejected") ||
    outputText.includes("not sandbox-denied") ||
    outputText.includes("not sandbox denied")
  ) {
    if (codexRawPushLooksLikeAttemptedFailure(outputText)) {
      return "sandbox_external_write_blocked";
    }
    return null;
  }
  if (
    outputText.includes("sandbox") && outputText.includes("denied") ||
    outputText.includes("operation not permitted") ||
    outputText.includes("not permitted") ||
    outputText.includes("permission denied") ||
    outputText.includes("network") && outputText.includes("denied") ||
    outputText.includes("blocked by sandbox")
  ) {
    return "sandbox_denied_output";
  }
  if (codexRawPushLooksLikeAttemptedFailure(outputText)) {
    return "sandbox_external_write_blocked";
  }
  return null;
}

function codexRawPushLooksLikeAttemptedFailure(outputText) {
  return (
    outputText.includes("attempted") ||
    outputText.includes("git push") ||
    outputText.includes("command")
  ) && (
    outputText.includes("failed") ||
    outputText.includes("failure") ||
    outputText.includes("unpacker error") ||
    outputText.includes("denied") ||
    outputText.includes("not permitted") ||
    outputText.includes("permission")
  );
}

async function claudeInboxReadOnly() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-inbox-readonly-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Claude live read-only sandbox only.\n",
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir: root }),
    });
    const signal = await controlInbox.enqueueSignal({
      target: { jobId: "claude-live-readonly-job" },
      intent: "guidance",
      deliveryMode: "next_safe_point",
      body:
        "For this sandbox live e2e, return exactly CLAUDE_WORKER_INBOX_OK.",
      createdBy: "operator",
      idempotencyKey: "claude-live-readonly-guidance",
    });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-live-readonly-provider",
      stateRootDir: root,
      encryptionKey: randomBytes(32),
      engine: new RealClaudePrintEngine(),
      controlInbox,
      workspace: new FixedWorkspace(workspacePath),
      workspacePath,
      model: "sonnet",
    });
    await worker.start();
    await worker.seedClaudeOAuth({
      oauthToken: "dummy-token-not-used-by-real-cli-engine",
    });
    const first = await worker.run({
      jobId: "claude-live-readonly-job",
      runId: "claude-live-readonly-run-1",
      prompt:
        "If an updated task from operator is present, follow it exactly. If no operator update is present, return exactly CLAUDE_WORKER_BASE.",
    });
    const second = await worker.run({
      jobId: "claude-live-readonly-job",
      runId: "claude-live-readonly-run-2",
      prompt: "Return exactly CLAUDE_WORKER_SECOND.",
    });
    await worker.dispose();
    const views = await controlInbox.listSignals({
      target: { jobId: "claude-live-readonly-job" },
      includeBodies: false,
    });
    assert(first.outputText.includes("CLAUDE_WORKER_INBOX_OK"), "Claude must follow inbox guidance");
    assert(second.outputText.includes("CLAUDE_WORKER_SECOND"), "Claude second run must not receive stale guidance");
    assert(first.workerControlSignalIds?.includes(signal.signalId), "Claude result must include delivered signal id");
    assertEqual(views[0]?.state, "delivered");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

async function claudeInboxEdit() {
  const skip = claudeSkipReason();
  if (skip) return { skipped: true, reason: skip };
  const root = await sandboxRoot("claude-inbox-edit-");
  try {
    const workspacePath = await gitSandbox(join(root, "workspace"), {
      "README.md": "Claude live edit sandbox only.\n",
    });
    const controlInbox = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({ rootDir: root }),
    });
    const signal = await controlInbox.enqueueSignal({
      target: { jobId: "claude-live-edit-job" },
      intent: "guidance",
      deliveryMode: "next_safe_point",
      body:
        "For this sandbox live e2e, create claude-result.txt with exactly two lines: CLAUDE_EDIT_INBOX_OK and inbox-guidance-applied. Verify the file exists before finishing. Do not use the base file content.",
      createdBy: "operator",
      idempotencyKey: "claude-live-edit-guidance",
    });
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-live-edit-provider",
      stateRootDir: root,
      encryptionKey: randomBytes(32),
      engine: new RealClaudeEditEngine(),
      controlInbox,
      workspace: new FixedWorkspace(workspacePath),
      workspacePath,
      model: "sonnet",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
    });
    await worker.start();
    await worker.seedClaudeOAuth({
      oauthToken: "dummy-token-not-used-by-real-cli-engine",
    });
    const result = await worker.run({
      jobId: "claude-live-edit-job",
      runId: "claude-live-edit-run-1",
      prompt:
        "Create claude-result.txt with exactly two lines: CLAUDE_EDIT_BASE and base-instruction-used. Verify the file exists before finishing.",
    });
    await worker.dispose();
    const content = await readFile(join(workspacePath, "claude-result.txt"), "utf8");
    const views = await controlInbox.listSignals({
      target: { jobId: "claude-live-edit-job" },
      includeBodies: false,
    });
    assertEqual(content.trim(), "CLAUDE_EDIT_INBOX_OK\ninbox-guidance-applied");
    assert(result.workerControlSignalIds?.includes(signal.signalId), "Claude edit result must include delivered signal id");
    assertEqual(views[0]?.state, "delivered");
    assertGitStatus(workspacePath, "?? claude-result.txt");
    return { root: keepArtifacts ? root : undefined };
  } finally {
    await cleanup(root);
  }
}

function codexSkipReason() {
  if (!allowLive) return "set SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 or pass --allow-live";
  if (codexAccounts.length === 0) {
    return `missing Codex auth slots: ${
      requestedCodexAccounts.map((account) =>
        redactPath(codexAuthJsonPathFor(account))
      ).join(", ")
    }`;
  }
  if (!hasCommand("codex")) return "codex command not found";
  return null;
}

function codexAccountsFromEnv() {
  const raw = process.env.CODEX_LIVE_ACCOUNTS ??
    process.env.CODEX_LIVE_ACCOUNT ??
    "account-a";
  return raw.split(",").map((account) => account.trim()).filter(Boolean);
}

function codexAuthJsonPathFor(account) {
  return join(codexAuthRoot, account, "auth.json");
}

function claudeSkipReason() {
  if (!allowLive) return "set SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 or pass --allow-live";
  if (!hasCommand("claude")) return "claude command not found";
  return null;
}

function claudeProjectControlSkipReason() {
  return claudeSkipReason() ?? codexProjectControlSkipReason();
}

function codexProjectControlSkipReason() {
  return codexSkipReason() ?? (!hasCommand("tmux") ? "tmux command not found" : null);
}

function realCodexAccount(root, suffix, options = {}) {
  return {
    codexAuthJsonPath: options.authJsonPath ?? codexAuthJsonPath,
    worker: codexWorker(root, suffix, {
      capacityAccountId: codexAccount,
      ...options,
    }),
  };
}

function codexWorker(root, suffix, overrides = {}) {
  return {
    providerInstanceId: `live-codex-${suffix}`,
    stateRootDir: join(root, "state"),
    codexBinaryPath: "codex",
    encryptionKey: randomBytes(32),
    executionEngine: "app-server-goal",
    capacityAccountId: codexAccount,
    taskTimeoutMs: 10 * 60 * 1000,
    model: process.env.CODEX_LIVE_MODEL ?? "gpt-5.5",
    reasoningEffort: process.env.CODEX_LIVE_EFFORT ?? "xhigh",
    serviceTier: process.env.CODEX_LIVE_SERVICE_TIER ?? "fast",
    sourceEnv: process.env,
    capacityPolicy: {
      quotaCooldownMs: 60_000,
      reconnectCooldownMs: 60_000,
      maxReconnectRetriesPerAccount: 1,
    },
    ...overrides,
  };
}

class StaticRunner {
  runnerId = "node-process";
  capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process",
  };

  constructor(result) {
    this.result = result;
  }

  async run() {
    return { ...this.result, durationMs: 1 };
  }
}

class FixedWorkspace {
  workspaceId = "fixed-live-sandbox";
  capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: false,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  constructor(path) {
    this.path = path;
  }

  async create() {
    return { path: this.path };
  }
}

class RealClaudePrintEngine {
  kind = "real-claude-print-e2e";
  capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: false,
    supportsProviderRunId: true,
    supportsCleanup: false,
  };

  async run(input) {
    return runClaude(input, ["--tools", ""]);
  }
}

class RealClaudeEditEngine {
  kind = "real-claude-edit-e2e";
  capabilities = {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsUsage: false,
    supportsProviderRunId: true,
    supportsCleanup: false,
  };

  async run(input) {
    return runClaude(input, [
      "--tools",
      "Read,Write,Edit,Bash",
      "--allowedTools",
      "Read,Write,Edit,Bash",
      "--permission-mode",
      "acceptEdits",
    ]);
  }
}

class RealClaudeControlledEngine {
  kind = "real-claude-controlled-e2e";
  capabilities = {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsUsage: false,
    supportsProviderRunId: true,
    supportsCleanup: false,
  };

  async run(input) {
    return runClaudeControlled(input);
  }
}

function runClaude(input, extraArgs) {
  const systemPromptArgs = input.appendSystemPrompt
    ? ["--append-system-prompt", input.appendSystemPrompt]
    : [];
  const child = spawnSync("claude", [
    "-p",
    "--model",
    process.env.CLAUDE_LIVE_MODEL ?? "sonnet",
    "--effort",
    process.env.CLAUDE_LIVE_EFFORT ?? "high",
    "--max-budget-usd",
    process.env.CLAUDE_LIVE_MAX_BUDGET_USD ?? "0.75",
    ...systemPromptArgs,
    ...extraArgs,
    "--no-session-persistence",
    input.prompt,
  ], {
    cwd: input.workspacePath,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 180_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`claude exited ${child.status}: ${safeTail(child.stderr || child.stdout)}`);
  }
  return {
    outputText: child.stdout.trim(),
    telemetry: { providerRunId: "real-claude-live-e2e" },
    warnings: [],
  };
}

function runClaudeControlled(input) {
  const systemPromptArgs = input.appendSystemPrompt
    ? ["--append-system-prompt", input.appendSystemPrompt]
    : [];
  const mcpConfigArgs = (input.mcpConfig ?? []).flatMap((config) => [
    "--mcp-config",
    config,
  ]);
  const strictMcpArgs = input.strictMcpConfig ? ["--strict-mcp-config"] : [];
  const allowedToolArgs = input.allowedTools
    ? ["--allowedTools", input.allowedTools.join(",")]
    : [];
  const disallowedToolArgs = input.disallowedTools
    ? ["--disallowedTools", input.disallowedTools.join(",")]
    : [];
  const child = spawnSync("claude", [
    "-p",
    "--model",
    process.env.CLAUDE_LIVE_MODEL ?? input.model ?? "sonnet",
    "--effort",
    process.env.CLAUDE_LIVE_EFFORT ?? "high",
    "--max-budget-usd",
    process.env.CLAUDE_CONTROLLED_LIVE_MAX_BUDGET_USD ??
      process.env.CLAUDE_LIVE_MAX_BUDGET_USD ??
      "1.25",
    ...systemPromptArgs,
    ...mcpConfigArgs,
    ...strictMcpArgs,
    ...allowedToolArgs,
    ...disallowedToolArgs,
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    input.prompt,
  ], {
    cwd: input.workspacePath,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: Number(process.env.CLAUDE_CONTROLLED_LIVE_TIMEOUT_MS ?? "420000"),
  });
  if (child.error) throw child.error;
  const stdout = input.redactor.redact((child.stdout ?? "").trim());
  const stderr = input.redactor.redact((child.stderr ?? "").trim());
  input.redactor.assertNoKnownSecret(stdout, "claude-controlled-live-stdout");
  input.redactor.assertNoKnownSecret(stderr, "claude-controlled-live-stderr");
  if (child.status !== 0) {
    throw new Error(`claude controlled exited ${child.status}: ${safeTail(stderr || stdout)}`);
  }
  return {
    outputText: stdout,
    telemetry: { providerRunId: "real-claude-controlled-live-e2e" },
    warnings: stderr
      ? [{
          code: "claude_controlled_live_stderr",
          safeMessage: "Claude controlled live e2e wrote diagnostics to stderr.",
          details: { stderrPreview: safeTail(stderr) },
        }]
      : [],
  };
}

function codexProviderUnavailableSkip(result) {
  if (result?.status === "completed") return null;
  const reasons = (result?.attempts ?? [])
    .map((attempt) => attempt.failureReason)
    .filter(Boolean);
  const unavailableReasons = new Set([
    "account_unavailable",
    "capacity_unavailable",
    "quota_limited",
  ]);
  if (
    reasons.length > 0 &&
    reasons.every((reason) => unavailableReasons.has(reason))
  ) {
    return {
      skipped: true,
      reason: `Codex live account unavailable: ${[...new Set(reasons)].join(",")}`,
    };
  }
  return null;
}

async function sandboxRoot(prefix) {
  return mkdtemp(join(tmpdir(), `subscription-runtime-${prefix}`));
}

async function gitSandbox(path, files) {
  await mkdir(path, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(join(path, relativePath), content);
  }
  runChecked("git", ["init"], { cwd: path });
  runChecked("git", ["config", "user.email", "subscription-runtime-e2e@example.test"], {
    cwd: path,
  });
  runChecked("git", ["config", "user.name", "Subscription Runtime E2E"], {
    cwd: path,
  });
  runChecked("git", ["add", "."], { cwd: path });
  runChecked("git", ["commit", "-m", "test: initial sandbox"], { cwd: path });
  return path;
}

function assertGitStatus(workspacePath, expected) {
  const status = runChecked("git", ["status", "--short"], {
    cwd: workspacePath,
  }).stdout.trim();
  assertEqual(status, expected);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${safeTail(result.stderr || result.stdout)}`);
  }
  return result;
}

async function withCodexGoalMcpClient(action) {
  const server = createCodexGoalMcpServer();
  const client = new Client({
    name: "subscription-runtime-live-e2e",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function codexGoalMcpTool(client, name, args) {
  return parseMcpJsonResult(await client.callTool({
    name,
    arguments: args ?? {},
  }));
}

function parseMcpJsonResult(result) {
  if (result && typeof result === "object" && "structuredContent" in result) {
    return result.structuredContent;
  }
  const content = result && typeof result === "object" && Array.isArray(result.content)
    ? result.content
    : undefined;
  const first = content?.[0];
  if (first && typeof first === "object" && first.type === "text" &&
    typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      return { text: first.text };
    }
  }
  return result;
}

function codexGoalTool(name, args) {
  const result = runChecked(process.execPath, [
    join(process.cwd(), "dist/worker-codex/codex-goal-cli.js"),
    "tool",
    name,
    "--args-json",
    JSON.stringify(args),
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${name} returned non-json output: ${safeTail(result.stdout)}`);
  }
}

function assertToolOk(result, label) {
  if (result?.ok !== true) {
    throw new Error(`${label} failed: ${safeTail(JSON.stringify(result))}`);
  }
  return result;
}

function integrationAttemptEventsPath(controllerJobRoot, attemptId) {
  const hash = createHash("sha256").update(attemptId).digest("hex");
  return join(
    controllerJobRoot,
    "project-integration",
    "integration-attempts",
    hash,
    "events.jsonl",
  );
}

async function assertCommandPolicyDenied(runner, input, expectedReason) {
  try {
    await runner.run({
      ...input,
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
  } catch (error) {
    assert(
      String(error instanceof Error ? error.message : error).includes(
        `command_policy_denied:${expectedReason}`,
      ),
      `expected ${expectedReason}, got ${safeError(error).message}`,
    );
    return;
  }
  throw new Error(`expected command policy denial: ${expectedReason}`);
}

async function waitForCodexProjectChildResult(input) {
  const markerPath = join(input.workspacePath, "project-control-real-codex-ok.txt");
  let lastBrief = null;
  for (let index = 0; index < 90; index += 1) {
    lastBrief = codexGoalTool("codex_goal_brief", {
      registryRootDir: input.registryRootDir,
      jobId: input.jobId,
      tailLines: 20,
      staleAfterMs: 120_000,
    });
    const brief = lastBrief.brief ?? {};
    const status = lastBrief.status ?? {};
    const markerExists = existsSync(markerPath);
    const done =
      status.tmuxAlive === false &&
      (status.resultStatus === "done" ||
        brief.progressStatus === "completed" ||
        brief.progressResultStatus === "completed");
    if (markerExists && done) {
      const content = await readFile(markerPath, "utf8");
      assertEqual(content.trim(), "PROJECT_CONTROL_REAL_CODEX_OK");
      assertGitStatus(input.workspacePath, "?? project-control-real-codex-ok.txt");
      return {
        changedFiles: brief.changedFiles ?? status.changedFiles ?? [],
      };
    }
    if (status.tmuxAlive === false) {
      const providerSkip = codexBriefProviderUnavailableSkip(lastBrief);
      if (providerSkip) return providerSkip;
    }
    if (
      status.tmuxAlive === false &&
      (status.resultStatus === "failed" || brief.progressStatus === "failed")
    ) {
      throw new Error(`project child failed: ${safeTail(JSON.stringify(lastBrief))}`);
    }
    await sleep(5_000);
  }
  throw new Error(`project child timed out: ${safeTail(JSON.stringify(lastBrief))}`);
}

async function waitForClaudeControllerChildResult(input) {
  const markerPath = join(input.workspacePath, input.outputFile);
  let lastBrief = null;
  for (let index = 0; index < 90; index += 1) {
    lastBrief = codexGoalTool("codex_goal_brief", {
      registryRootDir: input.registryRootDir,
      jobId: input.jobId,
      tailLines: 20,
      staleAfterMs: 120_000,
    });
    const brief = lastBrief.brief ?? {};
    const status = lastBrief.status ?? {};
    const markerExists = existsSync(markerPath);
    const done =
      status.tmuxAlive === false &&
      (status.resultStatus === "done" ||
        brief.progressStatus === "completed" ||
        brief.progressResultStatus === "completed");
    if (markerExists && done) {
      const content = await readFile(markerPath, "utf8");
      assertEqual(content.trim(), input.expectedContent);
      assertGitStatus(input.workspacePath, `?? ${input.outputFile}`);
      return {
        changedFiles: brief.changedFiles ?? status.changedFiles ?? [],
      };
    }
    if (status.tmuxAlive === false) {
      const providerSkip = codexBriefProviderUnavailableSkip(lastBrief);
      if (providerSkip) return providerSkip;
    }
    if (
      status.tmuxAlive === false &&
      (status.resultStatus === "failed" || brief.progressStatus === "failed")
    ) {
      throw new Error(`Claude controller child failed: ${safeTail(JSON.stringify(lastBrief))}`);
    }
    await sleep(5_000);
  }
  throw new Error(`Claude controller child timed out: ${safeTail(JSON.stringify(lastBrief))}`);
}

async function waitForControlledFileOrTerminal(input) {
  const deadline = Date.now() + input.timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    if (existsSync(input.path)) return observed;
    observed = input.provider.status({
      session: input.session,
      run: input.run,
    });
    if (observed.status !== ControlledAgentRunStatus.Running) return observed;
    await sleep(2_000);
  }
  return observed;
}

async function waitForControlledStatus(input) {
  const deadline = Date.now() + input.timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    observed = input.provider.status({
      session: input.session,
      run: input.run,
    });
    if (observed.status !== ControlledAgentRunStatus.Running) return observed;
    await sleep(2_000);
  }
  return observed ?? input.provider.status({
    session: input.session,
    run: input.run,
  });
}

async function waitForProjectControllerMcpStatus(input) {
  const deadline = Date.now() + input.timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    observed = assertToolOk(await codexGoalMcpTool(
      input.client,
      "codex_goal_project_controller_status",
      {
        registryRootDir: input.registryRootDir,
        controllerJobId: input.controllerJobId,
        providerKind: input.providerKind,
      },
    ), "production Claude controller status");
    const status = projectControllerProviderStatus(observed);
    if (status !== ControlledAgentRunStatus.Running) return observed;
    await sleep(2_000);
  }
  return observed ?? assertToolOk(await codexGoalMcpTool(
    input.client,
    "codex_goal_project_controller_status",
    {
      registryRootDir: input.registryRootDir,
      controllerJobId: input.controllerJobId,
      providerKind: input.providerKind,
    },
  ), "production Claude controller status");
}

function projectControllerProviderStatus(value) {
  return value?.providerObserved?.status ?? value?.run?.status ?? "unknown";
}

function projectControllerProviderSafeMessage(value) {
  return value?.providerObserved?.safeMessage ?? value?.run?.safeMessage ??
    value?.safeMessage ?? "";
}

function codexControlledProviderUnavailableSkip(status) {
  if (!status || status.status !== ControlledAgentRunStatus.Failed) return null;
  const message = String(status.safeMessage ?? "").toLowerCase();
  if (
    message.includes("usage limit") ||
    message.includes("capacity") ||
    message.includes("quota") ||
    message.includes("account_unavailable") ||
    message.includes("session is invalid") ||
    message.includes("provider_session_invalid")
  ) {
    return {
      skipped: true,
      reason: `Codex live account unavailable: ${safeTail(status.safeMessage ?? status.status)}`,
    };
  }
  return null;
}

function claudeControlledProviderUnavailableSkip(status) {
  if (!status || status.status !== ControlledAgentRunStatus.Failed) return null;
  const message = String(status.safeMessage ?? "").toLowerCase();
  if (
    message.includes("not authenticated") ||
    message.includes("login") ||
    message.includes("invalid api key") ||
    message.includes("oauth") ||
    message.includes("usage limit") ||
    message.includes("quota") ||
    message.includes("rate limit")
  ) {
    return {
      skipped: true,
      reason: `Claude live account unavailable: ${safeTail(status.safeMessage ?? status.status)}`,
    };
  }
  return null;
}

function codexBriefProviderUnavailableSkip(value) {
  const brief = value?.brief ?? {};
  const status = value?.status ?? {};
  const reason =
    brief.progressResultReason ??
    brief.lastFailureReason ??
    status.resultReason ??
    status.progressResultReason;
  const unavailableReasons = new Set([
    "account_unavailable",
    "capacity_unavailable",
    "quota_limited",
  ]);
  return unavailableReasons.has(reason)
    ? { skipped: true, reason: `Codex live account unavailable: ${reason}` }
    : null;
}

function killTmuxSession(sessionName) {
  spawnSync("tmux", ["kill-session", "-t", sessionName], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup(root) {
  if (keepArtifacts) return;
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}

function hasCommand(command) {
  const result = spawnSync(command, commandVersionArgs(command), {
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.status === 0;
}

function commandVersionArgs(command) {
  return command === "tmux" ? ["-V"] : ["--version"];
}

function scenarioFilter() {
  const cliOnly = process.argv
    .find((arg) => arg.startsWith("--only="))
    ?.slice("--only=".length);
  const raw = cliOnly ?? process.env.SUBSCRIPTION_RUNTIME_LIVE_E2E_ONLY ?? "";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldRunScenario(name) {
  if (onlyScenarios.length === 0) return true;
  const key = scenarioKey(name);
  return onlyScenarios.some((item) => item === name || scenarioKey(item) === key);
}

function scenarioKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fakeCodexAuthJson(refreshToken) {
  const fakeJwt = [
    base64UrlJson({ alg: "RS256", kid: "fake", typ: "JWT" }),
    base64UrlJson({
      iss: "https://auth.openai.com",
      sub: "fake-quota-account",
      aud: ["app_fake"],
      email: "fake-quota@example.test",
      iat: 1780000000,
      exp: 1990000000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "fake-quota-account",
        chatgpt_plan_type: "pro",
        user_id: "fake-user",
      },
    }),
    "signature",
  ].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: refreshToken,
      access_token: `access-${refreshToken}`,
      id_token: fakeJwt,
    },
    last_refresh: "2026-06-30T00:00:00.000Z",
  });
}

function resolveHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sanitizeDetail(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return item;
    return redactSensitive(item);
  }));
}

function safeError(error) {
  return {
    message: redactSensitive(error instanceof Error ? error.message : String(error)),
  };
}

function safeTail(value) {
  return redactSensitive(String(value).slice(-1200));
}

function redactPath(path) {
  return path.replace(homedir(), "~");
}

function redactSensitive(value) {
  return value
    .replace(/refresh_token["=: ]+[^",\s]+/gi, "refresh_token:<redacted>")
    .replace(/access_token["=: ]+[^",\s]+/gi, "access_token:<redacted>")
    .replace(/id_token["=: ]+[^",\s]+/gi, "id_token:<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>");
}

class E2EStaticRunner {
  runnerId = "e2e-static";

  capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsCwd: true,
    supportsTimeout: true,
  };

  async run() {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
}

await main();
