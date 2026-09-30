import type {
  AuthKeyringId,
  AuthorityBinding,
  AuthorityKeyMaterial,
  CsrfToken,
  KeyedSecretHash,
  OpaqueAuthoritySecret,
  OperatorId,
  PairingChallengeId,
} from '../../contracts';
import type { HostedAccessAuthorityState } from '../domain';

export type AuthorityRandomIdKind =
  | 'auth-keyring'
  | 'device-family'
  | 'device-grant'
  | 'operator'
  | 'pairing-challenge'
  | 'session';

export type AuthorityRandomSecretKind =
  | 'csrf-key'
  | 'device-grant'
  | 'hash-key'
  | 'pairing-challenge'
  | 'session';

export interface HostedAccessClockPort {
  now(): number;
}

export interface HostedAccessRandomPort {
  randomId(kind: AuthorityRandomIdKind): Promise<string>;
  randomSecret(
    kind: AuthorityRandomSecretKind,
    byteLength: 32
  ): Promise<OpaqueAuthoritySecret | AuthorityKeyMaterial>;
}

export type KeyedHashPurpose = 'device-grant' | 'operator-session' | 'pairing-challenge';
export type AuthoritySecretDerivationPurpose =
  | 'pairing-device-grant'
  | 'pairing-session'
  | 'renewed-device-grant'
  | 'renewed-session';

export interface HostedAccessCryptoPort {
  keyedHash(input: {
    readonly key: AuthorityKeyMaterial;
    readonly purpose: KeyedHashPurpose;
    readonly secret: OpaqueAuthoritySecret;
  }): Promise<KeyedSecretHash>;
  /**
   * Stable, domain-separated PRF derivation. Implementations must return the
   * same opaque secret after restart and must never return the source secret.
   */
  deriveSecret(input: {
    readonly key: AuthorityKeyMaterial;
    readonly purpose: AuthoritySecretDerivationPurpose;
    readonly sourceSecret: OpaqueAuthoritySecret;
    readonly context: string;
  }): Promise<OpaqueAuthoritySecret>;
  deriveCsrf(input: {
    readonly key: AuthorityKeyMaterial;
    readonly sessionId: string;
    readonly sessionSecret: OpaqueAuthoritySecret;
  }): Promise<CsrfToken>;
  secureEqual(left: string, right: string): Promise<boolean>;
}

export interface AuthKeyringEnvelope {
  readonly format: 'hosted-access-keyring/v1';
  readonly keyringId: AuthKeyringId;
  readonly binding: AuthorityBinding;
  readonly createdAt: number;
  readonly hashKey: AuthorityKeyMaterial;
  readonly csrfKey: AuthorityKeyMaterial;
}

export type AuthKeyringReadResult =
  | { readonly status: 'available'; readonly envelope: AuthKeyringEnvelope }
  | { readonly status: 'missing' | 'corrupt' | 'unavailable' };

export type AuthKeyringWriteResult =
  | { readonly status: 'created' | 'staged' | 'activated' | 'already_applied' }
  | { readonly status: 'conflict' | 'unavailable' };

/**
 * The adapter owns exclusive-create, mode checks, file and parent fsync, and
 * same-directory activation. Core never imports a filesystem API.
 */
export interface AuthKeyringPort {
  loadActive(): Promise<AuthKeyringReadResult>;
  createInitial(envelope: AuthKeyringEnvelope): Promise<AuthKeyringWriteResult>;
  loadStaged(keyringId: AuthKeyringId): Promise<AuthKeyringReadResult>;
  stageReplacement(envelope: AuthKeyringEnvelope): Promise<AuthKeyringWriteResult>;
  activateStaged(keyringId: AuthKeyringId): Promise<AuthKeyringWriteResult>;
}

export type AuthorityRepositoryReadResult =
  | {
      readonly status: 'available';
      readonly state: HostedAccessAuthorityState;
      readonly rollbackFenceRevision: number;
    }
  | {
      readonly status: 'empty';
      /**
       * Null only for a never-initialized authority. A non-null value proves
       * that the rollback-resistant fence survived loss of the projection.
       */
      readonly rollbackFenceRevision: number | null;
    }
  | { readonly status: 'corrupt' | 'unavailable' };

export type AuthorityRepositoryWriteResult =
  | { readonly status: 'committed' }
  | { readonly status: 'conflict' | 'unavailable' };

/**
 * The rollback fence must live outside the projection's snapshot/restore
 * domain and must never decrease or be deleted after initialization.
 *
 * initialize must atomically create revision zero and fence zero only when
 * neither exists. compareAndSwap must atomically re-check both expected
 * revisions, commit the complete next projection, and advance the durable
 * fence by exactly one. A projection/fence mismatch must be returned as
 * `corrupt`, never repaired by lowering or recreating the fence.
 */
export interface HostedAccessAuthorityRepositoryPort {
  load(): Promise<AuthorityRepositoryReadResult>;
  initialize(state: HostedAccessAuthorityState): Promise<AuthorityRepositoryWriteResult>;
  compareAndSwap(input: {
    readonly expectedRevision: number;
    readonly expectedRollbackFenceRevision: number;
    readonly nextState: HostedAccessAuthorityState;
    readonly nextRollbackFenceRevision: number;
  }): Promise<AuthorityRepositoryWriteResult>;
}

export type PairingChallengeDeliveryStatus =
  | { readonly status: 'present' | 'missing' }
  | { readonly status: 'unavailable' };

export type PairingChallengeDeliveryWriteResult =
  | { readonly status: 'published' | 'already_published' | 'removed' | 'already_missing' }
  | { readonly status: 'conflict' | 'unavailable' };

/**
 * The adapter atomically publishes the one plaintext pairing value to its
 * operator-only channel. It must never place the value in coordination state.
 */
export interface PairingChallengeDeliveryPort {
  status(challengeId: PairingChallengeId): Promise<PairingChallengeDeliveryStatus>;
  publish(input: {
    readonly challengeId: PairingChallengeId;
    readonly secret: OpaqueAuthoritySecret;
    readonly expiresAt: number;
  }): Promise<PairingChallengeDeliveryWriteResult>;
  remove(challengeId: PairingChallengeId): Promise<PairingChallengeDeliveryWriteResult>;
}

export type PairingDrainPurpose = 'initial_pairing' | 'host_reset' | 'auth_mode_reset';

export type PairingDrainResult =
  | { readonly status: 'drained'; readonly evidenceRef: string }
  | { readonly status: 'residual' | 'unclassified' | 'unavailable' };

/**
 * Public, authority-neutral residual proof. An adapter may translate the
 * process controller's public evidence without exposing runtime internals.
 */
export interface PairingDrainProofPort {
  confirmDrained(input: {
    readonly binding: AuthorityBinding;
    readonly purpose: PairingDrainPurpose;
    readonly resetGeneration: number;
    readonly targetAuthMode?: 'personal' | 'oidc';
  }): Promise<PairingDrainResult>;
}

/**
 * Prepares the immutable personal-owner identity before a transition rotates
 * or consumes browser credentials. Implementations may return an already
 * prepared operator after a prior store-success/authority-conflict retry.
 */
export interface PersonalOwnerPreparationPort {
  prepare(proposedOperatorId: OperatorId): Promise<OperatorId>;
}
