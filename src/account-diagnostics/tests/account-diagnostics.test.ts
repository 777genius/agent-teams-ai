import { describe, expect, it } from "vitest";
import { InMemoryWorkerAccountCapacityStore } from "../../worker-core";
import {
  ListProviderAccountDiagnostics,
  createWorkerAccountCapacityReader,
  hashProviderAccountKey,
  parseLimitResetFromText,
  type ListProviderAccountDiagnosticsDependencies,
  type ProviderAccountDiagnosticSignal,
  type ProviderAccountIdentity,
  type ProviderAccountInventoryItem,
} from "../index";

describe("ListProviderAccountDiagnostics", () => {
  it("does not probe accounts in cached mode", async () => {
    const account = testAccount("account-a");
    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [account],
        identities: {
          "account-a": {
            safeIdentity: "codex:account-a",
          },
        },
        probeThrows: true,
      }),
    ).execute();

    expect(result.diagnostics).toMatchObject([
      {
        provider: "codex",
        slotId: "account-a",
        availability: "available",
        source: "cached",
        recommendedAction: "none",
        schedulerEligible: true,
      },
    ]);
  });

  it("lets a live probe override a stale cached capacity limit", async () => {
    const account = testAccount("account-a", "codex-account-a");
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "codex-account-a",
      observedAt: fixedNow,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date("2026-06-01T02:00:00.000Z"),
      },
    });

    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [account],
        identities: {
          "account-a": {
            safeIdentity: "codex:account-a",
            providerAccountId: "codex-account-a",
          },
        },
        capacityReader: createWorkerAccountCapacityReader({ store }),
        probeSignal: {
          availability: "available",
          source: "live_probe",
          checkedAt: fixedNow,
        },
      }),
    ).execute({ probeMode: "live_probe" });

    expect(result.diagnostics[0]).toMatchObject({
      availability: "available",
      source: "live_probe",
      recommendedAction: "none",
      schedulerEligible: true,
    });
  });

  it("marks slots that share the same provider account hash", async () => {
    const accountKeyHash = hashProviderAccountKey({
      provider: "codex",
      accountKey: "shared-account",
    });
    if (!accountKeyHash) throw new Error("account hash expected");
    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [testAccount("account-a"), testAccount("account-b")],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
            accountKeyHash,
            providerAccountId: "shared-account",
          },
          "account-b": {
            safeIdentity: "codex:b",
            accountKeyHash,
            providerAccountId: "shared-account",
          },
        },
      }),
    ).execute();

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        slotId: "account-a",
        capacitySharedWithSlotIds: ["account-b"],
      }),
      expect.objectContaining({
        slotId: "account-b",
        capacitySharedWithSlotIds: ["account-a"],
      }),
    ]);
  });

  it("deduplicates live probes for slots sharing the same provider account", async () => {
    const accountKeyHash = hashProviderAccountKey({
      provider: "codex",
      accountKey: "shared-account",
    });
    if (!accountKeyHash) throw new Error("account hash expected");
    let probeCalls = 0;

    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [testAccount("account-a"), testAccount("account-b")],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
            accountKeyHash,
            providerAccountId: "shared-account",
          },
          "account-b": {
            safeIdentity: "codex:b",
            accountKeyHash,
            providerAccountId: "shared-account",
          },
        },
        probe: async () => {
          probeCalls += 1;
          return {
            availability: "limited",
            source: "live_probe",
            reason: "quota_limited",
            checkedAt: fixedNow,
          };
        },
      }),
    ).execute({ probeMode: "live_probe", maxConcurrency: 2 });

    expect(probeCalls).toBe(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        slotId: "account-a",
        availability: "limited",
        capacitySharedWithSlotIds: ["account-b"],
      }),
      expect.objectContaining({
        slotId: "account-b",
        availability: "limited",
        capacitySharedWithSlotIds: ["account-a"],
      }),
    ]);
  });

  it("keeps diagnostics usable when a probe throws", async () => {
    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [testAccount("account-a")],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
          },
        },
        probeThrows: true,
      }),
    ).execute({ probeMode: "live_probe" });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        availability: "unhealthy",
        reason: "probe_failed",
        source: "live_probe",
        recommendedAction: "inspect",
        schedulerEligible: false,
      }),
    ]);
  });

  it("filters by requested availability", async () => {
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "codex-account-b",
      observedAt: fixedNow,
      capacity: {
        availability: "cooldown",
        reason: "rate_limit_threshold",
      },
    });

    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [
          testAccount("account-a", "codex-account-a"),
          testAccount("account-b", "codex-account-b"),
        ],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
            providerAccountId: "codex-account-a",
          },
          "account-b": {
            safeIdentity: "codex:b",
            providerAccountId: "codex-account-b",
          },
        },
        capacityReader: createWorkerAccountCapacityReader({ store }),
      }),
    ).execute({ only: ["limited"] });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        slotId: "account-b",
        availability: "limited",
        recommendedAction: "wait",
        schedulerEligible: false,
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("codex-account-b");
  });

  it("preserves operator display metadata separately from stable slot ids", async () => {
    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [
          {
            ...testAccount("account-a", "codex-account-a"),
            metadata: {
              displayName: "operator@example.com",
              email: "operator@example.com",
              shortName: "a",
              operatorLabel: "operator@example.com - a",
            },
          },
        ],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
            providerAccountId: "codex-account-a",
          },
        },
      }),
    ).execute();

    expect(result.diagnostics[0]).toMatchObject({
      slotId: "account-a",
      displayName: "operator@example.com",
      email: "operator@example.com",
      shortName: "a",
      operatorLabel: "operator@example.com - a",
    });
  });

  it("prefers auth_unknown over cached limits because wait would be misleading", async () => {
    const account = testAccount("account-a", "codex-account-a");
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "codex-account-a",
      observedAt: fixedNow,
      capacity: {
        availability: "quota_exhausted",
        reason: "quota_limited",
      },
    });

    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [account],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
            providerAccountId: "codex-account-a",
          },
        },
        identitySignals: {
          "account-a": {
            availability: "auth_unknown",
            source: "cached",
            reason: "auth_json_missing",
          },
        },
        capacityReader: createWorkerAccountCapacityReader({ store }),
      }),
    ).execute();

    expect(result.diagnostics[0]).toMatchObject({
      availability: "auth_unknown",
      recommendedAction: "inspect",
    });
  });

  it("sanitizes cached capacity details before returning diagnostics", async () => {
    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [testAccount("account-a")],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
          },
        },
        capacityReader: {
          async readCapacity() {
            return {
              availability: "limited",
              source: "cached",
              reason: "quota_limited",
              details: {
                sourceWorkerId: "worker-a",
                note: "cooldown propagated",
                accountId: "raw-account-id",
                email: "person@example.com",
                tokenPreview: "refresh-token-secret",
              },
            };
          },
        },
      }),
    ).execute();

    expect(result.diagnostics[0]?.details).toEqual({
      sourceWorkerId: "worker-a",
      note: "cooldown propagated",
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("raw-account-id");
    expect(JSON.stringify(result.diagnostics)).not.toContain("person@example.com");
    expect(JSON.stringify(result.diagnostics)).not.toContain("refresh-token-secret");
  });

  it("summarizes scheduler availability without provider-specific coupling", async () => {
    const resetAt = new Date("2026-06-01T02:00:00.000Z");
    const store = new InMemoryWorkerAccountCapacityStore();
    store.observe({
      accountId: "codex-account-b",
      observedAt: fixedNow,
      capacity: {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil: resetAt,
      },
    });

    const result = await new ListProviderAccountDiagnostics(
      fakeDependencies({
        accounts: [
          testAccount("account-a", "codex-account-a"),
          testAccount("account-b", "codex-account-b"),
          testAccount("account-c", "codex-account-c"),
        ],
        identities: {
          "account-a": {
            safeIdentity: "codex:a",
            providerAccountId: "codex-account-a",
          },
          "account-b": {
            safeIdentity: "codex:b",
            providerAccountId: "codex-account-b",
          },
          "account-c": {
            safeIdentity: "codex:c",
            providerAccountId: "codex-account-c",
          },
        },
        identitySignals: {
          "account-c": {
            availability: "reconnect_required",
            source: "cached",
            reason: "refresh_token_invalidated",
          },
        },
        capacityReader: createWorkerAccountCapacityReader({ store }),
      }),
    ).execute();

    expect(result.summary).toMatchObject({
      safeToSchedule: true,
      decision: "schedule",
      recommendedAction: "schedule",
      schedulerEligibleSlotIds: ["account-a"],
      limitedSlotIds: ["account-b"],
      reconnectRequiredSlotIds: ["account-c"],
      nextAvailableAt: resetAt,
      nextAvailableSlotIds: ["account-b"],
    });
  });
});

describe("parseLimitResetFromText", () => {
  it("rolls clock-only reset text forward when the time already passed today", () => {
    const now = new Date(2026, 5, 1, 23, 0, 0, 0);
    const result = parseLimitResetFromText({
      text: "You've hit your usage limit. Try again at 2:43 AM.",
      now,
    });

    expect(result.rawResetText).toBe("2:43 AM");
    expect(result.limitResetAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(result.limitResetAt?.getDate()).not.toBe(now.getDate());
    expect(result.limitResetAt?.getHours()).toBe(2);
    expect(result.limitResetAt?.getMinutes()).toBe(43);
  });

  it("normalizes ordinal explicit reset dates", () => {
    const result = parseLimitResetFromText({
      text: "Limit resets at Jul 1st, 2026 12:57 AM.",
      now: fixedNow,
    });

    expect(result.rawResetText).toBe("Jul 1st, 2026 12:57 AM");
    expect(result.limitResetAt?.getFullYear()).toBe(2026);
    expect(result.limitResetAt?.getMonth()).toBe(6);
    expect(result.limitResetAt?.getDate()).toBe(1);
    expect(result.limitResetAt?.getMinutes()).toBe(57);
  });
});

const fixedNow = new Date("2026-06-01T00:00:00.000Z");

function testAccount(
  slotId: string,
  capacityAccountId?: string,
): ProviderAccountInventoryItem<"codex"> {
  return {
    provider: "codex",
    slotId,
    ...(capacityAccountId ? { capacityAccountId } : {}),
  };
}

function fakeDependencies(input: {
  readonly accounts: readonly ProviderAccountInventoryItem<"codex">[];
  readonly identities: Readonly<Record<string, ProviderAccountIdentity>>;
  readonly identitySignals?: Readonly<Record<string, ProviderAccountDiagnosticSignal>>;
  readonly capacityReader?: ListProviderAccountDiagnosticsDependencies<ProviderAccountInventoryItem<"codex">>["capacityReader"];
  readonly probeSignal?: ProviderAccountDiagnosticSignal;
  readonly probe?: (input: {
    readonly account: ProviderAccountInventoryItem<"codex">;
  }) => Promise<ProviderAccountDiagnosticSignal>;
  readonly probeThrows?: boolean;
}): ListProviderAccountDiagnosticsDependencies<ProviderAccountInventoryItem<"codex">> {
  return {
    registry: {
      async listAccounts() {
        return input.accounts;
      },
    },
    identityReader: {
      async readIdentity({ account }) {
        return {
          identity:
            input.identities[account.slotId] ??
            ({
              safeIdentity: `codex:${account.slotId}`,
            } satisfies ProviderAccountIdentity),
          ...(input.identitySignals?.[account.slotId]
            ? { signal: input.identitySignals[account.slotId] }
            : {}),
        };
      },
    },
    ...(input.capacityReader ? { capacityReader: input.capacityReader } : {}),
    healthProbe: {
      async probeAccount({ account }) {
        if (input.probeThrows) throw new Error("probe_called");
        if (input.probe) return input.probe({ account });
        return (
          input.probeSignal ?? {
            availability: "available",
            source: "live_probe",
            checkedAt: fixedNow,
          }
        );
      },
    },
    clock: {
      now() {
        return fixedNow;
      },
    },
  };
}
