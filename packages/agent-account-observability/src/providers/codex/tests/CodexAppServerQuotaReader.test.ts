import { describe, expect, it } from "vitest";
import {
  AgentProvider,
  AuthSessionStatus,
  QuotaLimitState,
  QuotaWindowKind,
} from "../../../domain/enums";
import {
  CodexAppServerQuotaReader,
  codexMainQuotaSummary,
} from "../CodexAppServerQuotaReader";
import type {
  CodexAccountSlot,
  CodexAppServerClientFactoryPort,
  CodexAppServerClientPort,
} from "../codexTypes";

const now = new Date("2026-07-09T10:00:00.000Z");
const account: CodexAccountSlot = {
  provider: AgentProvider.Codex,
  slotId: "account-a",
  authHome: "/tmp/account-a",
  email: "operator@example.com",
};

describe("CodexAppServerQuotaReader", () => {
  it("maps app-server account and multi-bucket rate limits", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": {
          account: {
            id: "chatgpt-account-a",
            email: "operator@example.com",
          },
        },
        "account/rateLimits/read": {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: 1783602000,
              rateLimitReachedType: "five_hour_limit",
            },
            weekly: {
              limitId: "weekly",
              usedPercent: 41,
              windowDurationMins: 10080,
              resetsAt: 1783861200,
            },
          },
          rateLimitResetCredits: { available: 1 },
        },
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.auth).toMatchObject({
      status: AuthSessionStatus.Authenticated,
      identity: {
        safeIdentity: "op***@ex***",
        providerAccountId: "chatgpt-account-a",
      },
    });
    expect(result.quota).toMatchObject({
      provider: AgentProvider.Codex,
      windows: [
        {
          kind: QuotaWindowKind.FiveHour,
          limitId: "codex",
          usedPercent: 100,
          state: QuotaLimitState.Limited,
          reachedType: "five_hour_limit",
        },
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "weekly",
          usedPercent: 41,
          state: QuotaLimitState.Clear,
        },
      ],
    });
    expect(result.evidence.map((item) => item.source)).toEqual([
      "codex_app_server",
      "codex_app_server",
    ]);
    expect(codexMainQuotaSummary(result.quota)).toMatchObject({
      fiveHour: { limitId: "codex" },
      sevenDay: { limitId: "weekly" },
    });
  });

  it("classifies revoked refresh token errors as relogin required", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": new Error("refresh token was revoked"),
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.auth).toMatchObject({
      status: AuthSessionStatus.ReloginRequired,
      reason: "refresh_token_revoked",
    });
    expect(result.quota).toBeNull();
  });

  it("maps current app-server primary and secondary rate limit buckets", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": {
          account: {
            email: "operator@example.com",
          },
        },
        "account/rateLimits/read": {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 300,
              resetsAt: 1783611003,
            },
            secondary: {
              usedPercent: 83,
              windowDurationMins: 10080,
              resetsAt: 1784125535,
            },
            planType: "pro",
            rateLimitReachedType: "rate_limit_reached",
          },
          rateLimitsByLimitId: {
            codex_bengalfox: {
              limitId: "codex_bengalfox",
              limitName: "GPT-5.3-Codex-Spark",
              primary: {
                usedPercent: 0,
                windowDurationMins: 300,
                resetsAt: 1783619797,
              },
              secondary: {
                usedPercent: 0,
                windowDurationMins: 10080,
                resetsAt: 1783607140,
              },
              planType: "pro",
            },
          },
        },
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.quota).toMatchObject({
      planType: "pro",
      windows: [
        {
          kind: QuotaWindowKind.FiveHour,
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          usedPercent: 0,
          state: QuotaLimitState.Clear,
        },
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          usedPercent: 0,
          state: QuotaLimitState.Clear,
        },
        {
          kind: QuotaWindowKind.FiveHour,
          limitId: "codex",
          usedPercent: 99,
          state: QuotaLimitState.Clear,
        },
        {
          kind: QuotaWindowKind.SevenDay,
          limitId: "codex",
          usedPercent: 83,
          state: QuotaLimitState.Clear,
        },
      ],
    });
    expect(codexMainQuotaSummary(result.quota)).toMatchObject({
      fiveHour: {
        limitId: "codex",
        usedPercent: 99,
      },
      sevenDay: {
        limitId: "codex",
        usedPercent: 83,
      },
    });
  });

  it("classifies token_invalidated rate limit errors as relogin required", async () => {
    const reader = new CodexAppServerQuotaReader({
      clientFactory: fakeFactory({
        "account/read": {
          account: {
            email: "operator@example.com",
          },
        },
        "account/rateLimits/read": new Error(
          "failed to fetch codex rate limits: token_invalidated Your authentication token has been invalidated",
        ),
      }),
    });

    const result = await reader.readAuthAndQuota({ account, now });

    expect(result.auth).toMatchObject({
      status: AuthSessionStatus.ReloginRequired,
      reason: "refresh_token_revoked",
    });
    expect(result.quota).toBeNull();
  });
});

function fakeFactory(
  responses: Readonly<Record<string, unknown>>,
): CodexAppServerClientFactoryPort {
  return {
    async open() {
      return {
        async call(input) {
          const response = responses[input.method];
          if (response instanceof Error) throw response;
          return response ?? {};
        },
        async close() {},
      } satisfies CodexAppServerClientPort;
    },
  };
}
