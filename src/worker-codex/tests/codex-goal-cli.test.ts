import { describe, expect, it } from "vitest";
import {
  buildNoTmuxShellCommand,
  buildTmuxCommand,
  parseCodexGoalCliArgs,
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
      taskTimeoutMs: 72 * 60 * 60 * 1000,
      maxAccountCycles: 3,
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

    const tmux = buildTmuxCommand(command);
    expect(tmux.args).toEqual(
      expect.arrayContaining(["new-session", "-d", "-s", "goal-worker"]),
    );
    expect(tmux.preview).toContain("tmux new-session");
    expect(tmux.preview).toContain("tee -a /tmp/job/task-1.log");
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
