import { dirname } from "node:path";
import {
  AccountAvailability,
  AgentProvider,
  CodexAccountObserver,
  CodexAppServerClientFactory,
  CodexAppServerQuotaReader,
  CodexAuthJsonReader,
} from "@vioxen/agent-account-observability";
import type {
  WorkerAccountCapacityStore,
  WorkerAccountCapacityRechecker,
  WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  WorkerAccountCapacityClaimStatus,
  WorkerAccountCapacityPhase,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType,
} from "@vioxen/subscription-runtime/worker-core";
import { codexLiveQuotaCapacitySnapshot } from "./codex-live-quota-capacity";
import { codexCapacityAccountIdFromIdentity } from "./codex-account-capacity-alias-store";

export type CodexAccountCapacityRecheckerOptions = {
  readonly accountId: string;
  readonly authJsonPath: string;
  readonly codexBinaryPath: string;
  readonly timeoutMs?: number;
  readonly inconclusiveCooldownMs?: number;
  readonly appServerLaunchMinIntervalMs?: number;
};

export class CodexAccountCapacityRechecker
  implements WorkerAccountCapacityRechecker
{
  private readonly observer: CodexAccountObserver;

  constructor(
    private readonly options: CodexAccountCapacityRecheckerOptions,
  ) {
    this.observer = new CodexAccountObserver({
      appServerReader: new CodexAppServerQuotaReader({
        clientFactory: new CodexAppServerClientFactory({
          codexBinaryPath: options.codexBinaryPath,
          ...(options.timeoutMs ? { requestTimeoutMs: options.timeoutMs } : {}),
          ...(options.timeoutMs ? { startupTimeoutMs: options.timeoutMs } : {}),
          ...(options.appServerLaunchMinIntervalMs === undefined
            ? {}
            : {
                appServerLaunchMinIntervalMs:
                  options.appServerLaunchMinIntervalMs,
              }),
        }),
      }),
      authReader: new CodexAuthJsonReader(),
    });
  }

  async recheck(input: {
    readonly accountId: string;
    readonly now: Date;
  }): Promise<WorkerCapacitySnapshot> {
    const observation = await this.observer.observe({
      account: {
        provider: AgentProvider.Codex,
        slotId: input.accountId,
        authHome: dirname(this.options.authJsonPath),
        authJsonPath: this.options.authJsonPath,
        codexBinaryPath: this.options.codexBinaryPath,
      },
      now: input.now,
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    const observedAccountId = codexCapacityAccountIdFromIdentity(
      observation.auth.identity,
      input.accountId,
    );
    if (
      input.accountId.startsWith("codex-provider:") &&
      (!observation.auth.identity?.accountKeyHash ||
        observedAccountId !== input.accountId)
    ) {
      return {
        availability: "cooldown",
        reason: "quota_recheck_identity_changed",
        cooldownUntil: new Date(
          input.now.getTime() +
            (this.options.inconclusiveCooldownMs ?? 60_000),
        ),
        lastLimitSignalAt: input.now,
        details: {
          accountId: input.accountId,
          provider: AgentProvider.Codex,
          capacitySource: "codex_app_server_live_quota",
        },
      };
    }
    const limited = codexLiveQuotaCapacitySnapshot(observation);
    if (limited) return limited;
    if (observation.decision.availability === AccountAvailability.Available) {
      return {
        availability: "available",
        details: {
          accountId: observedAccountId,
          provider: AgentProvider.Codex,
          capacitySource: "codex_app_server_live_quota",
        },
      };
    }
    return {
      availability: "cooldown",
      reason: "quota_recheck_inconclusive",
      cooldownUntil: new Date(
        input.now.getTime() +
          (this.options.inconclusiveCooldownMs ?? 60_000),
      ),
      lastLimitSignalAt: input.now,
      details: {
        accountId: observedAccountId,
        provider: AgentProvider.Codex,
        capacitySource: "codex_app_server_live_quota",
        observedAvailability: observation.decision.availability,
      },
    };
  }
}

export async function recheckDueCodexAccountCapacity(input: {
  readonly store: WorkerAccountCapacityStore;
  readonly accountId: string;
  readonly authJsonPath: string;
  readonly codexBinaryPath: string;
  readonly now: Date;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const state = input.store.readState({
    accountId: input.accountId,
    now: input.now,
  });
  if (state?.phase !== WorkerAccountCapacityPhase.RecheckDue) return false;
  const claimed = input.store.tryClaimRecheck({
    state,
    ownerId: `codex-account-selection:${input.accountId}`,
    now: input.now,
    ttlMs: 5 * 60_000,
    mode: WorkerAccountCapacityRecheckMode.DueOnly,
  });
  if (claimed.status !== WorkerAccountCapacityClaimStatus.Claimed) return false;
  try {
    const capacity = await new CodexAccountCapacityRechecker({
      accountId: input.accountId,
      authJsonPath: input.authJsonPath,
      codexBinaryPath: input.codexBinaryPath,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    }).recheck({ accountId: input.accountId, now: input.now });
    input.store.resolveRecheck({
      claim: claimed.claim,
      observedAt: new Date(),
      resolution: capacity.availability === "available"
        ? { type: WorkerAccountCapacityResolutionType.Available }
        : {
            type: WorkerAccountCapacityResolutionType.Limited,
            capacity,
          },
    });
    return true;
  } catch {
    input.store.resolveRecheck({
      claim: claimed.claim,
      observedAt: new Date(),
      resolution: {
        type: WorkerAccountCapacityResolutionType.Retry,
        retryAt: new Date(Date.now() + 60_000),
        reason: "quota_recheck_failed",
      },
    });
    return false;
  }
}
