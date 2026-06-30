import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNoTmuxShellCommand,
  buildTmuxCommand,
  parseCodexGoalCliArgs,
  runCodexGoalCli,
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
        "--task-id",
        "task-1",
        "--accounts",
        "account-a,account-b",
        "--tmux-session",
        "goal-worker",
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
      taskId: "task-1",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      executionEngine: "app-server-goal",
      taskTimeoutMs: 72 * 60 * 60 * 1000,
      progressPath: "/tmp/job/task-1.progress.json",
      progressHeartbeatMs: 60_000,
      maxAccountCycles: 5,
      requireGitWorkspace: true,
    });
    expect(command.config.accounts.map((account) => account.name)).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(command.tmuxSession).toBe("goal-worker");
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
    expect(noTmux).toContain("--effort xhigh");
    expect(noTmux).toContain("--service-tier fast");
    expect(noTmux).toContain("--execution-engine app-server-goal");
    expect(noTmux).toContain("--progress /tmp/job/task-1.progress.json");

    const tmux = buildTmuxCommand(command);
    expect(tmux.args).toEqual(
      expect.arrayContaining(["new-session", "-d", "-s", "goal-worker"]),
    );
    expect(tmux.preview).toContain("tmux new-session");
    expect(tmux.preview).toContain("tee -a /tmp/job/task-1.log");
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
        expect.objectContaining({ name: "codex_goal_reconcile_preview" }),
        expect.objectContaining({ name: "codex_goal_brief" }),
        expect.objectContaining({ name: "codex_goal_watch" }),
        expect.objectContaining({ name: "codex_goal_decision" }),
        expect.objectContaining({ name: "codex_goal_overview" }),
        expect.objectContaining({ name: "codex_goal_accounts_status" }),
        expect.objectContaining({ name: "codex_goal_continue" }),
        expect.objectContaining({ name: "codex_goal_stop" }),
      ]),
    );
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

  it("builds shortcut commands for common agent operations", () => {
    const overview = parseCodexGoalCliArgs([
      "overview",
      "--registry-root",
      "/tmp/registry",
      "--limit",
      "5",
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

  it("doctors the SDK-backed control surface", async () => {
    const io = captureIo();

    const exitCode = await runCodexGoalCli(["doctor-control"], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toMatchObject({
      ok: true,
      mode: "sdk-in-process",
      missingTools: [],
    });
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
