import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listCodexGoalAccountStatuses, shellQuote, } from "../codex-goal-ops.js";
import { defaultCodexGoalAuthRoot } from "./codex-goal-account-roots.js";
import { resolvePath } from "./codex-goal-input-values.js";
export async function codexAccountStatusPayload(input) {
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
    const capacityBlockedSlots = slots.filter((slot) => slot.capacityAvailability && slot.capacityAvailability !== "available");
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
export function codexAccountReloginInstructions(input) {
    return [
        "This is a manual relogin flow. It does not automate browser login.",
        `mkdir -p ${shellText(join(input.authRootDir, input.account))}`,
        `test ! -f ${shellText(join(input.authRootDir, input.account, "auth.json"))} || cp ${shellText(join(input.authRootDir, input.account, "auth.json"))} ${shellText(join(input.authRootDir, input.account, "auth.json.bak.$(date +%Y%m%d-%H%M%S).before-relogin"))}`,
        `CODEX_HOME=${shellText(join(input.authRootDir, input.account))} codex login --device-auth`,
        input.afterLoginInstruction,
    ];
}
export function duplicateAccountGroups(slots) {
    const groups = new Map();
    for (const slot of slots) {
        if (!slot.identityHashPrefix)
            continue;
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
            ? accountOperatorLabel(preferredAccountSlot(group))
            : undefined,
    }));
}
export function accountOperatorLabel(slot) {
    return slot.operatorLabel ?? slot.displayName ?? slot.email ?? slot.name;
}
export function dedupeCodexGoalAccountSlots(slots) {
    const byIdentity = new Map();
    const uniqueSlots = [];
    for (const slot of slots) {
        const key = slot.identityHashPrefix;
        if (!key) {
            uniqueSlots.push(slot);
            continue;
        }
        const existing = byIdentity.get(key);
        const preferred = existing ? preferredAccountSlot([existing, slot]) : slot;
        if (preferred)
            byIdentity.set(key, preferred);
    }
    const duplicateIdentities = new Set(duplicateAccountGroups(slots)
        .map((group) => group.identityHashPrefix)
        .filter((value) => typeof value === "string"));
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
export function availableCodexGoalAccountSlots(slots) {
    return slots.filter(isAccountSlotAvailable);
}
export function visibleCodexGoalAccountPoolSlots(poolName, slots) {
    const likelyAuthPool = isLikelyAuthPoolName(poolName);
    return slots.filter((slot) => slot.status !== "auth_missing" ||
        likelyAuthPool);
}
export function accountPoolRootFromArgs(args) {
    return resolvePath(process.cwd(), args.poolRootDir ?? join(homedir(), ".cache", "subscription-runtime"));
}
export function accountAuthRootFromArgs(args) {
    if (args.authRootDir)
        return resolvePath(process.cwd(), args.authRootDir);
    if (args.pool)
        return join(accountPoolRootFromArgs(args), args.pool);
    return resolvePath(process.cwd(), defaultCodexGoalAuthRoot);
}
export async function listAccountPools(poolRootDir, stateRootDir) {
    let entries;
    try {
        entries = await readdir(poolRootDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const pools = await Promise.all(entries
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
    }));
    return pools.filter((pool) => pool.accountCount > 0);
}
function preferredAccountSlot(slots) {
    return [...slots].sort((left, right) => {
        const leftReady = left.schedulerEligible ? 1 : 0;
        const rightReady = right.schedulerEligible ? 1 : 0;
        if (leftReady !== rightReady)
            return rightReady - leftReady;
        return Date.parse(right.lastRefreshAt ?? right.expiresAt ?? "0") -
            Date.parse(left.lastRefreshAt ?? left.expiresAt ?? "0");
    })[0];
}
function isAccountSlotAvailable(slot) {
    return slot.schedulerEligible;
}
function isLikelyAuthPoolName(name) {
    return /codex/i.test(name) &&
        /(?:^|[-_])(auth|accounts?)(?:$|[-_])/i.test(name);
}
function shellText(value) {
    return shellQuote(value);
}
//# sourceMappingURL=codex-goal-accounts.js.map