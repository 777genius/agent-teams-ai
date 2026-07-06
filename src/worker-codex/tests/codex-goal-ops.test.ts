import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  AccessBoundary,
  NetworkAccessMode,
  RunProcessAliveReason,
  RunProcessSupervisorKind,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalAccountSlots,
  codexGoalProgressPath,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  CodexGoalRuntimeResultReconciler,
  listCodexGoalAccountStatuses,
  reconcileCodexGoalRuntimeResult,
  resolveCodexGoalWorkerLiveness,
  startCodexGoalTmux,
  summarizeCodexGoalProcessTree,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";
import {
  availableCodexGoalAccountSlots,
  buildCodexGoalBrief,
  dedupeCodexGoalAccountSlots,
  visibleCodexGoalAccountPoolSlots,
} from "../codex-goal-mcp";

const execFileAsync = promisify(execFile);

describe("codex goal ops", () => {
  it("builds dry-run commands without embedding auth material", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);

    const noTmux = buildCodexGoalNoTmuxCommand(launch);
    const tmux = buildCodexGoalTmuxCommand(launch);

    expect(noTmux).toContain("subscription-runtime-codex-goal run --no-tmux");
    expect(noTmux).toContain("--accounts account-a");
    expect(noTmux).toContain("--effort xhigh");
    expect(noTmux).not.toContain("refresh-secret");
    expect(tmux.preview).toContain("tmux new-session");
    expect(tmux.preview).toContain("tee -a");
  });

  it("fails closed before building a Codex project-scoped-control launch command", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput({
      ...fixture.config,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        projectId: "infinity-context",
        workspaceRoots: [fixture.config.workspacePath],
        jobIdPrefixes: ["infinity-context-"],
      },
    }, fixture.root);

    expect(() => buildCodexGoalNoTmuxCommand(launch)).toThrow(
      /codex_goal_access_boundary_blocked/,
    );
    expect(() => buildCodexGoalTmuxCommand(launch)).toThrow(
      /codex_goal_access_boundary_blocked/,
    );
  });

  it("does not pass global extra writable roots into project-scoped launches", async () => {
    const fixture = await createGoalFixture();
    const previous = process.env.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS;
    process.env.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS = "/unsafe/global";
    try {
      const regular = buildCodexGoalNoTmuxCommand(launchInput(fixture.config, fixture.root));
      expect(regular).toContain("SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS");
      expect(regular).toContain("/unsafe/global");

      const scoped = buildCodexGoalNoTmuxCommand(launchInput({
        ...fixture.config,
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [fixture.config.workspacePath],
          jobIdPrefixes: ["infinity-context-"],
        },
      }, fixture.root));
      expect(scoped).toContain("--project-access-scope-json");
      expect(scoped).toContain("SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS=1");
      expect(scoped).toContain("SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS=");
      expect(scoped).not.toContain("/unsafe/global");
    } finally {
      if (previous === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS = previous;
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("creates job-root and artifact directories before starting tmux", async () => {
    if (!(await hasTmux())) return;

    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-paths-"));
    const jobRootDir = join(root, "missing-job-root");
    const workspacePath = join(root, "workspace");
    const promptPath = join(root, "prompt.md");
    const tmuxSession = `subscription-runtime-start-paths-${process.pid}-${Date.now()}`;
    const launch: CodexGoalLaunchInput = {
      config: {
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath,
        promptPath,
        taskId: "task-1",
        accounts: codexGoalAccountSlots(["account-a"]),
        outputPath: join(jobRootDir, "nested", "task-1.latest-result.json"),
        progressPath: join(jobRootDir, "nested", "task-1.progress.json"),
      },
      tmuxSession,
      cwd: root,
      logPath: join(jobRootDir, "logs", "task-1.log"),
      cliCommand: ["/bin/true"],
      format: "json",
    };

    await mkdir(workspacePath, { recursive: true });
    await writeFile(promptPath, "Return ok.\n");

    try {
      await startCodexGoalTmux(launch);

      await access(jobRootDir);
      await access(join(jobRootDir, "logs"));
      await access(join(jobRootDir, "nested"));
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession])
        .catch(() => undefined);
    }
  });

  it("reports tmux permission failures as unsupported child-worker control", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-tmux-denied-"));
    const fakeTmux = join(root, "tmux-denied");
    const previousTmuxPath = process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH;
    await writeFile(
      fakeTmux,
      "#!/bin/sh\nprintf 'tmux: Operation not permitted\\n' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = fakeTmux;

    try {
      const status = await collectCodexGoalStatus({
        tmuxSession: "sandbox-denied",
      });

      expect(status.tmuxAlive).toBe(false);
      expect(status.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("codex_goal_tmux_unavailable"),
        ]),
      );
      expect(status.warnings.join("\n")).toContain("host-side subscription-runtime");
    } finally {
      if (previousTmuxPath === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = previousTmuxPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails tmux starts with a host-control guidance message when supervision is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-denied-"));
    const fakeTmux = join(root, "tmux-denied");
    const previousTmuxPath = process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH;
    await writeFile(
      fakeTmux,
      "#!/bin/sh\nprintf 'tmux: Operation not permitted\\n' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = fakeTmux;

    try {
      const jobRootDir = join(root, "job");
      const launch: CodexGoalLaunchInput = {
        config: {
          jobRootDir,
          authRootDir: join(root, "auth"),
          workspacePath: join(root, "workspace"),
          promptPath: join(root, "prompt.md"),
          taskId: "task-1",
          accounts: codexGoalAccountSlots(["account-a"]),
          outputPath: join(jobRootDir, "task-1.latest-result.json"),
          progressPath: join(jobRootDir, "task-1.progress.json"),
          executionEngine: "app-server-goal",
        },
        tmuxSession: "sandbox-denied",
        cwd: root,
        logPath: join(jobRootDir, "task-1.log"),
        cliCommand: ["/bin/true"],
      };

      await expect(startCodexGoalTmux(launch)).rejects.toThrow(
        /codex_goal_tmux_unavailable.*host-side subscription-runtime/,
      );
    } finally {
      if (previousTmuxPath === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = previousTmuxPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("doctors a sandbox worker layout and reports sanitized account status", async () => {
    const fixture = await createGoalFixture();
    const cooldownUntil = new Date(Date.now() + 60_000);
    new LocalFileWorkerAccountCapacityStore({
      rootDir: join(fixture.root, "state", "worker-account-capacity"),
    }).observe({
      accountId: "account-a",
      observedAt: new Date(),
      capacity: {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil,
      },
    });

    const doctor = await doctorCodexGoal({
      config: fixture.config,
    });
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: fixture.config.authRootDir,
      stateRootDir: join(fixture.root, "state"),
      accounts: ["account-a"],
    });

    expect(doctor.ok).toBe(true);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.status).toBe("ready");
    expect(accounts[0]?.identitySource).toBe("chatgpt_account_id");
    expect(accounts[0]?.identityHashPrefix).toHaveLength(16);
    expect(accounts[0]?.capacityAvailability).toBe("cooldown");
    expect(accounts[0]?.capacityReason).toBe("quota_limited");
    expect(accounts[0]?.capacityCooldownUntil).toBe(cooldownUntil.toISOString());
    expect(JSON.stringify(accounts)).not.toContain("refresh-secret");
    expect(JSON.stringify(accounts)).not.toContain("access-secret");
    expect(JSON.stringify(accounts)).not.toContain("secret@example.com");
    expect(JSON.stringify(accounts)).not.toContain("chatgpt-account-secret");
  });

  it("optionally validates account slots with codex login status without leaking provider output", async () => {
    const fixture = await createGoalFixture();
    const codexOk = join(fixture.root, "codex-ok.sh");
    const codexFail = join(fixture.root, "codex-fail.sh");
    await writeFile(codexOk, "#!/bin/sh\necho 'Auth email: secret@example.com'\nexit 0\n");
    await writeFile(codexFail, "#!/bin/sh\necho 'refresh-secret expired' >&2\nexit 1\n");
    await chmod(codexOk, 0o700);
    await chmod(codexFail, 0o700);

    const okAccounts = await listCodexGoalAccountStatuses({
      authRootDir: fixture.config.authRootDir,
      accounts: ["account-a"],
      liveCheck: true,
      codexBinaryPath: codexOk,
      liveCheckTimeoutMs: 1000,
    });
    expect(okAccounts[0]).toMatchObject({
      status: "ready",
      liveCheck: "passed",
      liveCheckSafeMessage: "codex login status passed",
    });
    expect(JSON.stringify(okAccounts)).not.toContain("secret@example.com");

    const failedAccounts = await listCodexGoalAccountStatuses({
      authRootDir: fixture.config.authRootDir,
      accounts: ["account-a"],
      liveCheck: true,
      codexBinaryPath: codexFail,
      liveCheckTimeoutMs: 1000,
    });
    expect(failedAccounts[0]).toMatchObject({
      status: "auth_invalid",
      liveCheck: "failed",
      liveCheckSafeMessage: "codex login status failed",
      safeMessage: "codex login status failed",
    });
    expect(JSON.stringify(failedAccounts)).not.toContain("refresh-secret");
  });

  it("recommends inspection instead of account switching for dirty unknown failures", async () => {
    const fixture = await createGoalFixture();
    await writeFile(
      join(fixture.config.jobRootDir, `${fixture.config.taskId}.latest-result.json`),
      `${JSON.stringify({
        status: "partial",
        reason: "provider_output_invalid",
      })}\n`,
    );
    await writeFile(join(fixture.config.workspacePath, "changed.txt"), "dirty\n");

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });

    expect(status.resultStatus).toBe("partial");
    expect(status.resultReason).toBe("provider_output_invalid");
    expect(status.workspaceDirty).toBe(true);
    expect(status.recommendedAction).toBe("inspect_dirty_failure");
  });

  it("allows continuation for clean provider-output failures", async () => {
    const fixture = await createGoalFixture();
    await writeFile(
      join(fixture.config.jobRootDir, `${fixture.config.taskId}.latest-result.json`),
      `${JSON.stringify({
        status: "failed",
        reason: "provider_output_invalid",
      })}\n`,
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });
    const launch = launchInput(fixture.config, fixture.root);
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status.resultStatus).toBe("failed");
    expect(status.resultReason).toBe("provider_output_invalid");
    expect(status.workspaceDirty).toBe(false);
    expect(status.recommendedAction).toBe("continue_after_provider_output");
    expect(brief.safeToContinue).toBe(true);
    expect(brief.nextBestCommand).toBe(
      'codex_goal_continue({ jobId: "job-from-registry", confirmContinue: true })',
    );
  });

  it("routes strict blocked results to user or inbox input instead of log guessing", async () => {
    const fixture = await createGoalFixture();
    await writeFile(
      join(fixture.config.jobRootDir, `${fixture.config.taskId}.latest-result.json`),
      `${JSON.stringify({
        status: "blocked",
        changedFiles: [],
        evidence: ["worker requested clarification"],
        blockers: ["app_server_goal_blocked"],
        nextAction: "ask_user",
        reason: "app_server_goal_blocked",
      })}\n`,
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });
    const launch = launchInput(fixture.config, fixture.root);
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status.recommendedAction).toBe("ask_user");
    expect(brief.nextBestTool).toBe("codex_goal_control_decision");
    expect(brief.nextBestCommand).toBe(
      'codex_goal_control_decision({ jobId: "job-from-registry" })',
    );
  });

  it("uses the configured result path for legacy stored jobs", async () => {
    const fixture = await createGoalFixture();
    const outputPath = join(fixture.config.jobRootDir, "output.json");
    await writeFile(
      outputPath,
      `${JSON.stringify({
        status: "partial",
        reason: "unknown_error",
      })}\n`,
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      resultPath: outputPath,
      workspacePath: fixture.config.workspacePath,
    });

    expect(status.resultPath).toBe(outputPath);
    expect(status.resultExists).toBe(true);
    expect(status.resultStatus).toBe("partial");
    expect(status.resultReason).toBe("unknown_error");
    expect(status.recommendedAction).toBe("inspect_failure");
  });

  it("does not recommend a first start when the workspace is already dirty", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(join(fixture.config.workspacePath, "untracked.txt"), "dirty\n");

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status.resultExists).toBe(false);
    expect(status.workspaceDirty).toBe(true);
    expect(status.recommendedAction).toBe("inspect_dirty_workspace");
    expect(brief.nextBestTool).toBe("codex_goal_reconcile_result");
    expect(brief.nextBestReason).toBe("missing_runtime_result");
  });

  it("does not reconcile dirty evidence after a strict worker result exists", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(
      fixture.config.outputPath!,
      `${JSON.stringify({
        status: "done",
        changedFiles: ["WORKER_SUMMARY.md"],
        evidence: ["worker_summary_present"],
        blockers: [],
        nextAction: "review_completed",
        updatedAt: new Date().toISOString(),
      })}\n`,
    );
    await writeFile(join(fixture.config.workspacePath, "WORKER_SUMMARY.md"), "done\n");

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status.resultExists).toBe(true);
    expect(status.resultStatus).toBe("done");
    expect(status.workspaceDirty).toBe(true);
    expect(status.recommendedAction).toBe("review_completed");
    expect(brief.nextBestTool).toBe("codex_goal_mark_reviewed");
    expect(brief.nextBestReason).toBe("worker completed");
  });

  it("reconciles a missing runtime result into a strict partial result with a patch", async () => {
    const fixture = await createGoalFixture();
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: fixture.config.workspacePath,
    });
    await execFileAsync("git", ["config", "user.name", "Test User"], {
      cwd: fixture.config.workspacePath,
    });
    await writeFile(join(fixture.config.workspacePath, "tracked.txt"), "before\n");
    await execFileAsync("git", ["add", "tracked.txt"], {
      cwd: fixture.config.workspacePath,
    });
    await execFileAsync("git", ["commit", "-m", "test fixture"], {
      cwd: fixture.config.workspacePath,
    });
    await writeFile(join(fixture.config.workspacePath, "tracked.txt"), "after\n");
    await writeFile(join(fixture.config.workspacePath, "new.txt"), "new file\n");

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });
    const reconciliation = await reconcileCodexGoalRuntimeResult({
      config: fixture.config,
      status,
    });
    const result = JSON.parse(await readFile(fixture.config.outputPath!, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "missing_runtime_result",
      recommendedAction: "preserve_patch",
    });
    expect(result).toMatchObject({
      status: "partial",
      changedFiles: ["new.txt", "tracked.txt"],
      nextAction: "preserve_patch",
      reason: "missing_runtime_result",
    });
    expect(result.evidence).toEqual(expect.arrayContaining([
      "supervisor_reconciled_result",
      "latest_result_missing",
      `patch_preserved:${join(fixture.config.jobRootDir, "task-1.preserved.patch")}`,
    ]));
    expect(await readFile(join(fixture.config.jobRootDir, "task-1.preserved.patch"), "utf8"))
      .toContain("after");
    expect(await readFile(join(fixture.config.jobRootDir, "task-1.preserved.patch"), "utf8"))
      .toContain("new file");
  });

  it("reconciles a dead worker with a missing runtime result into strict failure", async () => {
    const fixture = await createGoalFixture();

    const reconciliation = await new CodexGoalRuntimeResultReconciler().reconcile({
      config: fixture.config,
      status: {
        tmuxAlive: false,
        resultExists: false,
        workspaceDirty: false,
        changedFiles: [],
        recommendedAction: "start_worker",
        warnings: [],
      },
    });
    const result = JSON.parse(await readFile(fixture.config.outputPath!, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "missing_runtime_result",
      recommendedAction: "recover",
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "missing_runtime_result",
      changedFiles: [],
      evidence: expect.arrayContaining([
        "supervisor_reconciled_result",
        "latest_result_missing",
        "worker_not_alive",
      ]),
      blockers: ["missing_runtime_result", "unknown_error"],
      nextAction: "recover",
    });
  });

  it("reconciles long-running heartbeat-only workers as stale no-progress", async () => {
    const fixture = await createGoalFixture();
    const oldLogTime = new Date(Date.now() - 11 * 60_000).toISOString();

    const reconciliation = await new CodexGoalRuntimeResultReconciler().reconcile({
      config: fixture.config,
      status: {
        tmuxAlive: true,
        resultExists: false,
        workspaceDirty: false,
        changedFiles: [],
        logExists: true,
        logByteLength: 0,
        logUpdatedAt: oldLogTime,
        progressStatus: "running",
        progressProcessAlive: true,
        progressHeartbeatAgeMs: 1_000,
        recommendedAction: "wait_for_worker",
        warnings: [],
      },
    });
    const result = JSON.parse(await readFile(fixture.config.outputPath!, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "missing_runtime_result",
      classification: "stale_no_progress",
      recommendedAction: "recover",
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "missing_runtime_result",
      blockers: ["missing_runtime_result", "stale_no_progress"],
      nextAction: "recover",
    });
    expect(result.evidence).toEqual(expect.arrayContaining([
      "supervisor_reconciled_result",
      "latest_result_missing",
      "heartbeat_only_no_output",
      "log_byte_length:0",
    ]));
  });

  it("does not rewrite an existing strict runtime result during reconcile", async () => {
    const fixture = await createGoalFixture();
    await writeFile(
      fixture.config.outputPath!,
      `${JSON.stringify({
        status: "failed",
        changedFiles: [],
        evidence: ["existing"],
        blockers: ["existing"],
        nextAction: "recover",
      })}\n`,
    );

    const reconciliation = await reconcileCodexGoalRuntimeResult({
      config: fixture.config,
    });
    const result = JSON.parse(await readFile(fixture.config.outputPath!, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: false,
      reason: "strict_result_already_exists",
    });
    expect(result.evidence).toEqual(["existing"]);
  });

  it("rewrites a non-strict status-only runtime result during reconcile", async () => {
    const fixture = await createGoalFixture();
    await writeFile(
      fixture.config.outputPath!,
      `${JSON.stringify({
        status: "failed",
      })}\n`,
    );

    const reconciliation = await reconcileCodexGoalRuntimeResult({
      config: fixture.config,
    });
    const result = JSON.parse(await readFile(fixture.config.outputPath!, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "non_strict_runtime_result",
    });
    expect(result).toMatchObject({
      status: "failed",
      changedFiles: [],
      evidence: expect.arrayContaining([
        "supervisor_reconciled_result",
        "latest_result_non_strict:failed",
      ]),
      blockers: ["non_strict_runtime_result", "unknown_error"],
      nextAction: "recover",
    });
  });

  it("rewrites a corrupt runtime result through the supervisor reconciler", async () => {
    const fixture = await createGoalFixture();
    await writeFile(fixture.config.outputPath!, "{not-json\n");

    const reconciliation = await new CodexGoalRuntimeResultReconciler().reconcile({
      config: fixture.config,
    });
    const result = JSON.parse(await readFile(fixture.config.outputPath!, "utf8")) as
      Record<string, unknown>;

    expect(reconciliation).toMatchObject({
      wrote: true,
      reason: "non_strict_runtime_result",
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "non_strict_runtime_result",
      evidence: expect.arrayContaining([
        "supervisor_reconciled_result",
        "latest_result_non_strict:unknown",
      ]),
      nextAction: "recover",
    });
  });

  it("builds an agent-friendly brief with recent commands and next job action", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(
      join(fixture.config.jobRootDir, `${fixture.config.taskId}.latest-result.json`),
      `${JSON.stringify({
        status: "partial",
        reason: "quota_limited",
        attempts: [{ accountId: "account-a" }],
        task: { updatedAt: "2026-06-01T00:00:00.000Z" },
      })}\n`,
    );
    await writeFile(
      launch.logPath,
      [
        "$ npm test",
        "> python scripts/check.py token=raw-secret",
        "Bearer rawBearerSecret",
      ].join("\n"),
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
      logPath: launch.logPath,
    });
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: fixture.config.authRootDir,
      accounts: ["account-a"],
    });
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts,
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(brief).toMatchObject({
      currentAccount: "account-a",
      lastFailureReason: "quota_limited",
      safeToContinue: true,
      hasAvailableAccount: true,
      availableDedupedAccounts: ["account-a"],
      needsHumanRelogin: false,
      nextBestCommand:
        'codex_goal_continue({ jobId: "job-from-registry", confirmContinue: true })',
    });
    expect(brief.recentCommands).toContain("npm test");
    expect(brief.recentCommands).toContain(
      "python scripts/check.py token=[redacted:token-field]",
    );
    expect(JSON.stringify(brief)).not.toContain("raw-secret");
    expect(JSON.stringify(brief)).not.toContain("rawBearerSecret");
  });

  it("holds reviewed no-result jobs for manual review instead of restart", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(
      join(fixture.config.jobRootDir, `${fixture.config.taskId}.review.json`),
      `${JSON.stringify({
        reviewedAt: "2026-06-30T00:00:00.000Z",
        note: "manual audit completed",
      })}\n`,
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
      logPath: launch.logPath,
    });
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status).toMatchObject({
      resultExists: false,
      workspaceDirty: false,
      recommendedAction: "start_worker",
    });
    expect(brief).toMatchObject({
      safeToContinue: false,
      lifecycleMarkerTypes: ["review"],
      nextBestTool: "manual_review",
      nextBestReason: "reviewed_no_result",
      nextBestCommand: "manual_review_status",
    });
    expect(String(brief.text)).toContain("reviewedWithoutResult true");
  });

  it("does not offer raw worker starts for project-scoped-control anchors", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput({
      ...fixture.config,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        projectId: "quanta",
        workspaceRoots: [fixture.config.workspacePath],
        jobIdPrefixes: ["quanta-"],
      },
    }, fixture.root);

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
      logPath: launch.logPath,
      accessBoundary: AccessBoundary.ProjectScopedControl,
    });
    const brief = await buildCodexGoalBrief({
      jobId: "quanta-project-controller",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status.recommendedAction).toBe("check_log_or_result");
    expect(status.warnings.join("\\n")).toContain("broker-only anchor");
    expect(brief.nextBestTool).toBe("manual_review");
  });

  it("does not offer to start no-result jobs when the workspace is missing", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);

    try {
      await rm(fixture.config.workspacePath, { recursive: true, force: true });

      const status = await collectCodexGoalStatus({
        jobRootDir: fixture.config.jobRootDir,
        taskId: fixture.config.taskId,
        workspacePath: fixture.config.workspacePath,
        logPath: launch.logPath,
      });
      const brief = await buildCodexGoalBrief({
        jobId: "job-from-registry",
        launch,
        status,
        accounts: [accountStatus("account-a", {})],
        staleAfterMs: 60_000,
        tailLines: 20,
      });

      expect(status).toMatchObject({
        resultExists: false,
        workspaceExists: false,
        workspaceDirty: false,
        changedFiles: [],
        recommendedAction: "inspect_failure",
      });
      expect(status.warnings).toContain(`${fixture.config.workspacePath} workspace_missing`);
      expect(brief).toMatchObject({
        safeToContinue: false,
        nextBestTool: "manual_review",
        nextBestReason: "status requires inspection before continuing",
        nextBestCommand: "manual_review_status",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses runner progress as the strongest observable progress signal", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(
      fixture.config.progressPath!,
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.config.taskId,
        status: "running",
        updatedAt: "2026-06-02T00:00:00.000Z",
        pid: 12345,
        reason: "still running token=raw-secret",
      })}\n`,
    );
    await writeFile(
      launch.config.outputPath!,
      `${JSON.stringify({
        status: "partial",
        reason: "quota_limited",
        task: { updatedAt: "2026-06-01T00:00:00.000Z" },
      })}\n`,
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
      logPath: launch.logPath,
      progressPath: fixture.config.progressPath!,
    });
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status).toMatchObject({
      progressExists: true,
      progressStatus: "running",
      progressUpdatedAt: "2026-06-02T00:00:00.000Z",
      progressPid: 12345,
      progressResultReason: "still running token=[redacted:token-field]",
    });
    expect(brief).toMatchObject({
      lastProgressAt: "2026-06-02T00:00:00.000Z",
      progressStatus: "running",
      progressUpdatedAt: "2026-06-02T00:00:00.000Z",
      progressPid: 12345,
    });
    expect(String(brief.text)).toContain("progressStatus running");
    expect(JSON.stringify(status)).not.toContain("raw-secret");
    expect(JSON.stringify(brief)).not.toContain("raw-secret");
  });

  it("summarizes child process CPU as active worker progress", () => {
    expect(summarizeCodexGoalProcessTree(100, [
      { pid: 100, ppid: 1, cpu: 0, command: "node subscription-runtime-codex-goal" },
      { pid: 101, ppid: 100, cpu: 0, command: "sh -c npm test" },
      { pid: 102, ppid: 101, cpu: 84.2, command: "npm test -- --runInBand" },
    ])).toMatchObject({
      alive: true,
      cpuActive: true,
      command: "npm test -- --runInBand",
    });
  });

  it("does not summarize defunct process rows as live worker progress", () => {
    expect(summarizeCodexGoalProcessTree(100, [
      {
        pid: 100,
        ppid: 1,
        stat: "Z",
        cpu: 52.1,
        command: "[ps] <defunct>",
      },
    ])).toEqual({});
  });

  it("treats fresh running progress as observable liveness without tmux", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
      },
      progressStale: false,
    })).toMatchObject({
      alive: true,
      supervisorKind: RunProcessSupervisorKind.External,
      processAlive: false,
      freshProgressAlive: true,
      aliveReason: RunProcessAliveReason.FreshProgress,
    });
  });

  it("does not treat fresh progress as liveness after tmux and pid are gone", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        tmuxAlive: false,
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: false,
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.Unknown,
    });
  });

  it("does not treat maintenance-paused progress as a live worker", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "maintenance_paused",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.TerminalResult,
    });
  });

  it("does not treat partial progress as a live worker", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "partial",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        progressCommand: "node subscription-runtime-codex-goal run",
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.TerminalResult,
    });
  });

  it("does not trust bracketed kernel worker commands as progress pid liveness", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        tmuxAlive: false,
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        progressCommand: "[kworker/R-slub_]",
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.Unknown,
    });
  });

  it("keeps a live dirty worker in wait state instead of manual review", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    const brief = await buildCodexGoalBrief({
      jobId: "job-live-dirty",
      launch,
      status: {
        recommendedAction: "inspect_dirty_workspace",
        workspaceDirty: true,
        changedFiles: ["src/active-write.ts"],
        resultExists: false,
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        warnings: [],
      } as Awaited<ReturnType<typeof collectCodexGoalStatus>>,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(brief).toMatchObject({
      workerAlive: true,
      workerSupervisorKind: RunProcessSupervisorKind.Direct,
      safeToContinue: false,
      nextBestTool: "codex_goal_brief",
      nextBestReason: "worker is already running",
    });
  });

  it("does not flag a cpu-active app-server as heartbeat-only no-output", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    const brief = await buildCodexGoalBrief({
      jobId: "job-cpu-active-empty-log",
      launch,
      status: {
        tmuxAlive: true,
        recommendedAction: "wait_for_worker",
        workspaceDirty: false,
        changedFiles: [],
        resultExists: false,
        logExists: true,
        logByteLength: 0,
        logUpdatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        progressExists: true,
        progressStatus: "running",
        progressUpdatedAt: new Date().toISOString(),
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        progressCpuActive: true,
        warnings: [],
      } as Awaited<ReturnType<typeof collectCodexGoalStatus>>,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(brief).toMatchObject({
      workerAlive: true,
      heartbeatOnlyNoOutput: false,
      safeToContinue: false,
      nextBestTool: "codex_goal_brief",
      nextBestReason: "worker is already running",
    });
  });

  it("does not mark continuation safe when all configured accounts are unavailable", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(
      launch.config.outputPath!,
      `${JSON.stringify({
        status: "partial",
        reason: "quota_limited",
        attempts: [{ accountId: "account-a" }],
        task: { updatedAt: new Date().toISOString() },
      })}\n`,
    );
    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
      logPath: launch.logPath,
    });
    const accounts = [
      accountStatus("account-a", {
        capacityAvailability: "cooldown",
        capacityReason: "quota_limited",
      }),
      accountStatus("account-b", {
        status: "auth_invalid",
      }),
    ];

    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch: {
        ...launch,
        config: {
          ...launch.config,
          accounts: codexGoalAccountSlots(["account-a", "account-b"]),
        },
      },
      status,
      accounts,
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(brief).toMatchObject({
      safeToContinue: false,
      hasAvailableAccount: false,
      availableDedupedAccounts: [],
      invalidAccounts: ["account-b"],
      nextBestTool: "codex_goal_accounts_status",
      nextBestReason: "no available account slots for this job",
    });
    expect(brief.nextBestCommand).toContain("codex_goal_accounts_status");
    expect(brief.nextBestCommand).toContain("job-from-registry");
  });

  it("reports waiting capacity as blocked with capacity continuation action", async () => {
    const fixture = await createGoalFixture();
    const launch = launchInput(fixture.config, fixture.root);
    await writeFile(
      launch.config.outputPath!,
      `${JSON.stringify({
        status: "blocked",
        reason: "capacity_unavailable",
        changedFiles: [],
        evidence: ["safe_execution_status:waiting_capacity"],
        blockers: ["capacity_unavailable"],
        nextAction: "wait",
        updatedAt: new Date().toISOString(),
      })}\n`,
    );
    await writeFile(
      codexGoalProgressPath(launch.config),
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.config.taskId,
        status: "blocked",
        resultStatus: "waiting_capacity",
        reason: "capacity_unavailable",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`,
    );

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
      logPath: launch.logPath,
    });
    const brief = await buildCodexGoalBrief({
      jobId: "job-from-registry",
      launch,
      status,
      accounts: [accountStatus("account-a", {})],
      staleAfterMs: 60_000,
      tailLines: 20,
    });

    expect(status).toMatchObject({
      resultStatus: "blocked",
      resultReason: "capacity_unavailable",
      progressStatus: "blocked",
      progressResultStatus: "waiting_capacity",
      recommendedAction: "continue_after_capacity",
    });
    expect(brief).toMatchObject({
      workerHealth: {
        blocked: true,
        evidence: expect.arrayContaining(["status:blocked"]),
      },
      nextBestTool: "codex_goal_brief",
    });
  });

  it("dedupes account slots by sanitized identity and prefers newest ready auth", () => {
    const slots = [
      accountStatus("account-a-old", {
        identityHashPrefix: "same-identity",
        lastRefreshAt: "2026-06-01T00:00:00.000Z",
      }),
      accountStatus("account-b-new", {
        identityHashPrefix: "same-identity",
        lastRefreshAt: "2026-06-02T00:00:00.000Z",
      }),
      accountStatus("account-c-invalid", {
        identityHashPrefix: "same-identity",
        status: "auth_invalid",
        lastRefreshAt: "2026-06-03T00:00:00.000Z",
      }),
      accountStatus("account-d-unique", {
        identityHashPrefix: "unique-identity",
        lastRefreshAt: "2026-06-01T00:00:00.000Z",
      }),
    ];

    expect(dedupeCodexGoalAccountSlots(slots).map((slot) => slot.name)).toEqual([
      "account-d-unique",
      "account-b-new",
    ]);
  });

  it("excludes capacity-blocked slots from the available account list", () => {
    const slots = [
      accountStatus("account-a-cooldown", {
        capacityAvailability: "cooldown",
        capacityReason: "quota_limited",
      }),
      accountStatus("account-b-ready", {}),
      accountStatus("account-c-invalid", {
        status: "auth_invalid",
      }),
    ];

    expect(availableCodexGoalAccountSlots(slots).map((slot) => slot.name)).toEqual([
      "account-b-ready",
    ]);
  });

  it("keeps reloginable account slots visible while hiding non-account cache dirs", () => {
    const slots = [
      accountStatus("state", { status: "auth_missing" }),
      accountStatus("jobs", { status: "auth_missing" }),
      accountStatus("account-a", { status: "auth_missing" }),
      accountStatus("account-b", {}),
    ];

    expect(
      visibleCodexGoalAccountPoolSlots("memo-stack-goal-cache", slots).map((slot) => slot.name),
    ).toEqual(["account-b"]);
    expect(
      visibleCodexGoalAccountPoolSlots("live-codex-auth", slots).map((slot) => slot.name),
    ).toEqual(["state", "jobs", "account-a", "account-b"]);
  });
});

async function hasTmux(): Promise<boolean> {
  const session = `subscription-runtime-tmux-probe-${process.pid}-${Date.now()}`;
  try {
    await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "/bin/true",
    ], { timeout: 2_000 });
    await execFileAsync("tmux", ["kill-session", "-t", session], {
      timeout: 2_000,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function createGoalFixture(): Promise<{
  readonly root: string;
  readonly config: CodexGoalRunConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-"));
  const jobRootDir = join(root, "job");
  const authRootDir = join(root, "auth");
  const workspacePath = join(root, "workspace");
  await mkdir(join(authRootDir, "account-a"), { recursive: true });
  await mkdir(jobRootDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspacePath });
  const promptPath = join(jobRootDir, "prompt.md");
  await writeFile(promptPath, "Do a sandbox task.\n");
  await writeFile(
    join(authRootDir, "account-a", "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
      tokens: {
        refresh_token: "refresh-secret",
        access_token: "access-secret",
        id_token: fakeJwt({
          email: "secret@example.com",
          sub: "oauth-sub-secret",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "chatgpt-account-secret",
            chatgpt_user_id: "chatgpt-user-secret",
          },
        }),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
    })}\n`,
  );
  return {
    root,
    config: {
      jobRootDir,
      authRootDir,
      workspacePath,
      promptPath,
      taskId: "task-1",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(jobRootDir, "task-1.latest-result.json"),
      progressPath: join(jobRootDir, "task-1.progress.json"),
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      codexBinaryPath: "codex",
      editMode: "allow-edits",
      taskTimeoutMs: 72 * 60 * 60 * 1000,
      maxAccountCycles: 3,
      requireGitWorkspace: true,
    },
  };
}

function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(claims),
    "",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64url");
}

function accountStatus(
  name: string,
  overrides: Partial<Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>[number]>,
): Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>[number] {
  return {
    name,
    authJsonPath: `/tmp/${name}/auth.json`,
    status: "ready",
    warnings: [],
    safeMessage: "auth.json is readable",
    ...overrides,
  };
}

function launchInput(
  config: CodexGoalRunConfig,
  cwd: string,
): CodexGoalLaunchInput {
  return {
    config,
    tmuxSession: "goal-worker",
    cwd,
    logPath: join(config.jobRootDir, "task-1.log"),
    format: "json",
    cliCommand: ["subscription-runtime-codex-goal"],
  };
}
