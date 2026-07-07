import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { codexGoalAccountStatusPayload } from "./codex-goal-mcp-worker-control";

type JsonObject = Readonly<Record<string, unknown>>;

export async function codexGoalAccountCapacityFacts(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly loadLaunch: (
    manifest: CodexGoalJobManifest,
  ) => Promise<CodexGoalLaunchInput>;
}): Promise<JsonObject> {
  try {
    const launch = await input.loadLaunch(input.manifest);
    const payload = await codexGoalAccountStatusPayload(launch, {
      liveCheck: false,
    });
    const capacityBlockedAccounts = payload.accounts.filter((slot) =>
      slot.capacityAvailability && slot.capacityAvailability !== "available"
    );
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
  } catch (error) {
    return {
      ok: false,
      reason: "account_capacity_facts_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
