import type { CodexGoalAccountSlotStatus } from "../../codex-goal-account-status";
import { listCodexGoalAccountStatuses } from "../../codex-goal-ops";
import type { CodexGoalLaunchInput } from "../../codex-goal-ops";
import type { CodexProjectAccountContinuation } from "./codex-goal-project-account-reservation";

export async function withProjectContinuationAccounts(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly requestedAccounts?: readonly string[];
  readonly continuation?: CodexProjectAccountContinuation;
  readonly verifiedTerminalHandoffRecovery?: boolean;
  readonly excludedAccountIds: readonly string[];
  readonly allowedAccountIds: readonly string[];
  readonly listAccountStatuses?: typeof listCodexGoalAccountStatuses;
}): Promise<CodexGoalLaunchInput> {
  if (input.requestedAccounts === undefined) return input.launch;
  if (!input.continuation && input.verifiedTerminalHandoffRecovery !== true) {
    throw new Error(
      "project_control_continuation_accounts_account_unavailable_proof_required",
    );
  }
  if (input.requestedAccounts.length === 0) {
    throw new Error("project_control_continuation_accounts_required");
  }
  const uniqueAccounts = new Set(input.requestedAccounts);
  if (uniqueAccounts.size !== input.requestedAccounts.length) {
    throw new Error("project_control_continuation_accounts_duplicate");
  }
  const invalidAccountId = input.requestedAccounts.find(
    (accountId) => !/^[a-z0-9][a-z0-9._-]*$/.test(accountId),
  );
  if (invalidAccountId) {
    throw new Error("project_control_continuation_account_id_invalid");
  }
  const excluded = new Set(input.excludedAccountIds);
  const previouslyFailed = input.requestedAccounts.find((accountId) =>
    excluded.has(accountId),
  );
  if (previouslyFailed) {
    throw new Error(
      `project_control_continuation_account_previously_failed:${previouslyFailed}`,
    );
  }
  const allowed = new Set(input.allowedAccountIds);
  const outsideScope = input.requestedAccounts.find(
    (accountId) => allowed.size > 0 && !allowed.has(accountId),
  );
  if (outsideScope) {
    throw new Error(
      `project_control_continuation_account_outside_scope:${outsideScope}`,
    );
  }
  const statuses = await (
    input.listAccountStatuses ?? listCodexGoalAccountStatuses
  )({
    authRootDir: input.launch.config.authRootDir,
  });
  const statusesByName = new Map(
    statuses.map((status) => [status.name, status]),
  );
  const unavailable = input.requestedAccounts.filter(
    (accountId) => statusesByName.get(accountId)?.status !== "ready",
  );
  if (unavailable.length > 0) {
    throw new Error(
      `project_control_continuation_account_auth_unavailable:${unavailable.join(",")}`,
    );
  }
  return {
    ...input.launch,
    config: {
      ...input.launch.config,
      accounts: input.requestedAccounts.map((accountId) =>
        accountSlot(statusesByName.get(accountId)!),
      ),
    },
  };
}

function accountSlot(
  status: Pick<CodexGoalAccountSlotStatus, "name" | "authJsonPath">,
): { readonly name: string; readonly authJsonPath: string } {
  return { name: status.name, authJsonPath: status.authJsonPath };
}
