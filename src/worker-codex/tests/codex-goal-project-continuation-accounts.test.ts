import { describe, expect, it } from "vitest";

import type { CodexGoalAccountSlotStatus } from "../codex-goal-account-status";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { withProjectContinuationAccounts } from "../application/project-control/codex-goal-project-continuation-accounts";

describe("project continuation accounts", () => {
  it("materializes an ephemeral account-c launch for a validated continuation", async () => {
    const launch = launchFixture();
    const statusInputs: unknown[] = [];
    const continued = await withProjectContinuationAccounts({
      launch,
      requestedAccounts: ["account-c"],
      continuation: { previousAttemptCount: 2 },
      excludedAccountIds: ["account-e"],
      allowedAccountIds: ["account-c", "account-e"],
      listAccountStatuses: async (input) => {
        statusInputs.push(input);
        return [readyAccount("account-c"), readyAccount("account-e")];
      },
    });

    expect(continued.config.accounts).toEqual([
      {
        name: "account-c",
        authJsonPath: "/auth/account-c/auth.json",
      },
    ]);
    expect(launch.config.accounts).toEqual([{ name: "account-e" }]);
    expect(statusInputs).toEqual([{ authRootDir: "/auth" }]);
  });

  it("rejects fallback accounts outside an exact capacity continuation", async () => {
    await expect(
      withProjectContinuationAccounts({
        launch: launchFixture(),
        requestedAccounts: ["account-c"],
        excludedAccountIds: ["account-e"],
        allowedAccountIds: ["account-c", "account-e"],
      }),
    ).rejects.toThrow(
      "project_control_continuation_accounts_account_unavailable_proof_required",
    );
  });

  it("allows a scoped ready account for an already verified terminal handoff recovery", async () => {
    const launch = launchFixture();
    const continued = await withProjectContinuationAccounts({
      launch,
      requestedAccounts: ["account-c"],
      verifiedTerminalHandoffRecovery: true,
      excludedAccountIds: [],
      allowedAccountIds: ["account-c", "account-e"],
      listAccountStatuses: async () => [
        readyAccount("account-c"),
        readyAccount("account-e"),
      ],
    });

    expect(continued.config.accounts).toEqual([
      {
        name: "account-c",
        authJsonPath: "/auth/account-c/auth.json",
      },
    ]);
    expect(launch.config.accounts).toEqual([{ name: "account-e" }]);
  });

  it("requires an exact non-empty scope and a genuinely alternative terminal recovery account", async () => {
    const base = {
      launch: launchFixture(),
      requestedAccounts: ["account-c"],
      verifiedTerminalHandoffRecovery: true,
      excludedAccountIds: [],
      listAccountStatuses: async () => [readyAccount("account-c")],
    };
    await expect(
      withProjectContinuationAccounts({
        ...base,
        allowedAccountIds: [],
      }),
    ).rejects.toThrow(
      "project_control_terminal_recovery_account_scope_required",
    );
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-e"],
        allowedAccountIds: ["account-c", "account-e"],
      }),
    ).rejects.toThrow(
      "project_control_terminal_recovery_alternative_account_required:account-e",
    );
  });

  it("rejects empty, duplicate, out-of-scope, and unavailable accounts", async () => {
    const base = {
      launch: launchFixture(),
      continuation: { previousAttemptCount: 2 },
      excludedAccountIds: ["account-e"],
      allowedAccountIds: ["account-c", "account-e"],
    };
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: [],
      }),
    ).rejects.toThrow("project_control_continuation_accounts_required");
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-c", "account-c"],
      }),
    ).rejects.toThrow("project_control_continuation_accounts_duplicate");
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-e"],
      }),
    ).rejects.toThrow(
      "project_control_continuation_account_previously_failed:account-e",
    );
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-z"],
      }),
    ).rejects.toThrow(
      "project_control_continuation_account_outside_scope:account-z",
    );
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["../account-c"],
      }),
    ).rejects.toThrow("project_control_continuation_account_id_invalid");
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-c,account-e"],
      }),
    ).rejects.toThrow("project_control_continuation_account_id_invalid");
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["Account-C"],
      }),
    ).rejects.toThrow("project_control_continuation_account_id_invalid");
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-c"],
        allowedAccountIds: [],
        listAccountStatuses: async () => [readyAccount("account-e")],
      }),
    ).rejects.toThrow(
      "project_control_continuation_account_auth_unavailable:account-c",
    );
    await expect(
      withProjectContinuationAccounts({
        ...base,
        requestedAccounts: ["account-c"],
        listAccountStatuses: async () => [missingAccount("account-c")],
      }),
    ).rejects.toThrow(
      "project_control_continuation_account_auth_unavailable:account-c",
    );
  });
});

function launchFixture(): CodexGoalLaunchInput {
  return {
    config: {
      jobRootDir: "/jobs/project-worker",
      authRootDir: "/auth",
      workspacePath: "/worktrees/project-worker",
      promptPath: "/jobs/project-worker/prompt.md",
      taskId: "project-worker",
      accounts: [{ name: "account-e" }],
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: "default",
      executionEngine: "app-server-goal",
      taskTimeoutMs: 60_000,
      progressHeartbeatMs: 60_000,
      maxAccountCycles: 1,
      allowDangerFullAccess: false,
      allowDuplicateAccountIdentities: false,
      requireGitWorkspace: true,
      prewarmOnStart: false,
    },
    tmuxSession: "project-worker",
    cwd: "/worktrees/project-worker",
    logPath: "/jobs/project-worker/worker.log",
    format: "json",
    cliCommand: ["subscription-runtime-codex-goal"],
  };
}

function readyAccount(name: string): CodexGoalAccountSlotStatus {
  return {
    name,
    authJsonPath: `/auth/${name}/auth.json`,
    status: "ready",
    availability: "available",
    schedulerEligible: true,
    recommendedAction: "none",
    warnings: [],
    safeMessage: "ready",
  };
}

function missingAccount(name: string): CodexGoalAccountSlotStatus {
  return {
    ...readyAccount(name),
    status: "auth_missing",
    availability: "reconnect_required",
    schedulerEligible: false,
    recommendedAction: "relogin",
    safeMessage: "auth missing",
  };
}
