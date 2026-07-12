import {
  AccountAvailability,
  AccountRecommendedAction,
  AgentProvider,
  AuthSessionStatus,
  ObservationEvidenceConfidence,
  ObservationEvidenceKind,
  ObservationEvidenceSource,
  QuotaLimitState,
  QuotaWindowKind,
} from "./enums";

export type AccountSlot = {
  readonly provider: AgentProvider;
  readonly slotId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly shortName?: string;
  readonly operatorLabel?: string;
  readonly authHome?: string;
  readonly authJsonPath?: string;
  readonly providerAccountId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ProviderAccountIdentity = {
  readonly safeIdentity: string;
  readonly providerAccountId?: string;
  readonly accountKeyHash?: string;
  readonly email?: string;
};

export type AuthSession = {
  readonly status: AuthSessionStatus;
  readonly checkedAt: Date;
  readonly identity?: ProviderAccountIdentity;
  readonly reason?: string;
};

export type QuotaWindow = {
  readonly kind: QuotaWindowKind;
  readonly limitId?: string;
  readonly limitName?: string;
  readonly usedPercent?: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: Date;
  readonly creditsRemaining?: number;
  readonly resetCreditsAvailable?: number;
  readonly reachedType?: string;
  readonly state: QuotaLimitState;
};

export type QuotaSnapshot = {
  readonly provider: AgentProvider;
  readonly checkedAt: Date;
  readonly windows: readonly QuotaWindow[];
  readonly planType?: string;
};

export type ObservationEvidence = {
  readonly source: ObservationEvidenceSource;
  readonly kind: ObservationEvidenceKind;
  readonly confidence: ObservationEvidenceConfidence;
  readonly observedAt: Date;
  readonly message?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
};

export type AvailabilityDecision = {
  readonly availability: AccountAvailability;
  readonly recommendedAction: AccountRecommendedAction;
  readonly schedulerEligible: boolean;
  readonly reason?: string;
  readonly limitResetAt?: Date;
};

export type AccountObservation = {
  readonly account: AccountSlot;
  readonly auth: AuthSession;
  readonly quota: QuotaSnapshot | null;
  readonly decision: AvailabilityDecision;
  readonly evidence: readonly ObservationEvidence[];
  readonly checkedAt: Date;
};

export type AccountPoolObservation = {
  readonly checkedAt: Date;
  readonly observations: readonly AccountObservation[];
  readonly summary: AccountPoolObservationSummary;
};

export type AccountPoolObservationSummary = {
  readonly availableCount: number;
  readonly limitedCount: number;
  readonly reloginRequiredCount: number;
  readonly unknownCount: number;
  readonly schedulerEligibleSlotIds: readonly string[];
  readonly nextAvailableAt?: Date;
};
