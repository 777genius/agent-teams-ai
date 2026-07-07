export type ProviderAccountProviderId = "codex" | "claude";

export type ProviderAccountAvailability =
  | "available"
  | "limited"
  | "reconnect_required"
  | "auth_unknown"
  | "unhealthy"
  | "unknown";

export type ProviderAccountAction = "none" | "wait" | "relogin" | "inspect";

export type ProviderAccountDiagnosticSource =
  | "cached"
  | "health"
  | "live_probe";

export type ProviderAccountProbeMode =
  | "cached"
  | "health"
  | "live_probe";

export type ProviderAccountInventoryItem<
  Provider extends ProviderAccountProviderId = ProviderAccountProviderId,
> = {
  readonly provider: Provider;
  readonly slotId: string;
  readonly providerInstanceId?: string;
  readonly capacityAccountId?: string;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ProviderAccountIdentity = {
  readonly safeIdentity: string;
  readonly accountKeyHash?: string;
  readonly providerAccountId?: string;
  readonly warnings?: readonly string[];
  readonly details?: Readonly<Record<string, string>>;
};

export type ProviderAccountDiagnosticSignal = {
  readonly availability: ProviderAccountAvailability;
  readonly source: ProviderAccountDiagnosticSource;
  readonly reason?: string;
  readonly limitResetAt?: Date;
  readonly rawResetText?: string;
  readonly reconnectRequired?: boolean;
  readonly checkedAt?: Date;
  readonly details?: Readonly<Record<string, string>>;
};

export type ProviderAccountIdentityReadResult = {
  readonly identity: ProviderAccountIdentity;
  readonly signal?: ProviderAccountDiagnosticSignal;
};

export type ProviderAccountDiagnostic = {
  readonly provider: ProviderAccountProviderId;
  readonly slotId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly shortName?: string;
  readonly operatorLabel?: string;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly safeIdentity: string;
  readonly accountKeyHash?: string;
  readonly availability: ProviderAccountAvailability;
  readonly reason?: string;
  readonly limitResetAt?: Date;
  readonly rawResetText?: string;
  readonly reconnectRequired: boolean;
  readonly recommendedAction: ProviderAccountAction;
  readonly source: ProviderAccountDiagnosticSource;
  readonly checkedAt: Date;
  readonly schedulerEligible: boolean;
  readonly capacitySharedWithSlotIds?: readonly string[];
  readonly warnings?: readonly string[];
  readonly details?: Readonly<Record<string, string>>;
};

export type ListProviderAccountDiagnosticsResult = {
  readonly checkedAt: Date;
  readonly diagnostics: readonly ProviderAccountDiagnostic[];
  readonly summary?: import("./pool-availability").ProviderAccountPoolAvailabilitySummary;
};

export interface ProviderAccountRegistryPort<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
> {
  listAccounts(input?: {
    readonly provider?: ProviderAccountProviderId;
  }): Promise<readonly Account[]>;
}

export interface ProviderAccountIdentityReaderPort<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
> {
  readIdentity(input: {
    readonly account: Account;
    readonly now: Date;
  }): Promise<ProviderAccountIdentityReadResult>;
}

export interface ProviderAccountCapacityReaderPort<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
> {
  readCapacity(input: {
    readonly account: Account;
    readonly identity: ProviderAccountIdentity;
    readonly now: Date;
  }): Promise<ProviderAccountDiagnosticSignal | null>;
}

export interface ProviderAccountHealthProbePort<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
> {
  probeAccount(input: {
    readonly account: Account;
    readonly identity: ProviderAccountIdentity;
    readonly mode: Exclude<ProviderAccountProbeMode, "cached">;
    readonly now: Date;
    readonly timeoutMs?: number;
  }): Promise<ProviderAccountDiagnosticSignal>;
}

export type AccountDiagnosticClock = {
  now(): Date;
};

export type ListProviderAccountDiagnosticsOptions = {
  readonly provider?: ProviderAccountProviderId;
  readonly probeMode?: ProviderAccountProbeMode;
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly only?: readonly ProviderAccountAvailability[];
};

export type ListProviderAccountDiagnosticsDependencies<
  Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem,
> = {
  readonly registry: ProviderAccountRegistryPort<Account>;
  readonly identityReader: ProviderAccountIdentityReaderPort<Account>;
  readonly capacityReader?: ProviderAccountCapacityReaderPort<Account>;
  readonly healthProbe?: ProviderAccountHealthProbePort<Account>;
  readonly clock?: AccountDiagnosticClock;
};
