import type { AccountObservation } from "../domain/model";
import type { ObservationCachePort } from "../application/ports";

export class InMemoryObservationCache implements ObservationCachePort {
  private readonly entries = new Map<
    string,
    { readonly expiresAt: number; readonly observation: AccountObservation }
  >();

  async get(input: {
    readonly key: string;
    readonly now: Date;
  }): Promise<AccountObservation | null> {
    const entry = this.entries.get(input.key);
    if (!entry) return null;
    if (entry.expiresAt <= input.now.getTime()) {
      this.entries.delete(input.key);
      return null;
    }
    return entry.observation;
  }

  async set(input: {
    readonly key: string;
    readonly observation: AccountObservation;
    readonly ttlMs: number;
  }): Promise<void> {
    this.entries.set(input.key, {
      observation: input.observation,
      expiresAt: input.observation.checkedAt.getTime() + input.ttlMs,
    });
  }
}
