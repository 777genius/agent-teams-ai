import { listCodexGoalAccountStatuses } from "./codex-goal-ops.js";
import { uniqueProjectControlStrings } from "./codex-goal-mcp-project-utils.js";
export async function projectControlDefaultAccountNames(input) {
    if (!input.authRootDir)
        return input.requestedAccounts;
    const allowed = new Set(input.allowedAccountIds);
    const slots = await listCodexGoalAccountStatuses({
        authRootDir: input.authRootDir,
    });
    const readyAccounts = slots
        .filter((slot) => slot.status === "ready" &&
        (allowed.size === 0 || allowed.has(slot.name)))
        .map((slot) => slot.name);
    return readyAccounts.length > 0 ? readyAccounts : input.requestedAccounts;
}
export async function projectControlRefillAccountNames(input) {
    const requestedAccounts = input.requestedAccounts.length
        ? uniqueProjectControlStrings(input.requestedAccounts)
        : await projectControlDefaultAccountNames(input);
    const allowed = new Set(input.allowedAccountIds);
    const scopedAccounts = requestedAccounts.filter((account) => allowed.size === 0 || allowed.has(account));
    if (!input.authRootDir || scopedAccounts.length === 0)
        return scopedAccounts;
    const slots = await listCodexGoalAccountStatuses({
        authRootDir: input.authRootDir,
        accounts: scopedAccounts,
    });
    const ready = new Set(slots
        .filter((slot) => slot.status === "ready")
        .map((slot) => slot.name));
    return ready.size > 0
        ? scopedAccounts.filter((account) => ready.has(account))
        : scopedAccounts;
}
//# sourceMappingURL=codex-goal-mcp-project-accounts.js.map