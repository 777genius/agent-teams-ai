import { listCodexGoalAccountStatuses } from "./codex-goal-ops";
import { uniqueProjectControlStrings } from "./codex-goal-mcp-project-utils";

export async function projectControlDefaultAccountNames(input: {
  readonly authRootDir?: string;
  readonly requestedAccounts: readonly string[];
  readonly allowedAccountIds: readonly string[];
}): Promise<readonly string[]> {
  if (!input.authRootDir) return input.requestedAccounts;
  const allowed = new Set(input.allowedAccountIds);
  if (
    allowed.size > 0 &&
    input.requestedAccounts.some((account) => !allowed.has(account))
  ) {
    return input.requestedAccounts;
  }
  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.authRootDir,
    recheckDueCapacity: true,
  });
  const capacityAllowed = slots.filter(capacityAllowsProjectSelection);
  const readyAccounts = capacityAllowed
    .filter((slot) =>
      slot.status === "ready" &&
      (allowed.size === 0 || allowed.has(slot.name))
    )
    .map((slot) => slot.name);
  if (readyAccounts.length > 0) return readyAccounts;
  const blockedByCapacity = new Set(
    slots
      .filter((slot) => !capacityAllowsProjectSelection(slot))
      .map((slot) => slot.name),
  );
  return input.requestedAccounts.filter(
    (account) => !blockedByCapacity.has(account),
  );
}

export async function projectControlRefillAccountNames(input: {
  readonly authRootDir?: string;
  readonly requestedAccounts: readonly string[];
  readonly allowedAccountIds: readonly string[];
  readonly rotationKey?: string;
}): Promise<readonly string[]> {
  const requestedAccounts = input.requestedAccounts.length
    ? uniqueProjectControlStrings(input.requestedAccounts)
    : await projectControlDefaultAccountNames(input);
  const allowed = new Set(input.allowedAccountIds);
  const scopedAccounts = requestedAccounts.filter((account) =>
    allowed.size === 0 || allowed.has(account)
  );
  if (!input.authRootDir || scopedAccounts.length === 0) {
    return rotateProjectControlAccountNames(scopedAccounts, input.rotationKey);
  }

  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.authRootDir,
    accounts: scopedAccounts,
    recheckDueCapacity: true,
  });
  const capacityAllowedSlots = slots.filter(capacityAllowsProjectSelection);
  const ready = new Set(
    capacityAllowedSlots
      .filter((slot) => slot.status === "ready")
      .map((slot) => slot.name),
  );
  const capacityAllowed = new Set(capacityAllowedSlots.map((slot) => slot.name));
  const selected = ready.size > 0 ? ready : capacityAllowed;
  return rotateProjectControlAccountNames(
    scopedAccounts.filter((account) => selected.has(account)),
    input.rotationKey,
  );
}

function capacityAllowsProjectSelection(input: {
  readonly schedulerEligible: boolean;
  readonly capacityAvailability?: string;
}): boolean {
  return input.capacityAvailability === undefined || input.schedulerEligible;
}

export function rotateProjectControlAccountNames(
  accounts: readonly string[],
  rotationKey?: string,
): readonly string[] {
  if (accounts.length < 2 || !rotationKey?.trim()) return [...accounts];
  const offset = stableRotationOffset(rotationKey, accounts.length);
  return [...accounts.slice(offset), ...accounts.slice(0, offset)];
}

function stableRotationOffset(rotationKey: string, accountCount: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < rotationKey.length; index += 1) {
    hash ^= rotationKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % accountCount;
}
