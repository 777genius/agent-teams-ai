export const HMAC_SHA256_LD_V1 = 'hmac-sha256-ld-v1' as const;

export const COMMAND_IDEMPOTENCY_SCOPE =
  'deploymentId+stableActorId+commandKind+idempotencyKey' as const;

export const EFFECT_RECOVERY_CLASSES = Object.freeze([
  'transactional_local',
  'idempotent_by_operation_id',
  'reconcilable_by_unique_evidence',
  'compensatable',
  'non_reconcilable',
] as const);

export type EffectRecoveryClass = (typeof EFFECT_RECOVERY_CLASSES)[number];

export const DURABLE_COMMAND_STATES = Object.freeze([
  'prepared',
  'running',
  'committed',
  'recovering',
  'failed',
  'operator_required',
] as const);

export type DurableCommandState = (typeof DURABLE_COMMAND_STATES)[number];

export const DURABLE_EFFECT_STATES = Object.freeze([
  'not_started',
  'attempting',
  'observed_succeeded',
  'observed_absent',
  'ambiguous',
  'compensating',
  'compensated',
] as const);

export type DurableEffectState = (typeof DURABLE_EFFECT_STATES)[number];

export type NormalizedIntentValue =
  | null
  | boolean
  | number
  | string
  | readonly NormalizedIntentValue[]
  | { readonly [key: string]: NormalizedIntentValue };

export type NormalizedCommandIntent = Readonly<Record<string, NormalizedIntentValue>>;

export interface EffectDescriptor {
  readonly effectId: string;
  readonly effectVersion: number;
  readonly recoveryClass: EffectRecoveryClass;
  readonly evidenceSchemaVersion: number;
}

export interface CommandDescriptor<TInput = unknown, TCommandKind extends string = string> {
  readonly descriptorId: string;
  /** Versions the complete immutable command contract, including its ordered effect plan. */
  readonly descriptorVersion: number;
  readonly commandKind: TCommandKind;
  readonly inputSchemaVersion: number;
  readonly fingerprintVersion: typeof HMAC_SHA256_LD_V1;
  /** Bumps whenever effect order, identity, version, recovery class, or evidence schema changes. */
  readonly effectPlanVersion: number;
  readonly idempotencyScope: typeof COMMAND_IDEMPOTENCY_SCOPE;
  readonly retentionClass: string;
  readonly normalizedIntentProjection: (input: TInput) => NormalizedCommandIntent;
  readonly effects: readonly [EffectDescriptor, ...EffectDescriptor[]];
}

export interface DurableCommandDescriptorIdentity<TCommandKind extends string = string> {
  readonly descriptorId: string;
  readonly descriptorVersion: number;
  readonly commandKind: TCommandKind;
  readonly inputSchemaVersion: number;
  readonly fingerprintVersion: typeof HMAC_SHA256_LD_V1;
  readonly effectPlanVersion: number;
}

export interface CommandFingerprintPreimage {
  readonly descriptorId: string;
  readonly descriptorVersion: number;
  readonly schemaVersion: number;
  readonly fingerprintVersion: typeof HMAC_SHA256_LD_V1;
  readonly effectPlanVersion: number;
  /** Binds order and every recovery-relevant effect field, even if a version was not bumped. */
  readonly effectPlan: readonly EffectDescriptor[];
  readonly intent: NormalizedCommandIntent;
}

/** The persisted fingerprint contains no normalized intent or command body. */
export interface CommandFingerprintRecord {
  readonly descriptorId: string;
  readonly descriptorVersion: number;
  readonly schemaVersion: number;
  readonly fingerprintVersion: typeof HMAC_SHA256_LD_V1;
  readonly effectPlanVersion: number;
  readonly keyVersion: string;
  readonly digest: string;
}

export interface CommandClaimScope<TCommandKind extends string = string> {
  readonly deploymentId: string;
  readonly stableActorId: string;
  readonly commandKind: TCommandKind;
  readonly idempotencyKey: string;
}

export interface CommandClaimRecord<TCommandKind extends string = string> {
  readonly scope: CommandClaimScope<TCommandKind>;
  readonly fingerprint: CommandFingerprintRecord;
}

export interface IdempotencyMismatch {
  readonly code: 'idempotency_mismatch';
  readonly existingFingerprint: CommandFingerprintRecord;
  readonly requestedFingerprint: CommandFingerprintRecord;
}

export type CommandClaimResolution<TCommandKind extends string = string> =
  | {
      readonly outcome: 'claimed';
      readonly claimAction: 'create';
      readonly effectAction: 'none';
      readonly record: CommandClaimRecord<TCommandKind>;
    }
  | {
      readonly outcome: 'same_intent';
      readonly claimAction: 'reuse';
      readonly effectAction: 'none';
      readonly record: CommandClaimRecord<TCommandKind>;
    }
  | {
      readonly outcome: 'idempotency_mismatch';
      readonly claimAction: 'reject';
      readonly effectAction: 'none';
      readonly record: CommandClaimRecord<TCommandKind>;
      readonly mismatch: IdempotencyMismatch;
    };

export interface DurableEffectPlanItem extends EffectDescriptor {
  readonly ordinal: number;
  readonly state: DurableEffectState;
}

export type DurableEffectEvidenceOutcome = 'observed_succeeded' | 'observed_absent';

/**
 * An owning adapter constructs this only after validating evidence under the descriptor's schema.
 * The pure state machine verifies that the evidence is bound to the exact effect contract.
 */
export interface ValidatedDurableEffectEvidence extends EffectDescriptor {
  readonly outcome: DurableEffectEvidenceOutcome;
}

export type AmbiguousEffectDisposition =
  | {
      readonly commandState: 'recovering';
      readonly automaticAction: 'require_declared_evidence';
    }
  | {
      readonly commandState: 'operator_required';
      readonly automaticAction: 'none';
    };
