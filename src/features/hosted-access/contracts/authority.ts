declare const hostedAccessBrand: unique symbol;

type BrandedString<Name extends string> = string & {
  readonly [hostedAccessBrand]: Name;
};

export type OperatorId = BrandedString<'OperatorId'>;
export type PairingChallengeId = BrandedString<'PairingChallengeId'>;
export type DeviceFamilyId = BrandedString<'DeviceFamilyId'>;
export type DeviceGrantId = BrandedString<'DeviceGrantId'>;
export type OperatorSessionId = BrandedString<'OperatorSessionId'>;
export type AuthKeyringId = BrandedString<'AuthKeyringId'>;
export type AuthorityDeploymentId = BrandedString<'AuthorityDeploymentId'>;
export type OpaqueAuthoritySecret = BrandedString<'OpaqueAuthoritySecret'>;
export type KeyedSecretHash = BrandedString<'KeyedSecretHash'>;
export type AuthorityKeyMaterial = BrandedString<'AuthorityKeyMaterial'>;
export type CsrfToken = BrandedString<'CsrfToken'>;

const ID_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const HASH_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

function parseId<Name extends string>(value: unknown, errorName: string): BrandedString<Name> {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`hosted-access-${errorName}-invalid`);
  }
  return value as BrandedString<Name>;
}

export const parseOperatorId = (value: unknown): OperatorId =>
  parseId<'OperatorId'>(value, 'operator-id');
export const parsePairingChallengeId = (value: unknown): PairingChallengeId =>
  parseId<'PairingChallengeId'>(value, 'pairing-challenge-id');
export const parseDeviceFamilyId = (value: unknown): DeviceFamilyId =>
  parseId<'DeviceFamilyId'>(value, 'device-family-id');
export const parseDeviceGrantId = (value: unknown): DeviceGrantId =>
  parseId<'DeviceGrantId'>(value, 'device-grant-id');
export const parseOperatorSessionId = (value: unknown): OperatorSessionId =>
  parseId<'OperatorSessionId'>(value, 'operator-session-id');
export const parseAuthKeyringId = (value: unknown): AuthKeyringId =>
  parseId<'AuthKeyringId'>(value, 'auth-keyring-id');
export const parseAuthorityDeploymentId = (value: unknown): AuthorityDeploymentId =>
  parseId<'AuthorityDeploymentId'>(value, 'authority-deployment-id');

export function parseOpaqueAuthoritySecret(value: unknown): OpaqueAuthoritySecret {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) {
    throw new TypeError('hosted-access-opaque-secret-invalid');
  }
  return value as OpaqueAuthoritySecret;
}

export function parseCsrfToken(value: unknown): CsrfToken {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) {
    throw new TypeError('hosted-access-csrf-token-invalid');
  }
  return value as CsrfToken;
}

export function parseKeyedSecretHash(value: unknown): KeyedSecretHash {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new TypeError('hosted-access-keyed-secret-hash-invalid');
  }
  return value as KeyedSecretHash;
}

export function parseAuthorityKeyMaterial(value: unknown): AuthorityKeyMaterial {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) {
    throw new TypeError('hosted-access-key-material-invalid');
  }
  return value as AuthorityKeyMaterial;
}

export interface AuthorityBinding {
  readonly deploymentId: AuthorityDeploymentId;
  /**
   * Host-owned restore fence. It must change when coordination state is restored
   * into a replacement deployment.
   */
  readonly restoreGeneration: number;
}

export interface HostedAccessAuthorityPolicy {
  readonly pairingChallengeTtlMs: number;
  readonly pairingMaxAttempts: number;
  readonly deviceIdleTtlMs: number;
  readonly deviceAbsoluteTtlMs: number;
  readonly deviceRenewalTtlMs: number;
  readonly sessionIdleTtlMs: number;
  readonly sessionAbsoluteTtlMs: number;
  readonly sessionRenewalTtlMs: number;
  readonly predecessorGraceMs: number;
  readonly predecessorMaxUses: number;
  readonly retainedDeviceGenerations: number;
  readonly compareAndSwapAttempts: number;
}

export type HostedAccessRejectionCode =
  | 'authority_state_corrupt'
  | 'authority_store_conflict'
  | 'authority_store_unavailable'
  | 'challenge_attempts_exhausted'
  | 'challenge_delivery_unavailable'
  | 'challenge_expired'
  | 'challenge_invalid'
  | 'challenge_not_issued'
  | 'csrf_invalid'
  | 'device_absolute_expired'
  | 'device_family_revoked'
  | 'device_idle_expired'
  | 'device_invalid'
  | 'keyring_corrupt'
  | 'keyring_missing'
  | 'keyring_mismatch'
  | 'keyring_unavailable'
  | 'pairing_already_established'
  | 'pairing_drain_unconfirmed'
  | 'reset_generation_not_newer'
  | 'reset_in_progress'
  | 'reset_stage_unavailable'
  | 'restore_binding_mismatch'
  | 'session_absolute_expired'
  | 'session_idle_expired'
  | 'session_invalid'
  | 'session_renewal_required';

export type HostedAccessResult<Value, Code extends string = string> =
  | { readonly ok: true; readonly code: Code; readonly value: Value }
  | { readonly ok: false; readonly code: HostedAccessRejectionCode };

export interface PairingCredentials {
  readonly operatorId: OperatorId;
  readonly deviceFamilyId: DeviceFamilyId;
  readonly deviceGeneration: number;
  readonly deviceSecret: OpaqueAuthoritySecret;
  readonly sessionId: OperatorSessionId;
  readonly sessionSecret: OpaqueAuthoritySecret;
  readonly csrfToken: CsrfToken;
}

export interface RenewedCredentials extends PairingCredentials {
  readonly acceptedDeviceGeneration: number;
  readonly acceptedVia: 'current' | 'predecessor';
}

export interface AuthenticatedOperator {
  readonly operatorId: OperatorId;
  readonly deviceFamilyId: DeviceFamilyId;
  readonly sessionId: OperatorSessionId;
}
