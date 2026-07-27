import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  type CommandClaimRecord,
  commitDurableCommand,
  createDurableCommandDescriptorIdentity,
  createInitialEffectPlan,
  type DurableApplicationCommandEffectRecord,
  transitionDurableCommandState,
  transitionDurableEffectState,
} from '@features/application-command-ledger';

import {
  isRuntimeIngressCredentialRecoverable,
  isRuntimeIngressSessionStateRecoverable,
  type RuntimeIngressAuthority,
  type RuntimeIngressCredential,
  type RuntimeIngressCredentialId,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressSessionId,
  type RuntimeIngressSessionState,
  type RuntimeIngressVerb,
} from '../../../../core/domain/runtime-ingress';

import type { RuntimePlanRef } from '../../../../core/application/ports';
import type {
  ApplyRuntimeIngressAtomicallyRequest,
  RuntimeIngressAntiRollbackCheckpoint,
  RuntimeIngressCredentialGenerationFence,
  RuntimeIngressDurableCommandRecord,
  RuntimeIngressDurableEffectEvidence,
} from '../../../../core/application/runtime-ingress';

export interface PersistedRuntimeIngressEffect {
  readonly claimKey: string;
  readonly authority: RuntimeIngressAuthority;
  readonly acknowledgementId: string;
  readonly payloadJson: string;
  readonly appliedAtIso: string;
}

export interface PersistedRuntimeIngressPlanBinding {
  readonly credentialId: RuntimeIngressCredentialId;
  readonly planRef: RuntimePlanRef;
}

export interface RuntimeIngressReplayCompactionEvidence {
  readonly evidenceVersion: 1;
  readonly compactedCommandCount: number;
  readonly chainRoot: string;
  readonly retainedCommands: readonly RuntimeIngressDurableCommandRecord[];
}

export interface RuntimeIngressSnapshot {
  readonly snapshotVersion: 1;
  readonly generation: number;
  readonly credentials: readonly RuntimeIngressCredential[];
  readonly sessions: readonly RuntimeIngressSessionState[];
  readonly planBindings: readonly PersistedRuntimeIngressPlanBinding[];
  readonly credentialGenerationFences: readonly RuntimeIngressCredentialGenerationFence[];
  readonly commands: readonly RuntimeIngressDurableCommandRecord[];
  readonly effects: readonly PersistedRuntimeIngressEffect[];
  readonly replayCompaction: RuntimeIngressReplayCompactionEvidence;
}

export interface RuntimeIngressSnapshotAuthentication {
  readonly algorithm: 'hmac-sha256';
  readonly keyVersion: string;
  readonly mac: string;
}

export interface RuntimeIngressSnapshotFile extends RuntimeIngressSnapshot {
  readonly authentication: RuntimeIngressSnapshotAuthentication;
}

export interface RuntimeIngressSnapshotRetentionLimits {
  readonly maxCredentials: number;
  readonly maxSessions: number;
  readonly maxCommands: number;
  readonly maxEffects: number;
  readonly maxCompactedCommands: number;
}

export function splitSnapshotFile(value: unknown): {
  readonly snapshot: RuntimeIngressSnapshot;
  readonly authentication: RuntimeIngressSnapshotAuthentication;
} {
  const keys = [
    'snapshotVersion',
    'generation',
    'credentials',
    'sessions',
    'planBindings',
    'credentialGenerationFences',
    'commands',
    'effects',
    'replayCompaction',
    'authentication',
  ] as const;
  if (!hasExactRecordKeys(value, keys) || !isRecord(value.authentication)) {
    throw new Error('runtime-ingress-snapshot-envelope-invalid');
  }
  const authentication = value.authentication;
  if (
    !hasExactRecordKeys(authentication, ['algorithm', 'keyVersion', 'mac'] as const) ||
    authentication.algorithm !== 'hmac-sha256' ||
    typeof authentication.keyVersion !== 'string' ||
    authentication.keyVersion.length < 1 ||
    authentication.keyVersion.length > 128 ||
    typeof authentication.mac !== 'string' ||
    !/^[a-f0-9]{64}$/.test(authentication.mac)
  ) {
    throw new Error('runtime-ingress-snapshot-authentication-invalid');
  }
  return {
    snapshot: {
      snapshotVersion: value.snapshotVersion as 1,
      generation: value.generation as number,
      credentials: value.credentials as RuntimeIngressSnapshot['credentials'],
      sessions: value.sessions as RuntimeIngressSnapshot['sessions'],
      planBindings: value.planBindings as RuntimeIngressSnapshot['planBindings'],
      credentialGenerationFences:
        value.credentialGenerationFences as RuntimeIngressSnapshot['credentialGenerationFences'],
      commands: value.commands as RuntimeIngressSnapshot['commands'],
      effects: value.effects as RuntimeIngressSnapshot['effects'],
      replayCompaction: value.replayCompaction as RuntimeIngressSnapshot['replayCompaction'],
    },
    authentication: authentication as unknown as RuntimeIngressSnapshotAuthentication,
  };
}

export function assertSnapshotRetention(
  snapshot: RuntimeIngressSnapshot,
  limits: RuntimeIngressSnapshotRetentionLimits
): void {
  if (
    snapshot.credentials.length > limits.maxCredentials ||
    snapshot.sessions.length > limits.maxSessions ||
    snapshot.planBindings.length > limits.maxCredentials ||
    snapshot.credentialGenerationFences.length > limits.maxCredentials ||
    snapshot.commands.length > limits.maxCommands ||
    snapshot.effects.length > limits.maxEffects ||
    snapshot.replayCompaction.retainedCommands.length > limits.maxCompactedCommands
  ) {
    throw new Error('runtime-ingress-snapshot-retention-limit');
  }
}

export function assertRuntimeIngressStoreLimits(
  limits: RuntimeIngressSnapshotRetentionLimits & {
    readonly maxSnapshotBytes: number;
    readonly lockAcquireTimeoutMs: number;
    readonly lockRetryDelayMs: number;
  },
  hardMaximumSnapshotBytes: number
): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('runtime-ingress-store-limits-invalid');
    }
  }
  if (
    limits.maxSnapshotBytes > hardMaximumSnapshotBytes ||
    limits.lockRetryDelayMs > limits.lockAcquireTimeoutMs
  ) {
    throw new TypeError('runtime-ingress-store-limits-invalid');
  }
}

export function createCommittedCommand(
  request: ApplyRuntimeIngressAtomicallyRequest
): RuntimeIngressDurableCommandRecord {
  const acceptedAt = request.acknowledgement.acceptedAtIso;
  const durableCommandId = request.acknowledgement.replayKey.commandId;
  const transaction = Object.freeze({
    generation: 1,
    attemptId: `attempt:${durableCommandId}`,
  });
  const initialPlan = createInitialEffectPlan(request.descriptor);
  const running = transitionDurableCommandState('prepared', 'running');
  const attempting = transitionDurableEffectState(
    request.descriptor.effects[0],
    initialPlan[0].state,
    'attempting'
  );
  const observedSucceeded = transitionDurableEffectState(
    request.descriptor.effects[0],
    attempting,
    'observed_succeeded'
  );
  const committedPlan = [{ ...initialPlan[0], state: observedSucceeded }] as const;
  const descriptorIdentity = createDurableCommandDescriptorIdentity(request.descriptor);
  const committed = commitDurableCommand(
    running,
    request.descriptor,
    descriptorIdentity,
    committedPlan
  );
  const effects: readonly DurableApplicationCommandEffectRecord[] = Object.freeze([
    Object.freeze({
      ...committedPlan[0],
      updatedAt: acceptedAt,
      evidence: Object.freeze([
        Object.freeze({
          ...request.descriptor.effects[0],
          outcome: 'observed_succeeded' as const,
          sequence: 1,
          evidenceJson: JSON.stringify({
            evidenceVersion: 1,
            durableCommandId,
            acknowledgementId: request.acknowledgement.acknowledgementId,
            effectRef: request.acknowledgement.effectRef,
            replayKey: request.acknowledgement.replayKey,
            claimScope: request.claimScope,
            fingerprint: request.fingerprint,
            transaction,
            effect: {
              effectId: committedPlan[0].effectId,
              effectVersion: committedPlan[0].effectVersion,
              recoveryClass: committedPlan[0].recoveryClass,
              evidenceSchemaVersion: committedPlan[0].evidenceSchemaVersion,
              ordinal: committedPlan[0].ordinal,
            },
            acceptedAtIso: acceptedAt,
          } satisfies RuntimeIngressDurableEffectEvidence),
          recordedAt: acceptedAt,
        }),
      ]),
    }),
  ]);
  const claim: CommandClaimRecord<RuntimeIngressVerb> = {
    scope: request.claimScope,
    fingerprint: request.fingerprint,
  };
  return Object.freeze({
    commandId: durableCommandId,
    claim,
    descriptor: descriptorIdentity,
    attempt: Object.freeze({
      generation: transaction.generation,
      attemptId: transaction.attemptId,
      ownerId: 'runtime-ingress-store',
      leaseToken: `transaction:${request.acknowledgement.acknowledgementId}`,
      claimedAt: acceptedAt,
      leaseExpiresAt: acceptedAt,
    }),
    state: committed,
    retentionClass: request.descriptor.retentionClass,
    auditSessionId: request.acknowledgement.replayKey.sessionId,
    outcomeJson: JSON.stringify(request.acknowledgement),
    errorCode: null,
    errorJson: null,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    committedAt: acceptedAt,
    effects,
  });
}

export function isValidAtomicTransition(request: ApplyRuntimeIngressAtomicallyRequest): boolean {
  const accepted = request.nextSession.acceptedVerbs.find(
    (state) => state.verb === request.acknowledgement.replayKey.authority.verb
  );
  return (
    isRuntimeIngressSessionStateRecoverable(request.nextSession) &&
    request.nextSession.revision === request.expectedSession.revision + 1 &&
    request.nextSession.lastAcceptedSequence === request.acknowledgement.replayKey.sequence &&
    request.nextSession.credentialId === request.expectedCredential.credentialId &&
    request.nextSession.sessionId === request.acknowledgement.replayKey.sessionId &&
    request.nextSession.deliveryOwnerId === request.acknowledgement.replayKey.deliveryOwnerId &&
    request.acknowledgement.replayKey.sessionId === request.expectedSession.sessionId &&
    accepted?.lastCommandId === request.acknowledgement.replayKey.commandId &&
    accepted.lastAcknowledgement === request.acknowledgement
  );
}

export function doesFingerprintMatchDescriptor(
  request: ApplyRuntimeIngressAtomicallyRequest
): boolean {
  return (
    request.descriptor.commandKind === request.claimScope.commandKind &&
    request.descriptor.descriptorId === request.fingerprint.descriptorId &&
    request.descriptor.descriptorVersion === request.fingerprint.descriptorVersion &&
    request.descriptor.inputSchemaVersion === request.fingerprint.schemaVersion &&
    request.descriptor.fingerprintVersion === request.fingerprint.fingerprintVersion &&
    request.descriptor.effectPlanVersion === request.fingerprint.effectPlanVersion
  );
}

export function validateSnapshot(value: unknown): RuntimeIngressSnapshot {
  if (
    !isRecord(value) ||
    value.snapshotVersion !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !Array.isArray(value.credentials) ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.planBindings) ||
    !Array.isArray(value.credentialGenerationFences) ||
    !Array.isArray(value.commands) ||
    !Array.isArray(value.effects) ||
    !isReplayCompactionEvidence(value.replayCompaction)
  ) {
    throw new Error('runtime-ingress-snapshot-invalid');
  }
  if (
    !value.credentials.every(isRuntimeIngressCredentialRecoverable) ||
    !value.sessions.every(isRuntimeIngressSessionStateRecoverable) ||
    !value.planBindings.every(isPlanBinding) ||
    !value.credentialGenerationFences.every(isCredentialGenerationFence) ||
    !value.commands.every(isRecord) ||
    !value.effects.every(isPersistedEffect)
  ) {
    throw new Error('runtime-ingress-snapshot-corrupt');
  }
  const snapshot = value as unknown as RuntimeIngressSnapshot;
  if (
    hasDuplicate(snapshot.credentials, (item) => item.credentialId) ||
    hasDuplicate(snapshot.sessions, (item) => item.sessionId) ||
    hasDuplicate(snapshot.planBindings, (item) => item.credentialId) ||
    hasDuplicate(snapshot.credentialGenerationFences, credentialGenerationFenceKey) ||
    hasDuplicate([...snapshot.commands, ...snapshot.replayCompaction.retainedCommands], (item) =>
      commandClaimKey(item.claim.scope)
    ) ||
    hasDuplicate(snapshot.effects, (item) => item.claimKey)
  ) {
    throw new Error('runtime-ingress-snapshot-duplicate');
  }
  const credentialIds = new Set(snapshot.credentials.map((credential) => credential.credentialId));
  if (
    snapshot.planBindings.length !== snapshot.credentials.length ||
    snapshot.planBindings.some((binding) => !credentialIds.has(binding.credentialId)) ||
    snapshot.commands.length !== snapshot.effects.length ||
    snapshot.commands.some(
      (command) =>
        !snapshot.effects.some((effect) => effect.claimKey === commandClaimKey(command.claim.scope))
    )
  ) {
    throw new Error('runtime-ingress-snapshot-relational-integrity');
  }
  return snapshot;
}

export function emptySnapshot(): RuntimeIngressSnapshot {
  return {
    snapshotVersion: 1,
    generation: 0,
    credentials: [],
    sessions: [],
    planBindings: [],
    credentialGenerationFences: [],
    commands: [],
    effects: [],
    replayCompaction: {
      evidenceVersion: 1,
      compactedCommandCount: 0,
      chainRoot: `sha256:${'0'.repeat(64)}`,
      retainedCommands: [],
    },
  };
}

export function findPlanBinding(
  snapshot: RuntimeIngressSnapshot,
  credentialId: RuntimeIngressCredentialId
): PersistedRuntimeIngressPlanBinding | undefined {
  return snapshot.planBindings.find((binding) => binding.credentialId === credentialId);
}

export function upsertCredentialGenerationFence(
  fences: readonly RuntimeIngressCredentialGenerationFence[],
  credential: RuntimeIngressCredential,
  planRef: RuntimePlanRef
): RuntimeIngressCredentialGenerationFence[] {
  const key = credentialGenerationFenceKeyFromScope(credential.scope);
  const previous = fences.find((fence) => credentialGenerationFenceKey(fence) === key);
  const generation = credential.scope.credentialGeneration;
  if (
    planRef.teamId !== credential.scope.teamId ||
    planRef.runId !== credential.scope.runId ||
    planRef.generation !== credential.scope.planGeneration ||
    (previous && previous.planHash !== planRef.planHash)
  ) {
    throw new TypeError('runtime-ingress-credential-generation-plan-invalid');
  }
  const next: RuntimeIngressCredentialGenerationFence = Object.freeze({
    deploymentId: credential.scope.deploymentId,
    teamId: credential.scope.teamId,
    runId: credential.scope.runId,
    planGeneration: credential.scope.planGeneration,
    planHash: planRef.planHash,
    laneId: credential.scope.laneId,
    providerId: credential.scope.providerId,
    highestIssuedGeneration: Math.max(previous?.highestIssuedGeneration ?? 0, generation),
    revokedThroughGeneration:
      credential.phase === 'revoked'
        ? Math.max(previous?.revokedThroughGeneration ?? 0, generation)
        : (previous?.revokedThroughGeneration ?? 0),
    activeGeneration: credential.phase === 'active' ? generation : null,
  });
  return replaceById(fences, key, next, credentialGenerationFenceKey);
}

export function retainActiveCredentialGenerationFences(
  snapshot: RuntimeIngressSnapshot
): RuntimeIngressSnapshot {
  return {
    ...snapshot,
    credentialGenerationFences: snapshot.credentialGenerationFences.filter(
      (fence) => fence.activeGeneration !== null
    ),
  };
}

export function compactRuntimeIngressSnapshot(
  snapshot: RuntimeIngressSnapshot,
  limits: RuntimeIngressSnapshotRetentionLimits,
  digest: (canonicalEvidence: string) => string,
  fits: (candidate: RuntimeIngressSnapshot) => boolean = () => true
): RuntimeIngressSnapshot {
  let credentials = [...snapshot.credentials];
  let sessions = [...snapshot.sessions];
  let planBindings = [...snapshot.planBindings];
  let credentialGenerationFences = [...snapshot.credentialGenerationFences];
  const evictOldestRevokedCredential = (): boolean => {
    const removable = credentials.find((credential) => credential.phase === 'revoked');
    if (!removable) return false;
    credentials = credentials.filter(({ credentialId }) => credentialId !== removable.credentialId);
    sessions = sessions.filter((session) => session.sessionId !== removable.sessionId);
    planBindings = planBindings.filter(
      ({ credentialId }) => credentialId !== removable.credentialId
    );
    const fenceKeys = new Set(
      credentials.map((credential) => credentialGenerationFenceKeyFromScope(credential.scope))
    );
    credentialGenerationFences = credentialGenerationFences.filter((fence) =>
      fenceKeys.has(credentialGenerationFenceKey(fence))
    );
    return true;
  };
  while (credentials.length > limits.maxCredentials || sessions.length > limits.maxSessions) {
    if (!evictOldestRevokedCredential()) throw new Error('runtime-ingress-active-retention-limit');
  }

  const target = Math.min(limits.maxCommands, limits.maxEffects);
  const commands = [...snapshot.commands];
  const effects = [...snapshot.effects];
  const replayRetentionStart = -limits.maxCompactedCommands;
  let replayCompaction: RuntimeIngressReplayCompactionEvidence = {
    ...snapshot.replayCompaction,
    retainedCommands: snapshot.replayCompaction.retainedCommands.slice(replayRetentionStart),
  };
  const compactOldestCommand = (): void => {
    const command = commands.shift();
    if (!command) throw new Error('runtime-ingress-compaction-command-missing');
    const claimKey = commandClaimKey(command.claim.scope);
    const effectIndex = effects.findIndex((effect) => effect.claimKey === claimKey);
    if (effectIndex < 0) throw new Error('runtime-ingress-compaction-effect-missing');
    const [effect] = effects.splice(effectIndex, 1);
    const previousChainRoot = replayCompaction.chainRoot;
    replayCompaction = {
      ...replayCompaction,
      compactedCommandCount: replayCompaction.compactedCommandCount + 1,
      chainRoot: digest(stableCanonicalJson({ previousChainRoot, command, effect })),
      retainedCommands: [...replayCompaction.retainedCommands, command].slice(replayRetentionStart),
    };
  };
  while (commands.length > target) compactOldestCommand();
  const buildCandidate = (): RuntimeIngressSnapshot => ({
    ...snapshot,
    credentials,
    sessions,
    planBindings,
    credentialGenerationFences,
    commands,
    effects,
    replayCompaction,
  });
  while (!fits(buildCandidate())) {
    if (replayCompaction.retainedCommands.length > 0) {
      replayCompaction = {
        ...replayCompaction,
        retainedCommands: replayCompaction.retainedCommands.slice(1),
      };
    } else if (commands.length > 1) {
      compactOldestCommand();
    } else if (!evictOldestRevokedCredential()) {
      throw new Error('runtime-ingress-snapshot-size-limit');
    }
  }
  return buildCandidate();
}

export function findCredential(
  snapshot: RuntimeIngressSnapshot,
  credentialId: RuntimeIngressCredentialId
): RuntimeIngressCredential | undefined {
  return snapshot.credentials.find((item) => item.credentialId === credentialId);
}

export function findSession(
  snapshot: RuntimeIngressSnapshot,
  sessionId: RuntimeIngressSessionId
): RuntimeIngressSessionState | undefined {
  return snapshot.sessions.find((item) => item.sessionId === sessionId);
}

export function findCommand(
  snapshot: RuntimeIngressSnapshot,
  claimKey: string
): RuntimeIngressDurableCommandRecord | undefined {
  return [...snapshot.commands, ...snapshot.replayCompaction.retainedCommands].find(
    (item) => commandClaimKey(item.claim.scope) === claimKey
  );
}

export function commandClaimKey(
  scope: RuntimeIngressDurableCommandRecord['claim']['scope']
): string {
  return JSON.stringify([
    scope.deploymentId,
    scope.stableActorId,
    scope.commandKind,
    scope.idempotencyKey,
  ]);
}

export function hasActiveLaneCredential(
  snapshot: RuntimeIngressSnapshot,
  scope: RuntimeIngressCredentialScope
): boolean {
  return snapshot.credentials.some(
    (credential) =>
      credential.phase === 'active' &&
      credential.scope.deploymentId === scope.deploymentId &&
      credential.scope.teamId === scope.teamId &&
      credential.scope.laneId === scope.laneId &&
      credential.scope.providerId === scope.providerId
  );
}

export function isValidRotationScope(
  previous: RuntimeIngressCredentialScope,
  next: RuntimeIngressCredentialScope
): boolean {
  return (
    previous.deploymentId === next.deploymentId &&
    previous.teamId === next.teamId &&
    previous.runId === next.runId &&
    previous.planGeneration === next.planGeneration &&
    previous.laneId === next.laneId &&
    previous.providerId === next.providerId &&
    next.credentialGeneration === previous.credentialGeneration + 1
  );
}

export function areVerbSetsExact(
  left: readonly RuntimeIngressVerb[],
  right: readonly RuntimeIngressVerb[]
): boolean {
  return (
    left.length === right.length &&
    left.every((verb) => right.includes(verb)) &&
    right.every((verb) => left.includes(verb))
  );
}

export function replaceById<T, K>(
  items: readonly T[],
  id: K,
  replacement: T,
  selectId: (item: T) => K
): T[] {
  let replaced = false;
  const next = items.map((item) => {
    if (selectId(item) !== id) return item;
    replaced = true;
    return replacement;
  });
  return replaced ? next : [...next, replacement];
}

export function replaceOrRemoveSession(
  sessions: readonly RuntimeIngressSessionState[],
  sessionId: RuntimeIngressSessionId,
  replacement: RuntimeIngressSessionState | null
): RuntimeIngressSessionState[] {
  return sessions.flatMap((session) =>
    session.sessionId !== sessionId ? [session] : replacement ? [replacement] : []
  );
}

export function areSessionsExact(
  left: RuntimeIngressSessionState,
  right: RuntimeIngressSessionState
): boolean {
  return stableCanonicalJson(left) === stableCanonicalJson(right);
}

/**
 * Produces deterministic JSON without assigning attacker-selected keys onto
 * Object.prototype-backed objects. In particular, "__proto__" remains an
 * ordinary own JSON key and cannot mutate the canonicalizer's prototype.
 */
export function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonPrototypeSafe(value));
}

function sortJsonPrototypeSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonPrototypeSafe);
  if (!isRecord(value)) return value;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: sortJsonPrototypeSafe(value[key]),
    });
  }
  return sorted;
}

function isPersistedEffect(value: unknown): value is PersistedRuntimeIngressEffect {
  return (
    isRecord(value) &&
    typeof value.claimKey === 'string' &&
    isRecord(value.authority) &&
    typeof value.acknowledgementId === 'string' &&
    typeof value.payloadJson === 'string' &&
    typeof value.appliedAtIso === 'string'
  );
}

function isPlanBinding(value: unknown): value is PersistedRuntimeIngressPlanBinding {
  return (
    isRecord(value) &&
    typeof value.credentialId === 'string' &&
    isRecord(value.planRef) &&
    typeof value.planRef.teamId === 'string' &&
    typeof value.planRef.runId === 'string' &&
    Number.isSafeInteger(value.planRef.generation) &&
    (value.planRef.generation as number) > 0 &&
    typeof value.planRef.planHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.planRef.planHash)
  );
}

function isCredentialGenerationFence(
  value: unknown
): value is RuntimeIngressCredentialGenerationFence {
  return (
    isRecord(value) &&
    typeof value.deploymentId === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.runId === 'string' &&
    Number.isSafeInteger(value.planGeneration) &&
    (value.planGeneration as number) > 0 &&
    typeof value.planHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.planHash) &&
    typeof value.laneId === 'string' &&
    typeof value.providerId === 'string' &&
    Number.isSafeInteger(value.highestIssuedGeneration) &&
    (value.highestIssuedGeneration as number) > 0 &&
    Number.isSafeInteger(value.revokedThroughGeneration) &&
    (value.revokedThroughGeneration as number) >= 0 &&
    (value.activeGeneration === null ||
      (Number.isSafeInteger(value.activeGeneration) &&
        (value.activeGeneration as number) > (value.revokedThroughGeneration as number))) &&
    (value.revokedThroughGeneration as number) <= (value.highestIssuedGeneration as number) &&
    (value.activeGeneration === null ||
      value.activeGeneration === (value.highestIssuedGeneration as number))
  );
}

function isReplayCompactionEvidence(
  value: unknown
): value is RuntimeIngressReplayCompactionEvidence {
  return (
    isRecord(value) &&
    value.evidenceVersion === 1 &&
    Number.isSafeInteger(value.compactedCommandCount) &&
    (value.compactedCommandCount as number) >= 0 &&
    typeof value.chainRoot === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.chainRoot) &&
    Array.isArray(value.retainedCommands) &&
    value.retainedCommands.every(isRecord) &&
    value.retainedCommands.length <= (value.compactedCommandCount as number)
  );
}
export function credentialGenerationFenceKey(
  fence: RuntimeIngressCredentialGenerationFence
): string {
  return credentialGenerationFenceKeyFromScope(fence);
}
export function copyCredentialDigestKeys(
  source: readonly { readonly version: number; readonly key: Uint8Array }[],
  target: Map<number, Uint8Array>
): void {
  for (const item of source) {
    if (!Number.isSafeInteger(item.version) || item.version < 1 || target.has(item.version)) {
      throw new TypeError('runtime-ingress-credential-keyring-invalid');
    }
    target.set(item.version, copyKey(item.key));
  }
}
export function copyFingerprintKeys(
  source: readonly { readonly version: string; readonly key: Uint8Array }[],
  target: Map<string, Uint8Array>
): void {
  for (const item of source) {
    if (!item.version || item.version.length > 128 || target.has(item.version)) {
      throw new TypeError('runtime-ingress-fingerprint-keyring-invalid');
    }
    target.set(item.version, copyKey(item.key));
  }
}
export function hmacHex(key: Uint8Array, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
export function sha256Hex(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
export function toAntiRollbackCheckpoint(
  snapshot: RuntimeIngressSnapshot
): RuntimeIngressAntiRollbackCheckpoint {
  return Object.freeze({
    checkpointVersion: 1,
    snapshotGeneration: snapshot.generation,
    credentialGenerationFences: Object.freeze(
      [...snapshot.credentialGenerationFences].sort((left, right) =>
        credentialGenerationFenceKey(left).localeCompare(credentialGenerationFenceKey(right))
      )
    ),
  });
}
export function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
function copyKey(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 32) {
    throw new TypeError('runtime-ingress-key-material-invalid');
  }
  return new Uint8Array(value);
}
function credentialGenerationFenceKeyFromScope(
  scope: Pick<
    RuntimeIngressCredentialScope,
    'deploymentId' | 'teamId' | 'runId' | 'planGeneration' | 'laneId' | 'providerId'
  >
): string {
  return JSON.stringify([
    scope.deploymentId,
    scope.teamId,
    scope.runId,
    scope.planGeneration,
    scope.laneId,
    scope.providerId,
  ]);
}
function hasDuplicate<T>(items: readonly T[], select: (item: T) => string): boolean {
  const values = new Set<string>();
  for (const item of items) {
    const value = select(item);
    if (values.has(value)) return true;
    values.add(value);
  }
  return false;
}
function hasExactRecordKeys<T extends readonly string[]>(
  value: unknown,
  keys: T
): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
export function isInvalidInputError(error: unknown): boolean {
  return error instanceof TypeError;
}
export function isRuntimePlanRefExact(left: RuntimePlanRef, right: RuntimePlanRef): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.planHash === right.planHash
  );
}
