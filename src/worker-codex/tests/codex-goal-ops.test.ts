import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { codexGoalAccountSlots, type CodexGoalRunConfig } from "../codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";

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

  it("doctors a sandbox worker layout and reports sanitized account status", async () => {
    const fixture = await createGoalFixture();

    const doctor = await doctorCodexGoal({
      config: fixture.config,
      tmuxSession: "subscription-runtime-test-session",
    });
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: fixture.config.authRootDir,
      accounts: ["account-a"],
    });

    expect(doctor.ok).toBe(true);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.status).toBe("ready");
    expect(JSON.stringify(accounts)).not.toContain("refresh-secret");
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

  it("does not recommend a first start when the workspace is already dirty", async () => {
    const fixture = await createGoalFixture();
    await writeFile(join(fixture.config.workspacePath, "untracked.txt"), "dirty\n");

    const status = await collectCodexGoalStatus({
      jobRootDir: fixture.config.jobRootDir,
      taskId: fixture.config.taskId,
      workspacePath: fixture.config.workspacePath,
    });

    expect(status.resultExists).toBe(false);
    expect(status.workspaceDirty).toBe(true);
    expect(status.recommendedAction).toBe("inspect_dirty_workspace");
  });
});

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
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      codexBinaryPath: "codex",
      permissionMode: "allow-edits",
      taskTimeoutMs: 72 * 60 * 60 * 1000,
      maxAccountCycles: 3,
      requireGitWorkspace: true,
    },
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
