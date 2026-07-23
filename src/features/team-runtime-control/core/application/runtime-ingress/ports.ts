import type {
  PresentedRuntimeIngressCredential,
  RuntimeIngressCanonicalEffect,
  RuntimeIngressCredential,
  RuntimeIngressEffectAcknowledgement,
  RuntimeIngressEffectRef,
  RuntimeIngressReplayKey,
  RuntimeIngressSessionState,
  RuntimeIngressVerb,
} from '../../domain/runtime-ingress';
import type {
  CommandClaimScope,
  CommandDescriptor,
  CommandFingerprintRecord,
  DurableApplicationCommandRecord,
  EffectRecoveryClass,
  PreparedCommandFingerprint,
} from '@features/application-command-ledger';

export type RuntimeIngressDurableCommandRecord =
  DurableApplicationCommandRecord<RuntimeIngressVerb>;
export type RuntimeIngressCommandDescriptor = Omit<
  CommandDescriptor<unknown, RuntimeIngressVerb>,
  'normalizedIntentProjection'
>;

/**
 * Canonical evidence persisted with the transactional ingress effect. The
 * duplicated bindings are intentional: replay accepts the outcome only when
 * the acknowledgement, durable claim, transaction, and effect evidence all
 * agree on the exact authority and acceptance.
 */
export interface RuntimeIngressDurableEffectEvidence {
  readonly evidenceVersion: 1;
  readonly durableCommandId: string;
  readonly acknowledgementId: RuntimeIngressEffectAcknowledgement['acknowledgementId'];
  readonly effectRef: RuntimeIngressEffectRef;
  readonly replayKey: RuntimeIngressReplayKey;
  readonly claimScope: CommandClaimScope<RuntimeIngressVerb>;
  readonly fingerprint: CommandFingerprintRecord;
  readonly transaction: {
    readonly generation: number;
    readonly attemptId: string;
  };
  readonly effect: {
    readonly effectId: string;
    readonly effectVersion: number;
    readonly recoveryClass: EffectRecoveryClass;
    readonly evidenceSchemaVersion: number;
    readonly ordinal: number;
  };
  readonly acceptedAtIso: string;
}

export interface RuntimeIngressClockPort {
  nowIso(): string;
}

export interface VerifyRuntimeIngressCredentialRequest {
  readonly presented: PresentedRuntimeIngressCredential;
}

/**
 * The output adapter verifies the persisted digest with a constant-time
 * comparison. It never persists or returns the presented bearer secret.
 */
export type VerifyRuntimeIngressCredentialResult =
  | { readonly status: 'verified'; readonly credential: RuntimeIngressCredential }
  | { readonly status: 'rejected' }
  | { readonly status: 'unavailable' };

export type LoadRuntimeIngressCredentialResult =
  | { readonly status: 'found'; readonly credential: RuntimeIngressCredential }
  | { readonly status: 'missing' | 'unavailable' };

export type LoadRuntimeIngressSessionResult =
  | { readonly status: 'found'; readonly session: RuntimeIngressSessionState }
  | { readonly status: 'missing' | 'unavailable' };

export interface FingerprintRuntimeIngressCommandRequest {
  readonly scope: CommandClaimScope<RuntimeIngressVerb>;
  readonly prepared: PreparedCommandFingerprint;
}

/**
 * Selects the retained key version for an existing durable claim, HMACs the
 * application-command-ledger preimage, and returns its canonical persisted
 * fingerprint record. No caller-provided payload digest is accepted.
 */
export type FingerprintRuntimeIngressCommandResult =
  | { readonly status: 'fingerprinted'; readonly fingerprint: CommandFingerprintRecord }
  | { readonly status: 'unavailable' };

export interface LoadRuntimeIngressCommandRequest {
  readonly scope: CommandClaimScope<RuntimeIngressVerb>;
  readonly fingerprint: CommandFingerprintRecord;
  readonly expectedCredential: RuntimeIngressCredential;
  readonly expectedSession: RuntimeIngressSessionState;
}

export type LoadRuntimeIngressCommandResult =
  | { readonly status: 'found'; readonly command: RuntimeIngressDurableCommandRecord }
  | {
      readonly status:
        | 'missing'
        | 'fingerprint_conflict'
        | 'credential_inactive'
        | 'session_conflict'
        | 'unavailable';
    };

export interface ApplyRuntimeIngressAtomicallyRequest {
  readonly descriptor: RuntimeIngressCommandDescriptor;
  readonly claimScope: CommandClaimScope<RuntimeIngressVerb>;
  readonly fingerprint: CommandFingerprintRecord;
  readonly expectedCredential: RuntimeIngressCredential;
  readonly expectedSession: RuntimeIngressSessionState;
  readonly nextSession: RuntimeIngressSessionState;
  readonly effect: RuntimeIngressCanonicalEffect;
  readonly acknowledgement: RuntimeIngressEffectAcknowledgement;
}

export type ApplyRuntimeIngressAtomicallyResult =
  | {
      readonly status: 'applied' | 'duplicate';
      readonly command: RuntimeIngressDurableCommandRecord;
      readonly session: RuntimeIngressSessionState;
    }
  | {
      readonly status:
        | 'fingerprint_conflict'
        | 'sequence_conflict'
        | 'credential_inactive'
        | 'session_conflict'
        | 'recovery_required'
        | 'unavailable';
    };

export interface RevokeRuntimeIngressCredentialAtomicallyRequest {
  readonly expectedCredential: RuntimeIngressCredential;
  readonly nextCredential: RuntimeIngressCredential;
}

export type RevokeRuntimeIngressCredentialAtomicallyResult =
  | { readonly status: 'revoked'; readonly credential: RuntimeIngressCredential }
  | { readonly status: 'already_revoked'; readonly credential: RuntimeIngressCredential }
  | { readonly status: 'missing' | 'conflict' | 'unavailable' };

/**
 * Durable runtime-ingress storage boundary.
 *
 * The fingerprint/load methods are adapters over application-command-ledger's
 * HMAC fingerprint and claim lookup semantics. loadCommand revalidates the
 * expected active credential and session in the same read transaction as a
 * committed replay lookup. applyAtomically MUST use one internal-storage
 * transaction to:
 *
 * 1. re-check the exact active credential and session revisions;
 * 2. resolve the canonical command claim and reject a fingerprint mismatch;
 * 3. transition its checked-in transactional_local effect through attempting
 *    to observed_succeeded with one exact RuntimeIngressDurableEffectEvidence
 *    record bound to the durable attempt and accepted instant;
 * 4. apply the authoritative lane ingress effect;
 * 5. persist its acknowledgement as the durable command outcome; and
 * 6. persist nextSession, including bootstrap, freshness, ownership, sequence,
 *    and accepted-verb state, before committing the command.
 *
 * A committed duplicate is returned only after step 1 revalidates the current
 * persisted credential and session. Implementations must expose neither the
 * effect nor an acknowledgement before the transaction commits and must never
 * assemble these obligations from best-effort application-ledger calls. The
 * effect target is selected from the re-checked credential scope; identifiers
 * inside effect.payloadJson cannot select another authority.
 *
 * revokeCredentialAtomically revokes the credential and invalidates its bound
 * session in the same transaction, closing verification/replay races.
 */
export interface RuntimeIngressDurableRecoveryPort {
  verifyCredential(
    request: VerifyRuntimeIngressCredentialRequest
  ): Promise<VerifyRuntimeIngressCredentialResult>;
  loadCredential(
    credentialId: RuntimeIngressCredential['credentialId']
  ): Promise<LoadRuntimeIngressCredentialResult>;
  loadSession(
    sessionId: RuntimeIngressSessionState['sessionId']
  ): Promise<LoadRuntimeIngressSessionResult>;
  fingerprintCommand(
    request: FingerprintRuntimeIngressCommandRequest
  ): Promise<FingerprintRuntimeIngressCommandResult>;
  loadCommand(request: LoadRuntimeIngressCommandRequest): Promise<LoadRuntimeIngressCommandResult>;
  applyAtomically(
    request: ApplyRuntimeIngressAtomicallyRequest
  ): Promise<ApplyRuntimeIngressAtomicallyResult>;
  revokeCredentialAtomically(
    request: RevokeRuntimeIngressCredentialAtomicallyRequest
  ): Promise<RevokeRuntimeIngressCredentialAtomicallyResult>;
}
