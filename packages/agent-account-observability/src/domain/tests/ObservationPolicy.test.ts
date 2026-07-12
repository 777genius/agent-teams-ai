import { describe, expect, it } from "vitest";
import {
  AccountAvailability,
  AgentProvider,
  AuthSessionStatus,
  QuotaLimitState,
  QuotaWindowKind,
} from "../enums";
import { ObservationPolicy } from "../ObservationPolicy";

const now = new Date("2026-07-09T10:00:00.000Z");

describe("ObservationPolicy", () => {
  it("blocks scheduling when any quota window is limited", () => {
    const decision = new ObservationPolicy().decide({
      auth: {
        status: AuthSessionStatus.Authenticated,
        checkedAt: now,
      },
      quota: {
        provider: AgentProvider.Codex,
        checkedAt: now,
        windows: [
          {
            kind: QuotaWindowKind.FiveHour,
            state: QuotaLimitState.Clear,
            usedPercent: 42,
          },
          {
            kind: QuotaWindowKind.SevenDay,
            state: QuotaLimitState.Limited,
            usedPercent: 100,
            resetsAt: new Date("2026-07-12T19:00:00.000Z"),
            reachedType: "weekly_limit",
          },
        ],
      },
    });

    expect(decision).toMatchObject({
      availability: AccountAvailability.Limited,
      recommendedAction: "wait",
      schedulerEligible: false,
      reason: "weekly_limit",
      limitResetAt: new Date("2026-07-12T19:00:00.000Z"),
    });
  });

  it("blocks until the latest reset when five-hour and seven-day windows are limited", () => {
    const fiveHourReset = new Date("2026-07-09T15:00:00.000Z");
    const sevenDayReset = new Date("2026-07-12T19:00:00.000Z");
    const decision = new ObservationPolicy().decide({
      auth: {
        status: AuthSessionStatus.Authenticated,
        checkedAt: now,
      },
      quota: {
        provider: AgentProvider.Codex,
        checkedAt: now,
        windows: [
          {
            kind: QuotaWindowKind.FiveHour,
            state: QuotaLimitState.Limited,
            resetsAt: fiveHourReset,
            reachedType: "five_hour_limit",
          },
          {
            kind: QuotaWindowKind.SevenDay,
            state: QuotaLimitState.Limited,
            resetsAt: sevenDayReset,
            reachedType: "weekly_limit",
          },
        ],
      },
    });

    expect(decision).toMatchObject({
      availability: AccountAvailability.Limited,
      schedulerEligible: false,
      reason: "weekly_limit",
      limitResetAt: sevenDayReset,
    });
  });

  it("does not claim an exact recovery time when a limited window has no future reset", () => {
    const decision = new ObservationPolicy().decide({
      auth: {
        status: AuthSessionStatus.Authenticated,
        checkedAt: now,
      },
      quota: {
        provider: AgentProvider.Codex,
        checkedAt: now,
        windows: [
          {
            kind: QuotaWindowKind.FiveHour,
            state: QuotaLimitState.Limited,
            resetsAt: new Date("2026-07-09T09:59:59.000Z"),
            reachedType: "stale_five_hour_limit",
          },
          {
            kind: QuotaWindowKind.SevenDay,
            state: QuotaLimitState.Limited,
            resetsAt: new Date("2026-07-12T19:00:00.000Z"),
            reachedType: "weekly_limit",
          },
        ],
      },
    });

    expect(decision).toMatchObject({
      availability: AccountAvailability.Limited,
      schedulerEligible: false,
      reason: "stale_five_hour_limit",
    });
    expect(decision).not.toHaveProperty("limitResetAt");
  });

  it("lets relogin-required auth override quota data", () => {
    const decision = new ObservationPolicy().decide({
      auth: {
        status: AuthSessionStatus.ReloginRequired,
        checkedAt: now,
        reason: "refresh_token_revoked",
      },
      quota: {
        provider: AgentProvider.Codex,
        checkedAt: now,
        windows: [],
      },
    });

    expect(decision).toMatchObject({
      availability: AccountAvailability.ReloginRequired,
      recommendedAction: "relogin",
      schedulerEligible: false,
      reason: "refresh_token_revoked",
    });
  });

  it("does not let authenticated auth override a failed live probe", () => {
    const decision = new ObservationPolicy().decide({
      auth: {
        status: AuthSessionStatus.Authenticated,
        checkedAt: now,
      },
      quota: null,
      probeDecision: {
        availability: AccountAvailability.Unhealthy,
        recommendedAction: "inspect",
        schedulerEligible: false,
        reason: "probe_failed",
      },
    });

    expect(decision).toMatchObject({
      availability: AccountAvailability.Unhealthy,
      recommendedAction: "inspect",
      schedulerEligible: false,
      reason: "probe_failed",
    });
  });
});
