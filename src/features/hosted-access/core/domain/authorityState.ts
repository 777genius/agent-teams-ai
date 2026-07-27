import {
  type AuthKeyringId,
  type AuthorityBinding,
  type DeviceFamilyId,
  type DeviceGrantId,
  type HostedAccessAuthorityPolicy,
  type KeyedSecretHash,
  type OperatorId,
  type OperatorSessionId,
  type PairingChallengeId,
  parseAuthKeyringId,
  parseAuthorityDeploymentId,
  parseDeviceFamilyId,
  parseDeviceGrantId,
  parseKeyedSecretHash,
  parseOperatorId,
  parseOperatorSessionId,
  parsePairingChallengeId,
} from '../../contracts';

import {
  AUTHORITY_PERSISTED_KEYS,
  hasCoherentPersistedRevocationStatus as hasCoherentRevocationStatus,
  hasExactlyPersistedKeys,
  isNonNegativeSafeInteger,
  isNullablePersistedInstant as isNullableInstant,
  isNullablePersistedReason as isNullableReason,
  isPersistedInstant as isInstant,
  isPersistedRecord as isRecord,
  isPositiveSafeInteger,
  isWithinPolicyDuration,
  persistedBindingsEqual as bindingsEqual,
} from './policy';

export interface ExpiryDeadlines {
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly renewalExpiresAt: number;
}

export type PairingChallengeStatus = 'pending_delivery' | 'issued' | 'consumed' | 'revoked';

export interface PairingChallenge {
  readonly challengeId: PairingChallengeId;
  readonly secretHash: KeyedSecretHash;
  readonly keyringId: AuthKeyringId;
  readonly resetGeneration: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly failedAttempts: number;
  readonly maxAttempts: number;
  readonly status: PairingChallengeStatus;
  readonly consumedAt: number | null;
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
  readonly pairedDeviceFamilyId: DeviceFamilyId | null;
  readonly pairedDeviceGrantId: DeviceGrantId | null;
  readonly pairedSessionId: OperatorSessionId | null;
  /**
   * Durable cross-store cleanup intent. A consumed/revoked challenge is not
   * fully reconciled until its plaintext delivery has been confirmed absent.
   */
  readonly deliveryCleanupPending: boolean;
}

export interface OperatorDeviceFamily {
  readonly familyId: DeviceFamilyId;
  readonly operatorId: OperatorId;
  readonly issuedAt: number;
  readonly lastUsedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly currentGeneration: number;
  readonly status: 'active' | 'revoked';
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
}

export type DeviceGrantStatus = 'current' | 'predecessor' | 'retired' | 'revoked';

export interface OperatorDeviceGrant {
  readonly grantId: DeviceGrantId;
  readonly familyId: DeviceFamilyId;
  readonly generation: number;
  readonly renewedFromGrantId: DeviceGrantId | null;
  readonly secretHash: KeyedSecretHash;
  readonly keyringId: AuthKeyringId;
  readonly issuedAt: number;
  readonly renewalExpiresAt: number;
  readonly status: DeviceGrantStatus;
  readonly predecessorGraceExpiresAt: number | null;
  readonly predecessorUsesRemaining: number;
  readonly retiredAt: number | null;
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
}

export interface OperatorSession {
  readonly sessionId: OperatorSessionId;
  readonly operatorId: OperatorId;
  readonly familyId: DeviceFamilyId;
  readonly deviceGeneration: number;
  readonly secretHash: KeyedSecretHash;
  readonly keyringId: AuthKeyringId;
  readonly issuedAt: number;
  readonly lastUsedAt: number;
  readonly deadlines: ExpiryDeadlines;
  readonly status: 'active' | 'revoked';
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
}

export type AuthResetStage =
  | 'requested'
  | 'drain_confirmed'
  | 'key_stage_reserved'
  | 'new_key_staged'
  | 'authority_revoked'
  | 'key_activated'
  | 'delivery_recovery'
  | 'challenge_pending'
  | 'challenge_issued';

export interface AuthResetIntent {
  readonly resetGeneration: number;
  readonly requestedBinding: AuthorityBinding;
  readonly requestedAt: number;
  readonly stage: AuthResetStage;
  readonly drainEvidenceRef: string | null;
  readonly stagedKeyringId: AuthKeyringId | null;
  readonly challengeId: PairingChallengeId | null;
}

export interface HostedAccessAuthorityState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly binding: AuthorityBinding;
  readonly expectedKeyringId: AuthKeyringId;
  readonly consumedResetGeneration: number;
  readonly operatorId: OperatorId | null;
  readonly pairingChallenges: readonly PairingChallenge[];
  readonly deviceFamilies: readonly OperatorDeviceFamily[];
  readonly deviceGrants: readonly OperatorDeviceGrant[];
  readonly sessions: readonly OperatorSession[];
  readonly resetIntent: AuthResetIntent | null;
}

export function createInitialAuthorityState(input: {
  readonly binding: AuthorityBinding;
  readonly keyringId: AuthKeyringId;
}): HostedAccessAuthorityState {
  assertAuthorityBinding(input.binding);
  parseAuthKeyringId(input.keyringId);
  return freezeAuthorityState({
    schemaVersion: 1,
    revision: 0,
    binding: input.binding,
    expectedKeyringId: input.keyringId,
    consumedResetGeneration: 0,
    operatorId: null,
    pairingChallenges: [],
    deviceFamilies: [],
    deviceGrants: [],
    sessions: [],
    resetIntent: null,
  });
}

export function freezeAuthorityState(
  state: HostedAccessAuthorityState
): HostedAccessAuthorityState {
  return Object.freeze({
    ...state,
    binding: Object.freeze({ ...state.binding }),
    pairingChallenges: Object.freeze(
      state.pairingChallenges.map((item) => Object.freeze({ ...item }))
    ),
    deviceFamilies: Object.freeze(state.deviceFamilies.map((item) => Object.freeze({ ...item }))),
    deviceGrants: Object.freeze(state.deviceGrants.map((item) => Object.freeze({ ...item }))),
    sessions: Object.freeze(
      state.sessions.map((item) =>
        Object.freeze({ ...item, deadlines: Object.freeze({ ...item.deadlines }) })
      )
    ),
    resetIntent:
      state.resetIntent === null
        ? null
        : Object.freeze({
            ...state.resetIntent,
            requestedBinding: Object.freeze({ ...state.resetIntent.requestedBinding }),
          }),
  });
}

export function nextAuthorityState(
  current: HostedAccessAuthorityState,
  patch: Partial<Omit<HostedAccessAuthorityState, 'schemaVersion' | 'revision'>>
): HostedAccessAuthorityState {
  return freezeAuthorityState({
    ...current,
    ...patch,
    schemaVersion: 1,
    revision: current.revision + 1,
  });
}

export function hasPersistedAuthority(state: HostedAccessAuthorityState): boolean {
  return (
    state.operatorId !== null ||
    state.pairingChallenges.length > 0 ||
    state.deviceFamilies.length > 0 ||
    state.deviceGrants.length > 0 ||
    state.sessions.length > 0 ||
    state.resetIntent !== null
  );
}

export function isRecoverableAuthorityState(
  value: unknown,
  policy: HostedAccessAuthorityPolicy
): value is HostedAccessAuthorityState {
  if (
    !isRecord(value) ||
    !hasExactlyPersistedKeys(value, AUTHORITY_PERSISTED_KEYS.state) ||
    !isRecord(value.binding) ||
    !hasExactlyPersistedKeys(value.binding, AUTHORITY_PERSISTED_KEYS.binding)
  ) {
    return false;
  }
  try {
    parseAuthorityDeploymentId(value.binding.deploymentId);
    parseAuthKeyringId(value.expectedKeyringId);
    if (value.operatorId !== null) parseOperatorId(value.operatorId);
  } catch {
    return false;
  }
  if (
    value.schemaVersion !== 1 ||
    !isNonNegativeSafeInteger(value.revision) ||
    !isNonNegativeSafeInteger(value.binding.restoreGeneration) ||
    !isNonNegativeSafeInteger(value.consumedResetGeneration) ||
    !Array.isArray(value.pairingChallenges) ||
    !Array.isArray(value.deviceFamilies) ||
    !Array.isArray(value.deviceGrants) ||
    !Array.isArray(value.sessions)
  ) {
    return false;
  }
  return (
    value.pairingChallenges.every((item) => isRecoverablePairingChallenge(item, policy)) &&
    value.deviceFamilies.every((item) => isRecoverableDeviceFamily(item, policy)) &&
    value.deviceGrants.every((item) => isRecoverableDeviceGrant(item, policy)) &&
    value.sessions.every((item) => isRecoverableSession(item, policy)) &&
    isRecoverableResetIntent(value.resetIntent) &&
    hasConsistentRelationships(value as unknown as HostedAccessAuthorityState, policy)
  );
}

export function assertAuthorityBinding(binding: AuthorityBinding): void {
  if (!isRecord(binding) || !hasExactlyPersistedKeys(binding, AUTHORITY_PERSISTED_KEYS.binding)) {
    throw new TypeError('hosted-access-authority-binding-invalid');
  }
  parseAuthorityDeploymentId(binding.deploymentId);
  if (!isNonNegativeSafeInteger(binding.restoreGeneration)) {
    throw new TypeError('hosted-access-restore-generation-invalid');
  }
}

function isRecoverablePairingChallenge(
  value: unknown,
  policy: HostedAccessAuthorityPolicy
): value is PairingChallenge {
  if (
    !isRecord(value) ||
    !hasExactlyPersistedKeys(value, AUTHORITY_PERSISTED_KEYS.pairingChallenge)
  ) {
    return false;
  }
  try {
    parsePairingChallengeId(value.challengeId);
    parseKeyedSecretHash(value.secretHash);
    parseAuthKeyringId(value.keyringId);
    if (value.pairedDeviceFamilyId !== null) parseDeviceFamilyId(value.pairedDeviceFamilyId);
    if (value.pairedDeviceGrantId !== null) parseDeviceGrantId(value.pairedDeviceGrantId);
    if (value.pairedSessionId !== null) parseOperatorSessionId(value.pairedSessionId);
  } catch {
    return false;
  }
  return (
    isNonNegativeSafeInteger(value.resetGeneration) &&
    isInstant(value.issuedAt) &&
    isInstant(value.expiresAt) &&
    value.expiresAt > value.issuedAt &&
    isWithinPolicyDuration(value.issuedAt, value.expiresAt, policy.pairingChallengeTtlMs) &&
    isNonNegativeSafeInteger(value.failedAttempts) &&
    isPositiveSafeInteger(value.maxAttempts) &&
    value.maxAttempts <= policy.pairingMaxAttempts &&
    value.failedAttempts <= value.maxAttempts &&
    ['pending_delivery', 'issued', 'consumed', 'revoked'].includes(String(value.status)) &&
    isNullableInstant(value.consumedAt) &&
    isNullableInstant(value.revokedAt) &&
    isNullableReason(value.revocationReason) &&
    typeof value.deliveryCleanupPending === 'boolean' &&
    hasCoherentChallengeStatus(value)
  );
}

function isRecoverableDeviceFamily(
  value: unknown,
  policy: HostedAccessAuthorityPolicy
): value is OperatorDeviceFamily {
  if (!isRecord(value) || !hasExactlyPersistedKeys(value, AUTHORITY_PERSISTED_KEYS.deviceFamily)) {
    return false;
  }
  try {
    parseDeviceFamilyId(value.familyId);
    parseOperatorId(value.operatorId);
  } catch {
    return false;
  }
  return (
    isInstant(value.issuedAt) &&
    isInstant(value.lastUsedAt) &&
    isInstant(value.idleExpiresAt) &&
    isInstant(value.absoluteExpiresAt) &&
    value.issuedAt <= value.lastUsedAt &&
    value.lastUsedAt <= value.idleExpiresAt &&
    value.idleExpiresAt <= value.absoluteExpiresAt &&
    isWithinPolicyDuration(value.issuedAt, value.absoluteExpiresAt, policy.deviceAbsoluteTtlMs) &&
    isWithinPolicyDuration(value.lastUsedAt, value.idleExpiresAt, policy.deviceIdleTtlMs) &&
    isPositiveSafeInteger(value.currentGeneration) &&
    (value.status === 'active' || value.status === 'revoked') &&
    isNullableInstant(value.revokedAt) &&
    isNullableReason(value.revocationReason) &&
    hasCoherentRevocationStatus(value)
  );
}

function isRecoverableDeviceGrant(
  value: unknown,
  policy: HostedAccessAuthorityPolicy
): value is OperatorDeviceGrant {
  if (!isRecord(value) || !hasExactlyPersistedKeys(value, AUTHORITY_PERSISTED_KEYS.deviceGrant)) {
    return false;
  }
  try {
    parseDeviceGrantId(value.grantId);
    parseDeviceFamilyId(value.familyId);
    parseKeyedSecretHash(value.secretHash);
    parseAuthKeyringId(value.keyringId);
    if (value.renewedFromGrantId !== null) parseDeviceGrantId(value.renewedFromGrantId);
  } catch {
    return false;
  }
  return (
    isPositiveSafeInteger(value.generation) &&
    isInstant(value.issuedAt) &&
    isInstant(value.renewalExpiresAt) &&
    value.issuedAt <= value.renewalExpiresAt &&
    isWithinPolicyDuration(value.issuedAt, value.renewalExpiresAt, policy.deviceRenewalTtlMs) &&
    ['current', 'predecessor', 'retired', 'revoked'].includes(String(value.status)) &&
    isNullableInstant(value.predecessorGraceExpiresAt) &&
    isNonNegativeSafeInteger(value.predecessorUsesRemaining) &&
    value.predecessorUsesRemaining <= policy.predecessorMaxUses &&
    isNullableInstant(value.retiredAt) &&
    isNullableInstant(value.revokedAt) &&
    isNullableReason(value.revocationReason) &&
    hasCoherentGrantStatus(value)
  );
}

function isRecoverableSession(
  value: unknown,
  policy: HostedAccessAuthorityPolicy
): value is OperatorSession {
  if (
    !isRecord(value) ||
    !hasExactlyPersistedKeys(value, AUTHORITY_PERSISTED_KEYS.session) ||
    !isRecord(value.deadlines) ||
    !hasExactlyPersistedKeys(value.deadlines, AUTHORITY_PERSISTED_KEYS.deadlines)
  ) {
    return false;
  }
  try {
    parseOperatorSessionId(value.sessionId);
    parseOperatorId(value.operatorId);
    parseDeviceFamilyId(value.familyId);
    parseKeyedSecretHash(value.secretHash);
    parseAuthKeyringId(value.keyringId);
  } catch {
    return false;
  }
  return (
    isPositiveSafeInteger(value.deviceGeneration) &&
    isInstant(value.issuedAt) &&
    isInstant(value.lastUsedAt) &&
    isInstant(value.deadlines.idleExpiresAt) &&
    isInstant(value.deadlines.absoluteExpiresAt) &&
    isInstant(value.deadlines.renewalExpiresAt) &&
    value.issuedAt <= value.lastUsedAt &&
    value.lastUsedAt <= value.deadlines.idleExpiresAt &&
    value.deadlines.idleExpiresAt <= value.deadlines.absoluteExpiresAt &&
    isWithinPolicyDuration(
      value.lastUsedAt,
      value.deadlines.idleExpiresAt,
      policy.sessionIdleTtlMs
    ) &&
    isWithinPolicyDuration(
      value.issuedAt,
      value.deadlines.absoluteExpiresAt,
      policy.sessionAbsoluteTtlMs
    ) &&
    value.issuedAt <= value.deadlines.renewalExpiresAt &&
    value.deadlines.renewalExpiresAt <= value.deadlines.absoluteExpiresAt &&
    isWithinPolicyDuration(
      value.issuedAt,
      value.deadlines.renewalExpiresAt,
      policy.sessionRenewalTtlMs
    ) &&
    (value.status === 'active' || value.status === 'revoked') &&
    isNullableInstant(value.revokedAt) &&
    isNullableReason(value.revocationReason) &&
    hasCoherentRevocationStatus(value)
  );
}

function isRecoverableResetIntent(value: unknown): value is AuthResetIntent | null {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactlyPersistedKeys(value, AUTHORITY_PERSISTED_KEYS.resetIntent) ||
    !isRecord(value.requestedBinding) ||
    !hasExactlyPersistedKeys(value.requestedBinding, AUTHORITY_PERSISTED_KEYS.binding)
  ) {
    return false;
  }
  try {
    assertAuthorityBinding(value.requestedBinding as unknown as AuthorityBinding);
    if (value.stagedKeyringId !== null) parseAuthKeyringId(value.stagedKeyringId);
    if (value.challengeId !== null) parsePairingChallengeId(value.challengeId);
  } catch {
    return false;
  }
  return (
    isPositiveSafeInteger(value.resetGeneration) &&
    isInstant(value.requestedAt) &&
    [
      'requested',
      'drain_confirmed',
      'key_stage_reserved',
      'new_key_staged',
      'authority_revoked',
      'key_activated',
      'delivery_recovery',
      'challenge_pending',
      'challenge_issued',
    ].includes(String(value.stage)) &&
    (value.drainEvidenceRef === null ||
      (typeof value.drainEvidenceRef === 'string' &&
        value.drainEvidenceRef.length > 0 &&
        value.drainEvidenceRef.length <= 256))
  );
}

function hasConsistentRelationships(
  state: HostedAccessAuthorityState,
  policy: HostedAccessAuthorityPolicy
): boolean {
  const familyIds = new Set(state.deviceFamilies.map(({ familyId }) => familyId));
  const challengeIds = new Set(state.pairingChallenges.map(({ challengeId }) => challengeId));
  const grantsById = new Map(state.deviceGrants.map((grant) => [grant.grantId, grant]));
  const sessionsById = new Map(state.sessions.map((session) => [session.sessionId, session]));
  if (
    familyIds.size !== state.deviceFamilies.length ||
    challengeIds.size !== state.pairingChallenges.length ||
    new Set(state.deviceGrants.map(({ grantId }) => grantId)).size !== state.deviceGrants.length ||
    new Set(state.sessions.map(({ sessionId }) => sessionId)).size !== state.sessions.length
  ) {
    return false;
  }
  for (const challenge of state.pairingChallenges) {
    if (challenge.status !== 'consumed') continue;
    if (
      challenge.pairedDeviceFamilyId === null ||
      challenge.pairedDeviceGrantId === null ||
      challenge.pairedSessionId === null
    ) {
      return false;
    }
    const pairedFamily = state.deviceFamilies.find(
      ({ familyId }) => familyId === challenge.pairedDeviceFamilyId
    );
    const pairedGrant = grantsById.get(challenge.pairedDeviceGrantId);
    const pairedSession = sessionsById.get(challenge.pairedSessionId);
    if (
      pairedFamily === undefined ||
      (pairedGrant !== undefined &&
        (pairedGrant.familyId !== challenge.pairedDeviceFamilyId ||
          pairedGrant.keyringId !== challenge.keyringId)) ||
      (pairedSession !== undefined &&
        (pairedSession.familyId !== challenge.pairedDeviceFamilyId ||
          pairedSession.keyringId !== challenge.keyringId)) ||
      (pairedFamily.status === 'active' &&
        pairedFamily.currentGeneration === 1 &&
        (pairedGrant === undefined || pairedSession === undefined))
    ) {
      return false;
    }
  }
  if (state.deviceFamilies.filter(({ status }) => status === 'active').length > 1) {
    return false;
  }
  if (state.operatorId === null && (state.deviceFamilies.length > 0 || state.sessions.length > 0)) {
    return false;
  }
  const openChallenges = state.pairingChallenges.filter(
    ({ status }) => status === 'pending_delivery' || status === 'issued'
  );
  if (
    openChallenges.length > 1 ||
    openChallenges.some(
      ({ keyringId, resetGeneration }) =>
        keyringId !== state.expectedKeyringId || resetGeneration !== state.consumedResetGeneration
    ) ||
    state.pairingChallenges.some(
      ({ resetGeneration }) => resetGeneration > state.consumedResetGeneration
    )
  ) {
    return false;
  }
  if (
    state.deviceGrants.some(({ familyId }) => !familyIds.has(familyId)) ||
    state.sessions.some(({ familyId }) => !familyIds.has(familyId))
  ) {
    return false;
  }
  for (const family of state.deviceFamilies) {
    if (state.operatorId !== family.operatorId) return false;
    const familyGrants = state.deviceGrants.filter((grant) => grant.familyId === family.familyId);
    if (
      new Set(familyGrants.map(({ generation }) => generation)).size !== familyGrants.length ||
      new Set(familyGrants.map(({ keyringId }) => keyringId)).size > 1
    ) {
      return false;
    }
    const familyKeyringId = familyGrants[0]?.keyringId;
    const current = state.deviceGrants.filter(
      (grant) => grant.familyId === family.familyId && grant.status === 'current'
    );
    const predecessor = familyGrants.filter(({ status }) => status === 'predecessor');
    if (family.status === 'active' && current.length !== 1) return false;
    if (family.status === 'revoked' && current.length !== 0) return false;
    if (predecessor.length > 1) return false;
    if (
      current.length === 1 &&
      (current[0]?.generation !== family.currentGeneration ||
        current[0].keyringId !== state.expectedKeyringId)
    ) {
      return false;
    }
    if (current.length === 1) {
      const source =
        current[0].renewedFromGrantId === null
          ? undefined
          : familyGrants.find(({ grantId }) => grantId === current[0].renewedFromGrantId);
      if (
        (current[0].generation === 1 && current[0].renewedFromGrantId !== null) ||
        (current[0].generation > 1 &&
          (source === undefined ||
            source.generation + 1 !== current[0].generation ||
            (source.status !== 'predecessor' && source.status !== 'retired'))) ||
        (predecessor.length === 1 && predecessor[0].grantId !== source?.grantId)
      ) {
        return false;
      }
    }
    if (
      predecessor.length === 1 &&
      (current.length !== 1 ||
        !isWithinPolicyDuration(
          current[0].issuedAt,
          predecessor[0].predecessorGraceExpiresAt as number,
          policy.predecessorGraceMs
        ))
    ) {
      return false;
    }
    if (
      familyGrants.some(
        (grant) =>
          grant.generation > family.currentGeneration ||
          grant.renewalExpiresAt > family.absoluteExpiresAt ||
          (family.status === 'active' &&
            (grant.status === 'current' || grant.status === 'predecessor') &&
            grant.keyringId !== state.expectedKeyringId)
      )
    ) {
      return false;
    }
    const familySessions = state.sessions.filter((session) => session.familyId === family.familyId);
    if (familySessions.filter(({ status }) => status === 'active').length > 1) {
      return false;
    }
    for (const session of familySessions) {
      if (
        session.operatorId !== family.operatorId ||
        session.deviceGeneration > family.currentGeneration ||
        session.deadlines.absoluteExpiresAt > family.absoluteExpiresAt ||
        familyKeyringId === undefined ||
        session.keyringId !== familyKeyringId
      ) {
        return false;
      }
      if (session.status === 'active') {
        const matchingCurrent = current[0];
        if (
          family.status !== 'active' ||
          session.keyringId !== state.expectedKeyringId ||
          session.deviceGeneration !== family.currentGeneration ||
          matchingCurrent?.generation !== session.deviceGeneration ||
          matchingCurrent.keyringId !== session.keyringId
        ) {
          return false;
        }
      }
    }
  }
  return hasCoherentResetIntent(state, challengeIds);
}

function hasCoherentChallengeStatus(value: Record<string, unknown>): boolean {
  const status = value.status;
  const hasPairingOutcome =
    value.pairedDeviceFamilyId !== null ||
    value.pairedDeviceGrantId !== null ||
    value.pairedSessionId !== null;
  if (status === 'pending_delivery' || status === 'issued') {
    return (
      value.consumedAt === null &&
      value.revokedAt === null &&
      value.revocationReason === null &&
      value.deliveryCleanupPending === false &&
      !hasPairingOutcome &&
      (value.failedAttempts as number) < (value.maxAttempts as number)
    );
  }
  if (status === 'consumed') {
    return (
      isInstant(value.consumedAt) &&
      value.consumedAt >= (value.issuedAt as number) &&
      value.consumedAt < (value.expiresAt as number) &&
      value.revokedAt === null &&
      value.revocationReason === null &&
      value.pairedDeviceFamilyId !== null &&
      value.pairedDeviceGrantId !== null &&
      value.pairedSessionId !== null &&
      (value.failedAttempts as number) < (value.maxAttempts as number)
    );
  }
  if (status === 'revoked') {
    return (
      value.consumedAt === null &&
      isInstant(value.revokedAt) &&
      value.revokedAt >= (value.issuedAt as number) &&
      typeof value.revocationReason === 'string' &&
      !hasPairingOutcome
    );
  }
  return false;
}

function hasCoherentGrantStatus(value: Record<string, unknown>): boolean {
  if (value.status === 'current') {
    return (
      value.predecessorGraceExpiresAt === null &&
      value.predecessorUsesRemaining === 0 &&
      value.retiredAt === null &&
      value.revokedAt === null &&
      value.revocationReason === null
    );
  }
  if (value.status === 'predecessor') {
    return (
      isInstant(value.predecessorGraceExpiresAt) &&
      value.predecessorGraceExpiresAt > (value.issuedAt as number) &&
      value.predecessorGraceExpiresAt <= (value.renewalExpiresAt as number) &&
      isPositiveSafeInteger(value.predecessorUsesRemaining) &&
      value.retiredAt === null &&
      value.revokedAt === null &&
      value.revocationReason === null
    );
  }
  if (value.status === 'retired') {
    return (
      value.predecessorGraceExpiresAt === null &&
      value.predecessorUsesRemaining === 0 &&
      isInstant(value.retiredAt) &&
      value.retiredAt >= (value.issuedAt as number) &&
      value.revokedAt === null &&
      value.revocationReason === null
    );
  }
  return (
    value.status === 'revoked' &&
    value.predecessorGraceExpiresAt === null &&
    value.predecessorUsesRemaining === 0 &&
    isInstant(value.revokedAt) &&
    value.revokedAt >= (value.issuedAt as number) &&
    typeof value.revocationReason === 'string'
  );
}

function hasCoherentResetIntent(
  state: HostedAccessAuthorityState,
  challengeIds: ReadonlySet<PairingChallengeId>
): boolean {
  const intent = state.resetIntent;
  if (intent === null) return true;
  const postRevocation = [
    'authority_revoked',
    'key_activated',
    'delivery_recovery',
    'challenge_pending',
    'challenge_issued',
  ].includes(intent.stage);
  if (
    intent.resetGeneration < state.consumedResetGeneration ||
    (intent.resetGeneration === state.consumedResetGeneration) !== postRevocation
  ) {
    return false;
  }
  const hasDrain = intent.drainEvidenceRef !== null;
  const hasKey = intent.stagedKeyringId !== null;
  const hasChallenge = intent.challengeId !== null;
  switch (intent.stage) {
    case 'requested':
      return !hasDrain && !hasKey && !hasChallenge;
    case 'drain_confirmed':
      return hasDrain && !hasKey && !hasChallenge;
    case 'key_stage_reserved':
    case 'new_key_staged':
      return hasDrain && hasKey && !hasChallenge;
    case 'authority_revoked':
    case 'key_activated':
      return (
        hasDrain &&
        hasKey &&
        !hasChallenge &&
        state.consumedResetGeneration === intent.resetGeneration &&
        bindingsEqual(state.binding, intent.requestedBinding) &&
        state.expectedKeyringId === intent.stagedKeyringId
      );
    case 'delivery_recovery':
      return (
        !hasDrain &&
        hasKey &&
        !hasChallenge &&
        state.consumedResetGeneration === intent.resetGeneration &&
        bindingsEqual(state.binding, intent.requestedBinding) &&
        state.expectedKeyringId === intent.stagedKeyringId
      );
    case 'challenge_pending':
    case 'challenge_issued': {
      const challenge = state.pairingChallenges.find(
        ({ challengeId }) => challengeId === intent.challengeId
      );
      return (
        hasDrain &&
        hasKey &&
        hasChallenge &&
        bindingsEqual(state.binding, intent.requestedBinding) &&
        state.expectedKeyringId === intent.stagedKeyringId &&
        challengeIds.has(intent.challengeId as PairingChallengeId) &&
        challenge?.status === (intent.stage === 'challenge_pending' ? 'pending_delivery' : 'issued')
      );
    }
  }
}
