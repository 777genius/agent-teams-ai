import {
  AccountAvailability,
  AccountRecommendedAction,
  AuthSessionStatus,
  QuotaLimitState,
} from "./enums";
import type {
  AccountPoolObservationSummary,
  AccountObservation,
  AuthSession,
  AvailabilityDecision,
  QuotaSnapshot,
  QuotaWindow,
} from "./model";

export class ObservationPolicy {
  decide(input: {
    readonly auth: AuthSession;
    readonly quota: QuotaSnapshot | null;
    readonly probeDecision?: AvailabilityDecision;
  }): AvailabilityDecision {
    if (input.auth.status === AuthSessionStatus.ReloginRequired) {
      return decision(AccountAvailability.ReloginRequired, {
        reason: input.auth.reason ?? "auth_relogin_required",
      });
    }

    if (input.probeDecision?.availability === AccountAvailability.ReloginRequired) {
      return input.probeDecision;
    }

    const quotaCheckedAt = input.quota?.checkedAt;
    const limitedWindow = mostBlockingWindow(
      input.quota?.windows ?? [],
      quotaCheckedAt,
    );
    if (limitedWindow) {
      const limitResetAt = futureResetAt(
        limitedWindow.resetsAt,
        quotaCheckedAt,
      );
      return decision(AccountAvailability.Limited, {
        reason: limitedWindow.reachedType ?? "quota_limited",
        ...(limitResetAt ? { limitResetAt } : {}),
      });
    }

    if (input.probeDecision?.availability === AccountAvailability.Limited) {
      return input.probeDecision;
    }

    if (
      input.probeDecision &&
      input.probeDecision.availability !== AccountAvailability.Available
    ) {
      return input.probeDecision;
    }

    if (input.auth.status === AuthSessionStatus.Authenticated) {
      return decision(AccountAvailability.Available);
    }

    if (input.probeDecision) return input.probeDecision;

    if (input.auth.status === AuthSessionStatus.Unavailable) {
      return decision(AccountAvailability.AuthUnknown, {
        reason: input.auth.reason ?? "auth_unavailable",
      });
    }

    return decision(AccountAvailability.Unknown, {
      reason: input.auth.reason ?? "observation_incomplete",
    });
  }

  summarize(observations: readonly AccountObservation[]): AccountPoolObservationSummary {
    const available = observations.filter(
      (item) => item.decision.availability === AccountAvailability.Available,
    );
    const limited = observations.filter(
      (item) => item.decision.availability === AccountAvailability.Limited,
    );
    const relogin = observations.filter(
      (item) =>
        item.decision.availability === AccountAvailability.ReloginRequired,
    );
    const unknown = observations.filter(
      (item) =>
        item.decision.availability !== AccountAvailability.Available &&
        item.decision.availability !== AccountAvailability.Limited &&
        item.decision.availability !== AccountAvailability.ReloginRequired,
    );
    const nextAvailableAt = earliestReset(limited);
    return {
      availableCount: available.length,
      limitedCount: limited.length,
      reloginRequiredCount: relogin.length,
      unknownCount: unknown.length,
      schedulerEligibleSlotIds: available.map((item) => item.account.slotId),
      ...(nextAvailableAt ? { nextAvailableAt } : {}),
    };
  }
}

export function recommendedActionForAvailability(
  availability: AccountAvailability,
): AccountRecommendedAction {
  switch (availability) {
    case AccountAvailability.Available:
      return AccountRecommendedAction.None;
    case AccountAvailability.Limited:
      return AccountRecommendedAction.Wait;
    case AccountAvailability.ReloginRequired:
      return AccountRecommendedAction.Relogin;
    case AccountAvailability.AuthUnknown:
    case AccountAvailability.Unhealthy:
    case AccountAvailability.Unknown:
      return AccountRecommendedAction.Inspect;
  }
}

function decision(
  availability: AccountAvailability,
  extras: {
    readonly reason?: string;
    readonly limitResetAt?: Date;
  } = {},
): AvailabilityDecision {
  return {
    availability,
    recommendedAction: recommendedActionForAvailability(availability),
    schedulerEligible: availability === AccountAvailability.Available,
    ...(extras.reason ? { reason: extras.reason } : {}),
    ...(extras.limitResetAt ? { limitResetAt: extras.limitResetAt } : {}),
  };
}

function mostBlockingWindow(
  windows: readonly QuotaWindow[],
  checkedAt: Date | undefined,
): QuotaWindow | undefined {
  return windows
    .filter((window) => window.state === QuotaLimitState.Limited)
    .sort((left, right) => {
      const leftReset = futureResetAt(left.resetsAt, checkedAt)?.getTime();
      const rightReset = futureResetAt(right.resetsAt, checkedAt)?.getTime();
      if (leftReset === undefined && rightReset !== undefined) return -1;
      if (leftReset !== undefined && rightReset === undefined) return 1;
      return (rightReset ?? 0) - (leftReset ?? 0);
    })[0];
}

function futureResetAt(
  value: Date | undefined,
  checkedAt: Date | undefined,
): Date | undefined {
  if (!value || !Number.isFinite(value.getTime())) return undefined;
  if (checkedAt && value.getTime() <= checkedAt.getTime()) return undefined;
  return value;
}

function earliestReset(
  observations: readonly AccountObservation[],
): Date | undefined {
  const resets = observations
    .map((item) => item.decision.limitResetAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  return resets[0];
}
