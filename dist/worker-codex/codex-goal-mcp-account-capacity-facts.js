import { codexGoalAccountStatusPayload } from "./codex-goal-mcp-worker-control.js";
export async function codexGoalAccountCapacityFacts(input) {
    try {
        const launch = await input.loadLaunch(input.manifest);
        const payload = await codexGoalAccountStatusPayload(launch, {
            liveCheck: false,
        });
        const capacityBlockedAccounts = payload.accounts.filter((slot) => slot.capacityAvailability && slot.capacityAvailability !== "available");
        return {
            ok: true,
            capacityAware: payload.capacityAware,
            summary: payload.summary,
            capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
                name: slot.name,
                availability: slot.capacityAvailability,
                reason: slot.capacityReason,
                cooldownUntil: slot.capacityCooldownUntil,
            })),
            availableDedupedAccountNames: payload.availableDedupedAccountNames,
        };
    }
    catch (error) {
        return {
            ok: false,
            reason: "account_capacity_facts_unavailable",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
//# sourceMappingURL=codex-goal-mcp-account-capacity-facts.js.map