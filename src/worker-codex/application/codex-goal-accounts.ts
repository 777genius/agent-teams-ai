import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listCodexGoalAccountStatuses,
  shellQuote,
} from "../codex-goal-ops";
import { defaultCodexGoalAuthRoot } from "./codex-goal-account-roots";
import { resolvePath } from "./codex-goal-input-values";

type JsonObject = Readonly<Record<string, unknown>>;

export type CodexAccountPoolArgs = {
  readonly authRootDir?: string;
  readonly pool?: string;
  readonly poolRootDir?: string;
};

type CodexGoalAccountSlots = Awaited<
  ReturnType<typeof listCodexGoalAccountStatuses>
>;

type CodexGoalAccountSlot = CodexGoalAccountSlots[number];

export async function codexAccountStatusPayload(input: {
  readonly authRootDir: string;
  readonly stateRootDir?: string;
  readonly accounts?: readonly string[];
  readonly liveCheck?: boolean;
  readonly codexBinaryPath?: string;
  readonly liveCheckTimeoutMs?: number;
}) {
  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.authRootDir,
    ...(input.accounts?.length ? { accounts: input.accounts } : {}),
    ...(input.stateRootDir ? { stateRootDir: input.stateRootDir } : {}),
    ...(input.liveCheck ? { liveCheck: input.liveCheck } : {}),
    ...(input.codexBinaryPath ? { codexBinaryPath: input.codexBinaryPath } : {}),
    ...(input.liveCheckTimeoutMs
      ? { liveCheckTimeoutMs: input.liveCheckTimeoutMs }
      : {}),
  });
  const duplicates = duplicateAccountGroups(slots);
  const dedupedSlots = dedupeCodexGoalAccountSlots(slots);
  const availableDedupedSlots = availableCodexGoalAccountSlots(dedupedSlots);
  const readySlots = slots.filter((slot) => slot.status === "ready");
  const missingSlots = slots.filter((slot) => slot.status === "auth_missing");
  const invalidSlots = slots.filter((slot) => slot.status === "auth_invalid");
  const capacityBlockedSlots = slots.filter((slot) =>
    slot.capacityAvailability && slot.capacityAvailability !== "available"
  );
  return {
    ok: availableDedupedSlots.length > 0,
    authRootDir: input.authRootDir,
    capacityAware: Boolean(input.stateRootDir),
    liveCheck: Boolean(input.liveCheck),
    ...(input.stateRootDir ? { stateRootDir: input.stateRootDir } : {}),
    count: slots.length,
    available: availableDedupedSlots.length,
    hasAvailableAccount: availableDedupedSlots.length > 0,
    summary: {
      configured: slots.length,
      ready: readySlots.length,
      missing: missingSlots.length,
      invalid: invalidSlots.length,
      deduped: dedupedSlots.length,
      availableDeduped: availableDedupedSlots.length,
      capacityBlocked: capacityBlockedSlots.length,
      duplicateGroups: duplicates.length,
    },
    accounts: slots,
    slots,
    duplicates,
    dedupedAccountNames: dedupedSlots.map((slot) => slot.name),
    availableDedupedAccountNames: availableDedupedSlots.map((slot) => slot.name),
    dedupedAccountLabels: dedupedSlots.map(accountOperatorLabel),
    availableDedupedAccountLabels: availableDedupedSlots.map(accountOperatorLabel),
    dedupeRecommendation: duplicates.length
      ? "Use dedupedAccountNames for worker pools. It keeps the newest ready slot per identity group."
      : "No duplicate identity groups detected.",
  };
}

export function codexAccountReloginInstructions(input: {
  readonly authRootDir: string;
  readonly account: string;
  readonly afterLoginInstruction: string;
}): readonly string[] {
  return [
    "This is a manual relogin flow. It does not automate browser login.",
    `mkdir -p ${shellText(join(input.authRootDir, input.account))}`,
    `test ! -f ${shellText(join(input.authRootDir, input.account, "auth.json"))} || cp ${shellText(join(input.authRootDir, input.account, "auth.json"))} ${shellText(join(input.authRootDir, input.account, "auth.json.bak.$(date +%Y%m%d-%H%M%S).before-relogin"))}`,
    `CODEX_HOME=${shellText(join(input.authRootDir, input.account))} codex login --device-auth`,
    input.afterLoginInstruction,
  ];
}

export function duplicateAccountGroups(
  slots: CodexGoalAccountSlots,
): readonly JsonObject[] {
  const groups = new Map<string, typeof slots>();
  for (const slot of slots) {
    if (!slot.identityHashPrefix) continue;
    groups.set(slot.identityHashPrefix, [
      ...(groups.get(slot.identityHashPrefix) ?? []),
      slot,
    ]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([identityHashPrefix, group]) => ({
      identityHashPrefix,
      slots: group.map((slot) => ({
        name: slot.name,
        operatorLabel: slot.operatorLabel,
        displayName: slot.displayName,
        email: slot.email,
        shortName: slot.shortName,
        status: slot.status,
        lastRefreshAt: slot.lastRefreshAt,
        expiresAt: slot.expiresAt,
      })),
      preferredSlot: preferredAccountSlot(group)?.name,
      preferredSlotLabel: preferredAccountSlot(group)
        ? accountOperatorLabel(preferredAccountSlot(group)!)
        : undefined,
    }));
}

export function accountOperatorLabel(slot: CodexGoalAccountSlot): string {
  return slot.operatorLabel ?? slot.displayName ?? slot.email ?? slot.name;
}

export function dedupeCodexGoalAccountSlots(slots: CodexGoalAccountSlots) {
  const byIdentity = new Map<string, CodexGoalAccountSlot>();
  const uniqueSlots: CodexGoalAccountSlot[] = [];
  for (const slot of slots) {
    const key = slot.identityHashPrefix;
    if (!key) {
      uniqueSlots.push(slot);
      continue;
    }
    const existing = byIdentity.get(key);
    const preferred = existing ? preferredAccountSlot([existing, slot]) : slot;
    if (preferred) byIdentity.set(key, preferred);
  }
  const duplicateIdentities = new Set(
    duplicateAccountGroups(slots)
      .map((group) => group.identityHashPrefix)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const slot of slots) {
    if (!slot.identityHashPrefix || duplicateIdentities.has(slot.identityHashPrefix)) {
      continue;
    }
    uniqueSlots.push(slot);
  }
  return [
    ...uniqueSlots,
    ...[...byIdentity.entries()]
      .filter(([identity]) => duplicateIdentities.has(identity))
      .map(([, slot]) => slot),
  ];
}

export function availableCodexGoalAccountSlots(slots: CodexGoalAccountSlots) {
  return slots.filter(isAccountSlotAvailable);
}

export function visibleCodexGoalAccountPoolSlots(
  poolName: string,
  slots: CodexGoalAccountSlots,
) {
  const likelyAuthPool = isLikelyAuthPoolName(poolName);
  return slots.filter((slot) =>
    slot.status !== "auth_missing" ||
    likelyAuthPool
  );
}

export function accountPoolRootFromArgs(args: CodexAccountPoolArgs): string {
  return resolvePath(
    process.cwd(),
    args.poolRootDir ?? join(homedir(), ".cache", "subscription-runtime"),
  );
}

export function accountAuthRootFromArgs(args: CodexAccountPoolArgs): string {
  if (args.authRootDir) return resolvePath(process.cwd(), args.authRootDir);
  if (args.pool) return join(accountPoolRootFromArgs(args), args.pool);
  return resolvePath(process.cwd(), defaultCodexGoalAuthRoot);
}

export async function listAccountPools(
  poolRootDir: string,
  stateRootDir?: string,
): Promise<readonly JsonObject[]> {
  let entries;
  try {
    entries = await readdir(poolRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pools = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const authRootDir = join(poolRootDir, entry.name);
        const slots = await listCodexGoalAccountStatuses({
          authRootDir,
          ...(stateRootDir ? { stateRootDir } : {}),
        });
        const visibleSlots = visibleCodexGoalAccountPoolSlots(entry.name, slots);
        const dedupedSlots = dedupeCodexGoalAccountSlots(visibleSlots);
        const availableDedupedSlots = availableCodexGoalAccountSlots(dedupedSlots);
        return {
          pool: entry.name,
          authRootDir,
          accountCount: visibleSlots.length,
          readyCount: visibleSlots.filter((slot) => slot.status === "ready").length,
          availableCount: availableDedupedSlots.length,
          dedupedAccountNames: dedupedSlots.map((slot) => slot.name),
          availableDedupedAccountNames: availableDedupedSlots.map((slot) => slot.name),
          dedupedAccountLabels: dedupedSlots.map(accountOperatorLabel),
          availableDedupedAccountLabels: availableDedupedSlots.map(accountOperatorLabel),
          hasDuplicates: duplicateAccountGroups(visibleSlots).length > 0,
        };
      }),
  );
  return pools.filter((pool) => (pool.accountCount as number) > 0);
}

function preferredAccountSlot(slots: CodexGoalAccountSlots) {
  return [...slots].sort((left, right) => {
    const leftReady = left.schedulerEligible ? 1 : 0;
    const rightReady = right.schedulerEligible ? 1 : 0;
    if (leftReady !== rightReady) return rightReady - leftReady;
    return Date.parse(right.lastRefreshAt ?? right.expiresAt ?? "0") -
      Date.parse(left.lastRefreshAt ?? left.expiresAt ?? "0");
  })[0];
}

function isAccountSlotAvailable(slot: CodexGoalAccountSlot): boolean {
  return slot.schedulerEligible;
}

function isLikelyAuthPoolName(name: string): boolean {
  return /codex/i.test(name) &&
    /(?:^|[-_])(auth|accounts?)(?:$|[-_])/i.test(name);
}

function shellText(value: string): string {
  return shellQuote(value);
}
