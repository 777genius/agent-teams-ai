import type { AuthorityBinding, HostedAccessAuthorityPolicy } from '../../contracts';

export const AUTHORITY_PERSISTED_KEYS = {
  binding: ['deploymentId', 'restoreGeneration'],
  state: [
    'schemaVersion',
    'revision',
    'binding',
    'expectedKeyringId',
    'consumedResetGeneration',
    'operatorId',
    'pairingChallenges',
    'deviceFamilies',
    'deviceGrants',
    'sessions',
    'resetIntent',
  ],
  pairingChallenge: [
    'challengeId',
    'secretHash',
    'keyringId',
    'resetGeneration',
    'issuedAt',
    'expiresAt',
    'failedAttempts',
    'maxAttempts',
    'status',
    'consumedAt',
    'revokedAt',
    'revocationReason',
    'pairedDeviceFamilyId',
    'pairedDeviceGrantId',
    'pairedSessionId',
    'deliveryCleanupPending',
  ],
  deviceFamily: [
    'familyId',
    'operatorId',
    'issuedAt',
    'lastUsedAt',
    'idleExpiresAt',
    'absoluteExpiresAt',
    'currentGeneration',
    'status',
    'revokedAt',
    'revocationReason',
  ],
  deviceGrant: [
    'grantId',
    'familyId',
    'generation',
    'renewedFromGrantId',
    'secretHash',
    'keyringId',
    'issuedAt',
    'renewalExpiresAt',
    'status',
    'predecessorGraceExpiresAt',
    'predecessorUsesRemaining',
    'retiredAt',
    'revokedAt',
    'revocationReason',
  ],
  session: [
    'sessionId',
    'operatorId',
    'familyId',
    'deviceGeneration',
    'secretHash',
    'keyringId',
    'issuedAt',
    'lastUsedAt',
    'deadlines',
    'status',
    'revokedAt',
    'revocationReason',
  ],
  deadlines: ['idleExpiresAt', 'absoluteExpiresAt', 'renewalExpiresAt'],
  resetIntent: [
    'resetGeneration',
    'requestedBinding',
    'requestedAt',
    'stage',
    'drainEvidenceRef',
    'stagedKeyringId',
    'challengeId',
  ],
} as const;

export function hasExactlyPersistedKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return actualKeys.every((key) => typeof key === 'string' && expected.has(key));
}

export function isWithinPolicyDuration(
  start: number,
  end: number,
  maximumDuration: number
): boolean {
  return end >= start && end - start <= maximumDuration;
}

export function isPersistedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPersistedInstant(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

export function isNullablePersistedInstant(value: unknown): value is number | null {
  return value === null || isPersistedInstant(value);
}

export function isNullablePersistedReason(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function persistedBindingsEqual(left: AuthorityBinding, right: AuthorityBinding): boolean {
  return (
    left.deploymentId === right.deploymentId && left.restoreGeneration === right.restoreGeneration
  );
}

export function hasCoherentPersistedRevocationStatus(value: Record<string, unknown>): boolean {
  if (value.status === 'active') {
    return value.revokedAt === null && value.revocationReason === null;
  }
  return (
    value.status === 'revoked' &&
    isPersistedInstant(value.revokedAt) &&
    value.revokedAt >=
      (isPersistedInstant(value.lastUsedAt) ? value.lastUsedAt : (value.issuedAt as number)) &&
    typeof value.revocationReason === 'string'
  );
}

export function assertHostedAccessAuthorityPolicy(policy: HostedAccessAuthorityPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`hosted-access-policy-${name}-invalid`);
    }
  }
  if (
    policy.sessionIdleTtlMs > policy.sessionAbsoluteTtlMs ||
    policy.sessionRenewalTtlMs > policy.sessionAbsoluteTtlMs ||
    policy.deviceIdleTtlMs > policy.deviceAbsoluteTtlMs ||
    policy.deviceRenewalTtlMs > policy.deviceAbsoluteTtlMs
  ) {
    throw new TypeError('hosted-access-policy-deadline-order-invalid');
  }
  if (
    policy.retainedDeviceGenerations < 3 ||
    policy.retainedDeviceGenerations < policy.predecessorMaxUses + 2
  ) {
    throw new TypeError('hosted-access-policy-device-retention-invalid');
  }
}

export function addDuration(now: number, durationMs: number): number {
  const result = now + durationMs;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(result)) {
    throw new TypeError('hosted-access-instant-invalid');
  }
  return result;
}

export function extendIdleDeadline(
  now: number,
  idleTtlMs: number,
  absoluteExpiresAt: number
): number {
  return Math.min(addDuration(now, idleTtlMs), absoluteExpiresAt);
}
