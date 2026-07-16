import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalFileRunEventStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildNoTmuxShellCommand,
  buildTmuxCommand,
  parseCodexGoalCliArgs,
  runCodexGoalCli,
  upsertRunCommandManifest,
  type CodexGoalCliIo,
} from "../codex-goal-cli";

describe("codex goal cli", () => {
  it("builds a run command from flags with safe defaults", () => {
    const command = parseCodexGoalCliArgs(
      [
        "run",
        "--job-root",
        "/tmp/job",
        "--auth-root",
        "/tmp/auth",
        "--workspace",
        "/tmp/workspace",
        "--prompt",
        "/tmp/job/prompt.md",
        "--codex-goal-objective",
        "Short objective with docs links.",
        "--task-id",
        "task-1",
        "--accounts",
        "account-a,account-b",
        "--tmux-session",
        "goal-worker",
        "--app-server-startup-timeout-ms",
        "45000",
      ],
      fakeIo(),
    );

    expect(command.kind).toBe("run");
    if (command.kind !== "run") return;
    expect(command.config).toMatchObject({
      jobRootDir: "/tmp/job",
      authRootDir: "/tmp/auth",
      workspacePath: "/tmp/workspace",
      promptPath: "/tmp/job/prompt.md",
      codexGoalObjective: "Short objective with docs links.",
      taskId: "task-1",
      model: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: "default",
      executionEngine: "app-server-goal",
      taskTimeoutMs: 72 * 60 * 60 * 1000,
      appServerStartupTimeoutMs: 45_000,
      progressPath: "/tmp/job/task-1.progress.json",
      progressHeartbeatMs: 60_000,
      maxAccountCycles: 5,
      editMode: "allow-edits",
      requireGitWorkspace: true,
      sourceEnv: {
        SUBSCRIPTION_RUNTIME_JOB_ROOT: "/tmp/job",
        SUBSCRIPTION_RUNTIME_TMPDIR: "/tmp/job/tmp",
        TMPDIR: "/tmp/job/tmp/agent",
        TMP: "/tmp/job/tmp/agent",
        TEMP: "/tmp/job/tmp/agent",
      },
    });
    expect(command.config.accounts.map((account) => account.name)).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(command.tmuxSession).toBe("goal-worker");
  });

  it("rejects provider sandbox names passed as codex goal edit mode", () => {
    expect(() =>
      parseCodexGoalCliArgs(
        [
          "run",
          "--job-root",
          "/tmp/job",
          "--auth-root",
          "/tmp/auth",
          "--workspace",
          "/tmp/workspace",
          "--prompt",
          "/tmp/job/prompt.md",
          "--task-id",
          "task-1",
          "--accounts",
          "account-a",
          "--edit-mode",
          "danger-full-access",
        ],
        fakeIo(),
      ),
    ).toThrow(/Use providerSandboxMode/);
  });

  it("uses environment fallback names for continuation handoff", () => {
    const command = parseCodexGoalCliArgs(
      [
        "continue",
        "--job-root",
        "/tmp/job",
        "--auth-root",
        "/tmp/auth",
        "--accounts",
        "account-c",
        "--no-require-git-workspace",
      ],
      fakeIo({
        SUBSCRIPTION_RUNTIME_TASK_ID: "task-env",
        SUBSCRIPTION_RUNTIME_WORKSPACE_PATH: "/tmp/workspace-env",
        SUBSCRIPTION_RUNTIME_PROMPT_PATH: "/tmp/job/prompt-env.md",
        SUBSCRIPTION_RUNTIME_CODEX_GOAL_OBJECTIVE: "Env objective",
        CODEX_MODEL: "gpt-test",
        CODEX_REASONING_EFFORT: "high",
        CODEX_SERVICE_TIER: "default",
      }),
    );

    expect(command.kind).toBe("run");
    if (command.kind !== "run") return;
    expect(command.config).toMatchObject({
      taskId: "task-env",
      workspacePath: "/tmp/workspace-env",
      promptPath: "/tmp/job/prompt-env.md",
      codexGoalObjective: "Env objective",
      model: "gpt-test",
      reasoningEffort: "high",
      serviceTier: "default",
      requireGitWorkspace: false,
    });
  });

  it("renders no-tmux and tmux commands without hiding manual control", () => {
    const command = parseCodexGoalCliArgs(
      [
        "run",
        "--job-root",
        "/tmp/job",
        "--auth-root",
        "/tmp/auth",
        "--workspace",
        "/tmp/workspace",
        "--prompt",
        "/tmp/job/prompt.md",
        "--task-id",
        "task-1",
        "--accounts",
        "account-a,account-b",
        "--tmux-session",
        "goal-worker",
        "--dry-run",
      ],
      fakeIo(),
    );

    expect(command.kind).toBe("run");
    if (command.kind !== "run") return;
    const noTmux = buildNoTmuxShellCommand(command);
    expect(noTmux).toContain("run --no-tmux");
    expect(noTmux).toContain("--accounts account-a,account-b");
    expect(noTmux).toContain("--effort high");
    expect(noTmux).toContain("--service-tier default");
    expect(noTmux).toContain("--execution-engine app-server-goal");
    expect(noTmux).toContain("--progress /tmp/job/task-1.progress.json");

    const tmux = buildTmuxCommand(command);
    expect(tmux.args).toEqual(
      expect.arrayContaining(["new-session", "-d", "-s", "goal-worker"]),
    );
    expect(tmux.preview).toContain("tmux new-session");
    expect(tmux.preview).toContain("tee -a /tmp/job/task-1.log");
  });

  it("upserts a registry manifest for registry-aware run commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-cli-registry-"));
    const registryRoot = join(root, "registry");
    const jobRoot = join(root, "job");
    const workspace = join(root, "workspace");
    const prompt = join(jobRoot, "prompt.md");
    const command = parseCodexGoalCliArgs(
      [
        "run",
        "--job-root",
        jobRoot,
        "--auth-root",
        join(root, "auth"),
        "--workspace",
        workspace,
        "--prompt",
        prompt,
        "--task-id",
        "task-1",
        "--job-id",
        "job-1",
        "--accounts",
        "account-a,account-b",
        "--tmux-session",
        "goal-worker",
        "--registry-root",
        registryRoot,
        "--description",
        "Registry aware worker",
        "--tags",
        "team,refactor",
        "--format",
        "json",
      ],
      fakeIo(),
    );

    try {
      expect(command.kind).toBe("run");
      if (command.kind !== "run") return;
      await upsertRunCommandManifest(command);
      const manifest = JSON.parse(
        await readFile(join(registryRoot, "job-1", "job.json"), "utf8"),
      );

      expect(manifest).toMatchObject({
        schemaVersion: 1,
        jobId: "job-1",
        description: "Registry aware worker",
        tags: ["team", "refactor"],
        jobRootDir: jobRoot,
        workspacePath: workspace,
        promptPath: prompt,
        taskId: "task-1",
        accounts: ["account-a", "account-b"],
        tmuxSession: "goal-worker",
        outputFormat: "json",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies registry-aware CLI run when an existing controller owns the scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-cli-project-scope-"));
    const registryRoot = join(root, "registry");
    const controllerJobRoot = join(root, "jobs", "infinity-context-controller-v1");
    const sourceWorkspace = join(root, "workspaces", "infinity-context-main");
    const worktreeRoot = join(root, "worktrees");
    const childJobRoot = join(root, "jobs", "infinity-context-memory-child-v1");
    const childPrompt = join(childJobRoot, "prompt.md");
    const childJobJson = join(registryRoot, "infinity-context-memory-child-v1", "job.json");
    const projectAccessScope = {
      projectId: "infinity-context",
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreeRoot],
      registryRoot,
      jobIdPrefixes: ["infinity-context-"],
      tmuxSessionPrefixes: ["infinity-context-"],
      allowedAccountIds: ["account-a"],
    };
    const controllerCommand = parseCodexGoalCliArgs(
      [
        "run",
        "--job-root",
        controllerJobRoot,
        "--auth-root",
        join(root, "auth"),
        "--workspace",
        sourceWorkspace,
        "--prompt",
        join(controllerJobRoot, "prompt.md"),
        "--task-id",
        "infinity-context-controller-v1",
        "--job-id",
        "infinity-context-controller-v1",
        "--accounts",
        "account-a",
        "--registry-root",
        registryRoot,
        "--access-boundary",
        "project_scoped_control",
        "--project-access-scope-json",
        JSON.stringify(projectAccessScope),
        "--network-access",
        "restricted",
        "--no-require-git-workspace",
      ],
      fakeIo(),
    );

    try {
      expect(controllerCommand.kind).toBe("run");
      if (controllerCommand.kind !== "run") return;
      await upsertRunCommandManifest(controllerCommand);

      const io = captureIo();
      const exitCode = await runCodexGoalCli([
        "run",
        "--job-root",
        childJobRoot,
        "--auth-root",
        join(root, "auth"),
        "--workspace",
        join(worktreeRoot, "infinity-context-memory-child-v1"),
        "--prompt",
        childPrompt,
        "--task-id",
        "infinity-context-memory-child-v1",
        "--job-id",
        "infinity-context-memory-child-v1",
        "--accounts",
        "account-a",
        "--tmux-session",
        "infinity-context-memory-child-v1",
        "--registry-root",
        registryRoot,
        "--no-require-git-workspace",
      ], io);

      expect(exitCode).toBe(2);
      expect(io.stderr).toContain("project_control_broker_required");
      expect(io.stderr).toContain("requiredTool=codex_goal_project_start");
      await expect(readFile(childJobJson, "utf8")).rejects.toThrow(/ENOENT/);

      const brokeredChildIo = captureIo({
        SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START: "1",
      });
      const brokeredChildExitCode = await runCodexGoalCli([
        "run",
        "--no-tmux",
        "--job-root",
        childJobRoot,
        "--auth-root",
        join(root, "auth"),
        "--workspace",
        join(worktreeRoot, "infinity-context-memory-child-v1"),
        "--prompt",
        childPrompt,
        "--task-id",
        "infinity-context-memory-child-v1",
        "--job-id",
        "infinity-context-memory-child-v1",
        "--accounts",
        "account-a",
        "--access-boundary",
        "isolated_workspace_write",
        "--project-access-scope-json",
        JSON.stringify({
          projectId: "infinity-context",
          readRoots: [join(worktreeRoot, "infinity-context-memory-child-v1")],
          isolatedWorkspaceRoot: join(worktreeRoot, "infinity-context-memory-child-v1"),
          workspaceRoots: [join(worktreeRoot, "infinity-context-memory-child-v1")],
          registryRoot,
        }),
        "--network-access",
        "restricted",
        "--no-require-git-workspace",
      ], brokeredChildIo);

      expect(brokeredChildExitCode).toBe(2);
      expect(brokeredChildIo.stderr).not.toContain("project_control_broker_required");
      expect(brokeredChildIo.stderr).toContain("ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the full MCP tool surface through the CLI fallback", async () => {
    const io = captureIo();

    const exitCode = await runCodexGoalCli(["tools"], io);

    expect(exitCode).toBe(0);
    const output = JSON.parse(io.stdout);
    expect(output.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "agent_run_watch" }),
        expect.objectContaining({ name: "codex_goal_run_watch" }),
        expect.objectContaining({ name: "agent_run_events" }),
        expect.objectContaining({ name: "codex_goal_events" }),
        expect.objectContaining({ name: "agent_run_state" }),
        expect.objectContaining({ name: "codex_goal_state" }),
        expect.objectContaining({ name: "agent_run_event_compaction_plan" }),
        expect.objectContaining({ name: "agent_run_event_compact" }),
        expect.objectContaining({ name: "agent_run_project_events" }),
        expect.objectContaining({ name: "codex_goal_project_events" }),
        expect.objectContaining({ name: "codex_goal_reconcile_preview" }),
        expect.objectContaining({ name: "codex_goal_brief" }),
        expect.objectContaining({ name: "codex_goal_decision" }),
        expect.objectContaining({ name: "codex_goal_overview" }),
        expect.objectContaining({ name: "codex_goal_accounts_status" }),
        expect.objectContaining({ name: "codex_goal_continue" }),
        expect.objectContaining({ name: "codex_goal_stop" }),
      ]),
    );
  });

  it("exits successfully when stdout is closed by a downstream pipe", async () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const io: CodexGoalCliIo = {
      writeStdout(): void {
        throw epipe;
      },
      writeStderr(): void {
        throw new Error("stderr should not be written for EPIPE");
      },
      cwd(): string {
        return "/tmp";
      },
      env(): Readonly<Record<string, string | undefined>> {
        return {};
      },
    };

    await expect(runCodexGoalCli(["help"], io)).resolves.toBe(0);
  });

  it("calls MCP job tools through the CLI fallback with JSON args", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-cli-mcp-"));
    const io = captureIo();

    try {
      const exitCode = await runCodexGoalCli([
        "tool",
        "codex_goal_list_jobs",
        "--args-json",
        JSON.stringify({ registryRootDir: root }),
      ], io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdout)).toMatchObject({
        ok: true,
        registryRootDir: root,
        jobs: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects one-shot CLI starts for live project controllers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-cli-controller-"));
    const io = captureIo();

    try {
      const exitCode = await runCodexGoalCli([
        "tool",
        "codex_goal_project_controller_start",
        "--args-json",
        JSON.stringify({
          registryRootDir: root,
          controllerJobId: "controller-v1",
        }),
      ], io);

      expect(exitCode).toBe(1);
      expect(JSON.parse(io.stdout)).toMatchObject({
        ok: false,
        mode: "mcp_tool_guard",
        tool: "codex_goal_project_controller_start",
        reason: "durable_controller_process_required",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses durable project controller supervision commands", () => {
    const command = parseCodexGoalCliArgs([
      "controller-supervise",
      "--controller-job-id",
      "infinity-context-project-controller-v1",
      "--registry-root",
      "/var/data/infinity-context/worker-jobs/registry",
      "--provider",
      "codex",
      "--max-goal-turns",
      "120",
      "--status-interval-ms",
      "15000",
      "--format",
      "json",
    ], fakeIo());

    expect(command.kind).toBe("controller-supervise");
    if (command.kind !== "controller-supervise") return;
    expect(command).toMatchObject({
      statusIntervalMs: 15_000,
      format: "json",
      args: {
        controllerJobId: "infinity-context-project-controller-v1",
        registryRootDir: "/var/data/infinity-context/worker-jobs/registry",
        providerKind: "codex",
        maxGoalTurns: 120,
      },
    });
  });

  it("keeps MCP shortcut parsing out of runtime ops adapters", async () => {
    const shortcutSource = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "codex-goal-cli-shortcuts.ts"),
      "utf8",
    );

    expect(shortcutSource).not.toContain("./codex-goal-ops");
    expect(shortcutSource).not.toContain("./codex-goal-runner");
    expect(shortcutSource).not.toContain("./codex-goal-mcp-client");
    expect(shortcutSource).not.toContain("node:child_process");
  });

  it("builds shortcut commands for common agent operations", () => {
    const overview = parseCodexGoalCliArgs([
      "overview",
      "--registry-root",
      "/tmp/registry",
      "--limit",
      "5",
      "--job-prefix",
      "quanta-s9",
    ], fakeIo());
    expect(overview).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_overview",
      format: "json",
    });
    if (overview.kind !== "mcp-tool") return;
    expect(JSON.parse(overview.argsJson ?? "{}")).toEqual({
      registryRootDir: "/tmp/registry",
      limit: 5,
      jobIdPrefix: "quanta-s9",
    });

    const runWatch = parseCodexGoalCliArgs([
      "run-watch",
      "job-a",
      "--registry-root",
      "/tmp/registry",
      "--include-log-tail",
      "--include-changed-files",
      "--tail-lines",
      "25",
      "--json",
    ], fakeIo());
    expect(runWatch).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_watch",
      format: "json",
    });
    if (runWatch.kind !== "mcp-tool") return;
    expect(JSON.parse(runWatch.argsJson ?? "{}")).toEqual({
      providerKind: "codex",
      jobId: "job-a",
      registryRootDir: "/tmp/registry",
      includeLogTail: true,
      includeChangedFiles: true,
      tailLines: 25,
    });

    const events = parseCodexGoalCliArgs([
      "events",
      "job-a",
      "--registry-root",
      "/tmp/registry",
      "--event-root",
      "/tmp/events",
      "--cursor",
      "12",
      "--type",
      "run.completed",
      "--limit",
      "10",
    ], fakeIo());
    expect(events).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_events",
      format: "json",
    });
    if (events.kind !== "mcp-tool") return;
    expect(JSON.parse(events.argsJson ?? "{}")).toEqual({
      providerKind: "codex",
      jobId: "job-a",
      registryRootDir: "/tmp/registry",
      eventRootDir: "/tmp/events",
      cursor: "12",
      type: "run.completed",
      limit: 10,
    });

    const state = parseCodexGoalCliArgs([
      "state",
      "job-a",
      "--registry-root",
      "/tmp/registry",
      "--event-root",
      "/tmp/events",
    ], fakeIo());
    expect(state).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_state",
      format: "json",
    });
    if (state.kind !== "mcp-tool") return;
    expect(JSON.parse(state.argsJson ?? "{}")).toEqual({
      providerKind: "codex",
      jobId: "job-a",
      registryRootDir: "/tmp/registry",
      eventRootDir: "/tmp/events",
    });

    const compactionPlan = parseCodexGoalCliArgs([
      "event-compaction-plan",
      "--registry-root",
      "/tmp/registry",
      "--event-root",
      "/tmp/events",
      "--keep-after",
      "2026-07-02T00:00:00.000Z",
      "--keep-latest-per-run",
      "3",
      "--compact-delivered",
      "--drop-invalid-lines",
    ], fakeIo());
    expect(compactionPlan).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_event_compaction_plan",
      format: "json",
    });
    if (compactionPlan.kind !== "mcp-tool") return;
    expect(JSON.parse(compactionPlan.argsJson ?? "{}")).toEqual({
      registryRootDir: "/tmp/registry",
      eventRootDir: "/tmp/events",
      keepEventsAfter: "2026-07-02T00:00:00.000Z",
      keepLatestEventsPerRun: 3,
      compactDeliveredEvents: true,
      dropInvalidLines: true,
    });

    const compact = parseCodexGoalCliArgs([
      "event-compact",
      "--registry-root",
      "/tmp/registry",
      "--event-root",
      "/tmp/events",
      "--keep-latest-per-run",
      "1",
      "--force",
      "--confirm",
    ], fakeIo());
    expect(compact).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_event_compact",
      format: "json",
    });
    if (compact.kind !== "mcp-tool") return;
    expect(JSON.parse(compact.argsJson ?? "{}")).toEqual({
      registryRootDir: "/tmp/registry",
      eventRootDir: "/tmp/events",
      keepLatestEventsPerRun: 1,
      safetyMode: "force",
      confirmCompact: true,
    });

    const projectEvents = parseCodexGoalCliArgs([
      "project-events",
      "job-a",
      "--registry-root",
      "/tmp/registry",
      "--event-root",
      "/tmp/events",
      "--host-id",
      "host-a",
      "--include-changed-files",
    ], fakeIo());
    expect(projectEvents).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_project_events",
      format: "json",
    });
    if (projectEvents.kind !== "mcp-tool") return;
    expect(JSON.parse(projectEvents.argsJson ?? "{}")).toEqual({
      providerKind: "codex",
      jobId: "job-a",
      registryRootDir: "/tmp/registry",
      eventRootDir: "/tmp/events",
      hostId: "host-a",
      includeChangedFiles: true,
    });

    const relayEvents = parseCodexGoalCliArgs([
      "relay-events",
      "--event-root",
      "/tmp/events",
      "--consumer-id",
      "orchestrator-a",
      "--publisher",
      "webhook",
      "--webhook-url",
      "https://orchestrator.example.test/events",
      "--limit",
      "20",
      "--run-id",
      "job-a",
      "--type",
      "run.completed",
    ], fakeIo());
    expect(relayEvents).toMatchObject({
      kind: "relay-events",
      eventRootDir: "/tmp/events",
      consumerId: "orchestrator-a",
      publisherKind: "webhook",
      webhookUrl: "https://orchestrator.example.test/events",
      limit: 20,
      runId: "job-a",
      types: ["run.completed"],
    });

    const claudeRunWatch = parseCodexGoalCliArgs([
      "run-watch",
      "claude-run-a",
      "--provider",
      "claude",
      "--state-root",
      "/tmp/claude-state",
      "--run-artifacts-root",
      "/tmp/claude-artifacts",
      "--include-log-tail",
      "--json",
    ], fakeIo());
    expect(claudeRunWatch).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_watch",
      format: "json",
    });
    if (claudeRunWatch.kind !== "mcp-tool") return;
    expect(JSON.parse(claudeRunWatch.argsJson ?? "{}")).toEqual({
      providerKind: "claude",
      jobId: "claude-run-a",
      stateRootDir: "/tmp/claude-state",
      runArtifactsRootDir: "/tmp/claude-artifacts",
      includeLogTail: true,
    });

    const reconcilePreview = parseCodexGoalCliArgs([
      "reconcile-preview",
      "--registry-root",
      "/tmp/registry",
      "--continue-safe-jobs",
      "--max-continues",
      "2",
    ], fakeIo());
    expect(reconcilePreview).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_reconcile_preview",
      format: "json",
    });
    if (reconcilePreview.kind !== "mcp-tool") return;
    expect(JSON.parse(reconcilePreview.argsJson ?? "{}")).toEqual({
      registryRootDir: "/tmp/registry",
      continueSafeJobs: true,
      maxContinuesPerRun: 2,
    });

    const brief = parseCodexGoalCliArgs([
      "brief",
      "job-a",
      "--registry-root",
      "/tmp/registry",
      "--tail-lines",
      "50",
    ], fakeIo());
    expect(brief).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_brief",
      format: "json",
    });
    if (brief.kind !== "mcp-tool") return;
    expect(JSON.parse(brief.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      registryRootDir: "/tmp/registry",
      tailLines: 50,
    });

    const decision = parseCodexGoalCliArgs([
      "decision",
      "job-a",
      "--registry-root",
      "/tmp/registry",
      "--no-registry-conflicts",
      "--stale-after-ms",
      "2000",
    ], fakeIo());
    expect(decision).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_decision",
      format: "json",
    });
    if (decision.kind !== "mcp-tool") return;
    expect(JSON.parse(decision.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      registryRootDir: "/tmp/registry",
      includeRegistryConflicts: false,
      staleAfterMs: 2000,
    });

    const continueJob = parseCodexGoalCliArgs([
      "continue-job",
      "job-a",
      "--confirm",
      "--skip-doctor",
    ], fakeIo());
    expect(continueJob).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_continue",
    });
    if (continueJob.kind !== "mcp-tool") return;
    expect(JSON.parse(continueJob.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      confirmContinue: true,
      skipDoctor: true,
    });

    const stopJob = parseCodexGoalCliArgs([
      "stop-job",
      "job-a",
      "--confirm",
      "--force",
      "--stale-after-ms",
      "1000",
    ], fakeIo());
    expect(stopJob).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_stop",
    });
    if (stopJob.kind !== "mcp-tool") return;
    expect(JSON.parse(stopJob.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      confirmStop: true,
      forceStop: true,
      staleAfterMs: 1000,
    });

    const reconcileResult = parseCodexGoalCliArgs([
      "reconcile-result",
      "job-a",
      "--force",
      "--no-preserve-patch",
      "--tail-lines",
      "12",
    ], fakeIo());
    expect(reconcileResult).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_reconcile_result",
    });
    if (reconcileResult.kind !== "mcp-tool") return;
    expect(JSON.parse(reconcileResult.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      forceWrite: true,
      preservePatch: false,
      tailLines: 12,
    });

    const controlEnqueue = parseCodexGoalCliArgs([
      "control-enqueue",
      "job-a",
      "--body",
      "Prefer targeted tests before full benchmark.",
      "--intent",
      "guidance",
      "--idempotency-key",
      "guidance-1",
      "--caller-kind",
      "agent",
      "--caller-id",
      "lead-agent",
    ], fakeIo());
    expect(controlEnqueue).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_control_enqueue",
    });
    if (controlEnqueue.kind !== "mcp-tool") return;
    expect(JSON.parse(controlEnqueue.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      intent: "guidance",
      body: "Prefer targeted tests before full benchmark.",
      idempotencyKey: "guidance-1",
      callerKind: "agent",
      callerId: "lead-agent",
    });

    const guidance = parseCodexGoalCliArgs([
      "guidance",
      "job-a",
      "--message",
      "Stop broad verification and inspect the targeted recall slice.",
      "--idempotency-key",
      "guidance-urgent-1",
      "--caller-kind",
      "agent",
      "--caller-id",
      "lead-agent",
    ], fakeIo());
    expect(guidance).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_send_guidance",
    });
    if (guidance.kind !== "mcp-tool") return;
    expect(JSON.parse(guidance.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      message: "Stop broad verification and inspect the targeted recall slice.",
      idempotencyKey: "guidance-urgent-1",
      callerKind: "agent",
      callerId: "lead-agent",
    });

    const controlList = parseCodexGoalCliArgs([
      "control-list",
      "job-a",
      "--include-bodies",
    ], fakeIo());
    expect(controlList).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_control_list",
    });
    if (controlList.kind !== "mcp-tool") return;
    expect(JSON.parse(controlList.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      includeBodies: true,
    });

    const controlReconcile = parseCodexGoalCliArgs([
      "control-reconcile",
      "job-a",
      "--repair",
      "--accepted-stale-after-ms",
      "60000",
    ], fakeIo());
    expect(controlReconcile).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_control_reconcile",
    });
    if (controlReconcile.kind !== "mcp-tool") return;
    expect(JSON.parse(controlReconcile.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      repair: true,
      acceptedStaleAfterMs: 60000,
    });

    const controlSupersede = parseCodexGoalCliArgs([
      "control-supersede",
      "job-a",
      "--signal-id",
      "signal-1",
      "--caller-kind",
      "user",
      "--caller-id",
      "local-user",
    ], fakeIo());
    expect(controlSupersede).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_control_supersede",
    });
    if (controlSupersede.kind !== "mcp-tool") return;
    expect(JSON.parse(controlSupersede.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      signalId: "signal-1",
      callerKind: "user",
      callerId: "local-user",
    });

    const relogin = parseCodexGoalCliArgs([
      "relogin",
      "job-a",
      "account-c",
    ], fakeIo());
    expect(relogin).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_accounts_relogin_instructions",
    });
    if (relogin.kind !== "mcp-tool") return;
    expect(JSON.parse(relogin.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      account: "account-c",
    });
  });

  it("keeps agent shortcut aliases mapped at the CLI boundary", () => {
    const runWatch = parseCodexGoalCliArgs([
      "agent-run-watch",
      "run-a",
      "--provider-kind",
      "agent-task",
      "--limit",
      "4",
    ], fakeIo());
    expect(runWatch).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_watch",
    });
    if (runWatch.kind !== "mcp-tool") return;
    expect(JSON.parse(runWatch.argsJson ?? "{}")).toEqual({
      providerKind: "agent-task",
      jobId: "run-a",
      limit: 4,
    });

    const runEvents = parseCodexGoalCliArgs([
      "run-events",
      "run-a",
      "--provider-kind",
      "local",
      "--type",
      "run.completed",
    ], fakeIo());
    expect(runEvents).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_events",
    });
    if (runEvents.kind !== "mcp-tool") return;
    expect(JSON.parse(runEvents.argsJson ?? "{}")).toEqual({
      providerKind: "local",
      jobId: "run-a",
      type: "run.completed",
    });

    const runState = parseCodexGoalCliArgs([
      "run-state",
      "run-a",
      "--provider-kind",
      "claude",
    ], fakeIo());
    expect(runState).toMatchObject({
      kind: "mcp-tool",
      name: "agent_run_state",
    });
    if (runState.kind !== "mcp-tool") return;
    expect(JSON.parse(runState.argsJson ?? "{}")).toEqual({
      providerKind: "claude",
      jobId: "run-a",
    });
  });

  it("relays run events to stdout and advances the delivery cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-relay-events-"));
    const store = new LocalFileRunEventStore({ rootDir: root });
    await store.append([
      makeRunEvent({
        runId: "run-a",
        type: RunEventType.Completed,
        occurredAt: "2026-07-02T00:00:00.000Z",
        source: {
          providerKind: RunEventProviderKind.Codex,
        },
        idempotencyParts: ["completed"],
      }),
    ]);

    const firstIo = captureIo();
    const firstExitCode = await runCodexGoalCli([
      "relay-events",
      "--event-root",
      root,
      "--consumer-id",
      "consumer-a",
      "--publisher",
      "stdout",
    ], firstIo);

    expect(firstExitCode).toBe(0);
    expect(JSON.parse(firstIo.stdout.trim())).toMatchObject({
      runId: "run-a",
      type: "run.completed",
    });

    const secondIo = captureIo();
    const secondExitCode = await runCodexGoalCli([
      "relay-events",
      "--event-root",
      root,
      "--consumer-id",
      "consumer-a",
      "--publisher",
      "stdout",
    ], secondIo);

    expect(secondExitCode).toBe(0);
    expect(secondIo.stdout).toBe("");
  });

});

function fakeIo(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexGoalCliIo {
  return {
    writeStdout(): void {},
    writeStderr(): void {},
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return env;
    },
  };
}

function captureIo(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexGoalCliIo & {
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  return {
    writeStdout(chunk): void {
      stdout += chunk;
    },
    writeStderr(chunk): void {
      stderr += chunk;
    },
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return env;
    },
    get stdout(): string {
      return stdout;
    },
    get stderr(): string {
      return stderr;
    },
  };
}
