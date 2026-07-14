import {
  AccountAvailability,
  AccountRecommendedAction,
  AgentProvider,
  AuthSessionStatus,
  QuotaLimitState,
  QuotaWindowKind,
  type AccountObservation,
} from "@vioxen/agent-account-observability";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerAccountCapacityStore,
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
  WorkerAccountCapacityResolveStatus,
} from "../../worker-core";
import { recordCodexLiveQuotaCapacity } from "../application/codex-live-quota-capacity";

const checkedAt = new Date("2026-07-12T10:00:00.000Z");

describe("recordCodexLiveQuotaCapacity", () => {
  it("persists an exact account-wide cooldown from live quota evidence", () => {
    const resetAt = new Date("2026-07-15T19:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: observation({ resetAt }),
        store,
      }),
    ).toBe(true);

    expect(store.read({ accountId: "account-a", now: checkedAt })).toMatchObject({
      availability: "quota_exhausted",
      reason: "quota_limited",
      cooldownUntil: resetAt,
      lastLimitSignalAt: checkedAt,
      details: {
        accountId: "account-a",
        provider: "codex",
        capacitySource: "codex_app_server_live_quota",
        quotaReason: "weekly_limit",
        quotaPlanType: "pro",
        quotaWindowKinds: "seven_day",
        quotaLimitIds: "weekly",
        quotaReachedTypes: "weekly_limit",
      },
    });
  });

  it("does not create a permanent blocker without a future exact reset", () => {
    const store = new InMemoryWorkerAccountCapacityStore();

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: observation({}),
        store,
      }),
    ).toBe(false);
    expect(store.read({ accountId: "account-a", now: checkedAt })).toBeNull();
  });

  it("CAS-resolves an earlier provider reset as available", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "account-a",
      observedAt: new Date("2026-07-12T09:00:00.000Z"),
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
      },
    });

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: availableObservation(),
        store,
      }),
    ).toBe(true);
    expect(store.read({ accountId: "account-a", now: checkedAt })).toBeNull();
  });

  it("does not clear canonical quota without observed account identity", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    const canonicalAccountId = `codex-provider:${"a".repeat(64)}`;
    store.observe({
      accountId: canonicalAccountId,
      observedAt: new Date("2026-07-12T09:00:00.000Z"),
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
      },
    });

    expect(recordCodexLiveQuotaCapacity({
      accountId: canonicalAccountId,
      observation: availableObservation(),
      store,
    })).toBe(false);
    expect(store.read({ accountId: canonicalAccountId, now: checkedAt })).toMatchObject({
      reason: "quota_limited",
    });
  });

  it("clears canonical quota when the inspected auth verifies the alias", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    const canonicalAccountId = `codex-provider:${"a".repeat(64)}`;
    store.observe({
      accountId: canonicalAccountId,
      demand: {
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      },
      observedAt: new Date("2026-07-12T09:00:00.000Z"),
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
      },
    });

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: canonicalAccountId,
        verifiedCapacityAccountId: canonicalAccountId,
        observation: availableObservation(),
        store,
      }),
    ).toBe(true);
    expect(
      store.read({ accountId: canonicalAccountId, now: checkedAt }),
    ).toBeNull();
  });

  it("clears every stale quota demand after an available live check", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    for (const serviceTier of ["fast", "default"] as const) {
      store.observe({
        accountId: "account-a",
        demand: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          serviceTier,
        },
        observedAt: new Date("2026-07-12T09:00:00.000Z"),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        },
      });
    }

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: availableObservation(),
        store,
      }),
    ).toBe(true);
    expect(store.read({ accountId: "account-a", now: checkedAt })).toBeNull();
  });

  it("does not clear a quota signal newer than the available observation", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    const newerSignalAt = new Date("2026-07-12T10:01:00.000Z");
    store.observe({
      accountId: "account-a",
      observedAt: newerSignalAt,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-07-12T12:00:00.000Z"),
        lastLimitSignalAt: newerSignalAt,
      },
    });

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: availableObservation(),
        store,
      }),
    ).toBe(false);
    expect(store.read({ accountId: "account-a", now: newerSignalAt })).toMatchObject({
      availability: "quota_exhausted",
      reason: "quota_limited",
    });
  });

  it("lets newer authoritative live quota shorten a previous reset", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    recordCodexLiveQuotaCapacity({
      accountId: "account-a",
      observation: observation({
        resetAt: new Date("2026-07-15T19:00:00.000Z"),
      }),
      store,
    });
    const earlierReset = new Date("2026-07-14T19:00:00.000Z");

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: observation({ resetAt: earlierReset }),
        store,
      }),
    ).toBe(true);
    expect(store.read({ accountId: "account-a", now: checkedAt })).toMatchObject({
      cooldownUntil: earlierReset,
    });
  });

  it("keeps fresh live quota when another recheck already owns the claim", () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "account-a",
      observedAt: new Date("2026-07-12T09:00:00.000Z"),
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: checkedAt,
      },
    });
    const state = store.readState({ accountId: "account-a", now: checkedAt })!;
    const claimed = store.tryClaimRecheck({
      state,
      ownerId: "worker-a",
      now: checkedAt,
      ttlMs: 30_000,
      mode: WorkerAccountCapacityRecheckMode.DueOnly,
    });
    expect(claimed.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
    const freshReset = new Date("2026-07-15T19:00:00.000Z");

    expect(
      recordCodexLiveQuotaCapacity({
        accountId: "account-a",
        observation: observation({ resetAt: freshReset }),
        store,
      }),
    ).toBe(true);
    const stale = store.resolveRecheck({
      claim: claimed.status === WorkerAccountCapacityClaimStatus.Claimed
        ? claimed.claim
        : (() => { throw new Error("claim expected"); })(),
      observedAt: checkedAt,
      resolution: { type: WorkerAccountCapacityResolutionType.Available },
    });
    expect(stale.status).toBe(WorkerAccountCapacityResolveStatus.StaleClaim);
    expect(store.read({ accountId: "account-a", now: checkedAt })).toMatchObject({
      cooldownUntil: freshReset,
    });
  });
});

function availableObservation(): AccountObservation {
  const base = observation({});
  return {
    ...base,
    quota: {
      ...base.quota!,
      windows: base.quota!.windows.map((window) => ({
        ...window,
        state: QuotaLimitState.Clear,
      })),
    },
    decision: {
      availability: AccountAvailability.Available,
      recommendedAction: AccountRecommendedAction.None,
      schedulerEligible: true,
    },
  };
}

function observation(input: { readonly resetAt?: Date }): AccountObservation {
  return {
    account: {
      provider: AgentProvider.Codex,
      slotId: "account-a",
      authHome: "/tmp/account-a",
    },
    auth: {
      status: AuthSessionStatus.Authenticated,
      checkedAt,
    },
    quota: {
      provider: AgentProvider.Codex,
      checkedAt,
      planType: "pro",
      windows: [
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "weekly",
          state: QuotaLimitState.Limited,
          reachedType: "weekly_limit",
          ...(input.resetAt ? { resetsAt: input.resetAt } : {}),
        },
      ],
    },
    decision: {
      availability: AccountAvailability.Limited,
      recommendedAction: AccountRecommendedAction.Wait,
      schedulerEligible: false,
      reason: "weekly_limit",
      ...(input.resetAt ? { limitResetAt: input.resetAt } : {}),
    },
    evidence: [],
    checkedAt,
  };
}
