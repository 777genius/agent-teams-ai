import { describe, expect, it } from "vitest";
import {
  AccountAvailability,
  AgentProvider,
  AuthSessionStatus,
  QuotaLimitState,
  QuotaWindowKind,
} from "../../../domain/enums";
import { CodexAccountObserver } from "../CodexAccountObserver";
import type { CodexAppServerQuotaReader } from "../CodexAppServerQuotaReader";
import type { CodexAccountSlot } from "../codexTypes";

const now = new Date("2026-07-09T10:00:00.000Z");
const account: CodexAccountSlot = {
  provider: AgentProvider.Codex,
  slotId: "account-a",
  authHome: "/tmp/account-a",
};

describe("CodexAccountObserver", () => {
  it("uses exec fallback when app-server quota observation fails", async () => {
    const observer = new CodexAccountObserver({
      appServerReader: {
        async readAuthAndQuota() {
          throw new Error("codex app-server unavailable");
        },
      } as unknown as CodexAppServerQuotaReader,
      authReader: {
        async readAuthSession() {
          return {
            status: AuthSessionStatus.Authenticated,
            checkedAt: now,
          };
        },
      },
      execProbe: {
        async probe() {
          return {
            availability: AccountAvailability.Available,
            recommendedAction: "none",
            schedulerEligible: true,
          };
        },
      },
    });

    const result = await observer.observe({ account, now });

    expect(result.decision).toMatchObject({
      availability: AccountAvailability.Available,
      recommendedAction: "none",
      schedulerEligible: true,
    });
    expect(result.evidence.map((item) => item.source)).toEqual([
      "codex_app_server",
      "codex_auth_json",
      "codex_exec_probe",
    ]);
  });

  it("does not claim availability when app-server fails and fallback is absent", async () => {
    const observer = new CodexAccountObserver({
      appServerReader: {
        async readAuthAndQuota() {
          throw new Error("codex app-server unavailable");
        },
      } as unknown as CodexAppServerQuotaReader,
      authReader: {
        async readAuthSession() {
          return {
            status: AuthSessionStatus.Authenticated,
            checkedAt: now,
          };
        },
      },
    });

    const result = await observer.observe({ account, now });

    expect(result.decision).toMatchObject({
      availability: AccountAvailability.Unknown,
      recommendedAction: "inspect",
      schedulerEligible: false,
      reason: "quota_observation_failed",
    });
  });

  it("bases Codex availability on the main codex quota, not model buckets", async () => {
    const observer = new CodexAccountObserver({
      appServerReader: {
        async readAuthAndQuota() {
          return {
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
                  limitId: "codex",
                  usedPercent: 12,
                  state: QuotaLimitState.Clear,
                },
                {
                  kind: QuotaWindowKind.SevenDay,
                  limitId: "codex",
                  usedPercent: 34,
                  state: QuotaLimitState.Clear,
                },
                {
                  kind: QuotaWindowKind.FiveHour,
                  limitId: "codex_bengalfox",
                  limitName: "GPT-5.3-Codex-Spark",
                  usedPercent: 100,
                  state: QuotaLimitState.Limited,
                },
              ],
            },
            evidence: [],
          };
        },
      } as unknown as CodexAppServerQuotaReader,
    });

    const result = await observer.observe({ account, now });

    expect(result.decision).toMatchObject({
      availability: AccountAvailability.Available,
      recommendedAction: "none",
      schedulerEligible: true,
    });
  });

  it("includes a separate weekly bucket in the main Codex availability", async () => {
    const weeklyReset = new Date("2026-07-12T19:00:00.000Z");
    const observer = new CodexAccountObserver({
      appServerReader: {
        async readAuthAndQuota() {
          return {
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
                  limitId: "codex",
                  state: QuotaLimitState.Clear,
                },
                {
                  kind: QuotaWindowKind.SevenDay,
                  limitId: "weekly",
                  state: QuotaLimitState.Limited,
                  resetsAt: weeklyReset,
                  reachedType: "weekly_limit",
                },
                {
                  kind: QuotaWindowKind.FiveHour,
                  limitId: "codex_bengalfox",
                  limitName: "GPT-5.3-Codex-Spark",
                  state: QuotaLimitState.Limited,
                },
              ],
            },
            evidence: [],
          };
        },
      } as unknown as CodexAppServerQuotaReader,
    });

    const result = await observer.observe({ account, now });

    expect(result.decision).toMatchObject({
      availability: AccountAvailability.Limited,
      schedulerEligible: false,
      reason: "weekly_limit",
      limitResetAt: weeklyReset,
    });
  });
});
