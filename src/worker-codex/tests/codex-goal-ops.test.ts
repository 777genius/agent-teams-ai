import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import { codexGoalAccountSlots, type CodexGoalRunConfig } from "../codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
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
      tmuxSession: "subscription-runtime-test-session",
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
