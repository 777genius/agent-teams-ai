import { ObservationPolicy } from "../domain/ObservationPolicy";
import type { AccountObservation, AccountSlot } from "../domain/model";
import type {
  AccountObservationLockPort,
  AgentAccountObserverPort,
  ObservationCachePort,
  ObservationClock,
} from "./ports";

export class ObserveAgentAccountUseCase {
  private readonly policy = new ObservationPolicy();

  constructor(
    private readonly dependencies: {
      readonly observer: AgentAccountObserverPort;
      readonly clock?: ObservationClock;
      readonly cache?: ObservationCachePort;
      readonly lock?: AccountObservationLockPort;
      readonly cacheTtlMs?: number;
    },
  ) {}

  async execute(input: {
    readonly account: AccountSlot;
    readonly timeoutMs?: number;
    readonly useCache?: boolean;
  }): Promise<AccountObservation> {
    const now = this.dependencies.clock?.now() ?? new Date();
    const cacheKey = accountCacheKey(input.account);
    if (input.useCache ?? true) {
      const cached = await this.dependencies.cache?.get({ key: cacheKey, now });
      if (cached) return cached;
    }

    const observe = async () => {
      const observation = await this.dependencies.observer.observe({
        account: input.account,
        now,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      await this.dependencies.cache?.set({
        key: cacheKey,
        observation,
        ttlMs: this.dependencies.cacheTtlMs ?? 30_000,
      });
      return {
        ...observation,
        decision: this.policy.decide({
          auth: observation.auth,
          quota: observation.quota,
          probeDecision: observation.decision,
        }),
      };
    };

    return this.dependencies.lock
      ? this.dependencies.lock.withAccountLock(cacheKey, observe)
      : observe();
  }
}

export function accountCacheKey(account: AccountSlot): string {
  return [
    account.provider,
    account.providerAccountId ?? account.email ?? account.slotId,
  ].join(":");
}
