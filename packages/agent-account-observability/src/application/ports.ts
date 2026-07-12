import type {
  AccountObservation,
  AccountSlot,
  AuthSession,
  AvailabilityDecision,
  QuotaSnapshot,
} from "../domain/model";

export interface AgentAccountObserverPort {
  observe(input: {
    readonly account: AccountSlot;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<AccountObservation>;
}

export interface AccountInventoryPort {
  listAccounts(input?: {
    readonly provider?: AccountSlot["provider"];
  }): Promise<readonly AccountSlot[]>;
}

export interface AuthSessionReaderPort {
  readAuthSession(input: {
    readonly account: AccountSlot;
    readonly now: Date;
  }): Promise<AuthSession>;
}

export interface QuotaSnapshotReaderPort {
  readQuotaSnapshot(input: {
    readonly account: AccountSlot;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<QuotaSnapshot | null>;
}

export interface AccountProbePort {
  probe(input: {
    readonly account: AccountSlot;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<AvailabilityDecision>;
}

export interface ObservationClock {
  now(): Date;
}

export interface ObservationCachePort {
  get(input: { readonly key: string; readonly now: Date }): Promise<AccountObservation | null>;
  set(input: {
    readonly key: string;
    readonly observation: AccountObservation;
    readonly ttlMs: number;
  }): Promise<void>;
}

export interface AccountObservationLockPort {
  withAccountLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}
