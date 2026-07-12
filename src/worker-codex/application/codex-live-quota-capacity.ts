import {
  AccountAvailability,
  QuotaLimitState,
  type AccountObservation,
  type QuotaWindow,
} from "@vioxen/agent-account-observability";
import type {
  WorkerAccountCapacityStore,
  WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { codexCapacityAccountIdFromIdentity } from "./codex-account-capacity-alias-store";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacitySignalScope,
} from "@vioxen/subscription-runtime/worker-core";

export const codexLiveQuotaCapacitySource = "codex_app_server_live_quota";

export function recordCodexLiveQuotaCapacity(input: {
  readonly accountId: string;
  readonly observation: AccountObservation;
  readonly store: WorkerAccountCapacityStore;
}): boolean {
  const accountId = codexCapacityAccountIdFromIdentity(
    input.observation.auth.identity,
    input.accountId,
  );
  const capacity = codexLiveQuotaCapacitySnapshot(input.observation);
  const current = input.store.readState({
    accountId,
    now: input.observation.checkedAt,
  });
  if (
    current &&
    current.demand === null &&
    isQuotaCapacityRecord(current.capacity) &&
    (capacity ||
      input.observation.decision.availability === AccountAvailability.Available)
  ) {
    if (
      !capacity &&
      input.observation.decision.availability === AccountAvailability.Available &&
      current.accountId.startsWith("codex-provider:") &&
      !input.observation.auth.identity?.accountKeyHash
    ) {
      return false;
    }
    const claimed = input.store.tryClaimRecheck({
      state: current,
      ownerId: `codex-live-status:${accountId}`,
      now: input.observation.checkedAt,
      ttlMs: 30_000,
      mode: WorkerAccountCapacityRecheckMode.Refresh,
    });
    if (claimed.status !== WorkerAccountCapacityClaimStatus.Claimed) {
      if (!capacity) return false;
      input.store.observe({
        accountId,
        scope: WorkerAccountCapacitySignalScope.AccountWide,
        capacity,
        observedAt: input.observation.checkedAt,
      });
      return true;
    }
    input.store.resolveRecheck({
      claim: claimed.claim,
      observedAt: input.observation.checkedAt,
      resolution: capacity
        ? {
            type: WorkerAccountCapacityResolutionType.Limited,
            capacity,
          }
        : { type: WorkerAccountCapacityResolutionType.Available },
    });
    return true;
  }
  if (!capacity) return false;
  input.store.observe({
    accountId,
    scope: WorkerAccountCapacitySignalScope.AccountWide,
    capacity,
    observedAt: input.observation.checkedAt,
  });
  return true;
}

function isQuotaCapacityRecord(capacity: WorkerCapacitySnapshot): boolean {
  return capacity.reason === "quota_limited" ||
    capacity.reason?.startsWith("quota_recheck_") === true ||
    capacity.details?.capacitySource === codexLiveQuotaCapacitySource;
}

export function codexLiveQuotaCapacitySnapshot(
  observation: AccountObservation,
): WorkerCapacitySnapshot | null {
  const { decision, checkedAt } = observation;
  if (decision.availability !== AccountAvailability.Limited) return null;
  if (
    !decision.limitResetAt ||
    decision.limitResetAt.getTime() <= checkedAt.getTime()
  ) {
    return null;
  }
  const limitedWindows = observation.quota?.windows.filter(
    (window) => window.state === QuotaLimitState.Limited,
  ) ?? [];
  return {
    availability: "quota_exhausted",
    reason: "quota_limited",
    cooldownUntil: decision.limitResetAt,
    lastLimitSignalAt: checkedAt,
    details: liveQuotaCapacityDetails(observation, limitedWindows),
  };
}

function liveQuotaCapacityDetails(
  observation: AccountObservation,
  limitedWindows: readonly QuotaWindow[],
): Readonly<Record<string, string>> {
  const windowKinds = uniqueStrings(limitedWindows.map((window) => window.kind));
  const limitIds = uniqueStrings(limitedWindows.map((window) => window.limitId));
  const limitNames = uniqueStrings(
    limitedWindows.map((window) => window.limitName),
  );
  const reachedTypes = uniqueStrings(
    limitedWindows.map((window) => window.reachedType),
  );
  return {
    provider: observation.account.provider,
    capacitySource: codexLiveQuotaCapacitySource,
    quotaReason: observation.decision.reason ?? "quota_limited",
    ...(observation.quota?.planType
      ? { quotaPlanType: observation.quota.planType }
      : {}),
    ...(windowKinds.length > 0
      ? { quotaWindowKinds: windowKinds.join(",") }
      : {}),
    ...(limitIds.length > 0 ? { quotaLimitIds: limitIds.join(",") } : {}),
    ...(limitNames.length > 0
      ? { quotaLimitNames: limitNames.join(",") }
      : {}),
    ...(reachedTypes.length > 0
      ? { quotaReachedTypes: reachedTypes.join(",") }
      : {}),
  };
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
