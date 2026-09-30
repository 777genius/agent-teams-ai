import {
  type DirtyObservationScope,
  type ExternalFileKey,
  type ExternalFileReconciliationId,
  type ExternalFileSourceFingerprint,
  type ExternalObservationActor,
  type ExternalSelfWriteIntent,
  type ExternalWriterScope,
  type FileWriterEpoch,
  type ObservationSequence,
  type ObservedExternalFile,
  type PendingFileObservation,
} from '../../contracts';

export interface FileObservationStateLimits {
  maxPendingObservations: number;
  maxSelfWriteIntents: number;
  maxObservationAttempts: number;
  maxScopes: number;
  maxObservedFiles: number;
}

export type EnqueueObservationOutcome = 'coalesced' | 'enqueued' | 'overflow_dirty';

export type CompletePendingObservationOutcome = 'completed' | 'missing' | 'newer_pending';

export type SelfWriteChecksumMatch =
  | { outcome: 'matched'; intent: ExternalSelfWriteIntent }
  | { outcome: 'mismatch' | 'none'; intent: null };

export class FileObservationStateError extends Error {
  constructor(
    readonly code:
      | 'checkpoint_invalid'
      | 'epoch_not_quiescent'
      | 'epoch_stale'
      | 'limit_invalid'
      | 'sequence_exhausted'
      | 'self_write_limit_exceeded'
      | 'tracked_state_limit_exceeded'
  ) {
    super(`external-writer-observation-state:${code}`);
    this.name = 'FileObservationStateError';
  }
}

export const cloneScope = (scope: ExternalWriterScope): ExternalWriterScope => ({ ...scope });

export const scopeKey = (scope: ExternalWriterScope): string =>
  `${scope.teamId.length}:${scope.teamId}${scope.featureKey.length}:${scope.featureKey}`;

export const fileKey = (scope: ExternalWriterScope, registeredFileKey: ExternalFileKey): string =>
  `${scopeKey(scope)}${registeredFileKey.length}:${registeredFileKey}`;

export const scopesEqual = (left: ExternalWriterScope, right: ExternalWriterScope): boolean =>
  left.teamId === right.teamId && left.featureKey === right.featureKey;

export const isSafeNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export const isSafePositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

export const MAX_STATE_STRING_LENGTH = 1_024;
const MAX_RECONCILIATION_ID_LENGTH = 4 * MAX_STATE_STRING_LENGTH + 128;

export const buildExternalFileReconciliationId = (
  scope: ExternalWriterScope,
  registeredFileKey: ExternalFileKey,
  fileWriterEpoch: FileWriterEpoch,
  earliestSequence: ObservationSequence
): ExternalFileReconciliationId => {
  const canonicalFileIdentity = fileKey(scope, registeredFileKey);
  return [
    'external-writer-reconciliation',
    'v2',
    canonicalFileIdentity.length,
    canonicalFileIdentity,
    fileWriterEpoch,
    earliestSequence,
  ].join(':');
};

export const assertNonEmpty = (value: string): void => {
  if (value.length === 0 || value.length > MAX_STATE_STRING_LENGTH) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
};

export const assertReconciliationId = (value: string): void => {
  if (value.length === 0 || value.length > MAX_RECONCILIATION_ID_LENGTH) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
};

export const assertScope = (scope: ExternalWriterScope): void => {
  assertNonEmpty(scope.teamId);
  assertNonEmpty(scope.featureKey);
};

export const assertFingerprint = (fingerprint: ExternalFileSourceFingerprint): void => {
  if (!fingerprint.exists) {
    if (fingerprint.checksum !== null || fingerprint.statIdentity !== null) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    return;
  }
  const identity = fingerprint.statIdentity;
  if (
    !fingerprint.checksum ||
    fingerprint.checksum.length > MAX_STATE_STRING_LENGTH ||
    !identity ||
    !isSafeNonNegativeInteger(identity.byteLength) ||
    identity.device.length === 0 ||
    identity.device.length > MAX_STATE_STRING_LENGTH ||
    identity.inode.length === 0 ||
    identity.inode.length > MAX_STATE_STRING_LENGTH ||
    identity.modifiedTimeNs.length === 0 ||
    identity.modifiedTimeNs.length > MAX_STATE_STRING_LENGTH ||
    identity.changedTimeNs.length === 0 ||
    identity.changedTimeNs.length > MAX_STATE_STRING_LENGTH
  ) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
};

export const copyPending = (pending: PendingFileObservation): PendingFileObservation => ({
  ...pending,
  scope: cloneScope(pending.scope),
  reconciliation: pending.reconciliation
    ? {
        ...pending.reconciliation,
        fingerprint: {
          ...pending.reconciliation.fingerprint,
          statIdentity: pending.reconciliation.fingerprint.statIdentity
            ? { ...pending.reconciliation.fingerprint.statIdentity }
            : null,
        },
        actor: { ...pending.reconciliation.actor },
      }
    : null,
});

export const copyDirty = (dirty: DirtyObservationScope): DirtyObservationScope => ({
  ...dirty,
  scope: cloneScope(dirty.scope),
  reasons: [...dirty.reasons],
});

export const copyIntent = (intent: ExternalSelfWriteIntent): ExternalSelfWriteIntent => ({
  ...intent,
  scope: cloneScope(intent.scope),
});

export const copyObserved = (observed: ObservedExternalFile): ObservedExternalFile => ({
  ...observed,
  scope: cloneScope(observed.scope),
  fingerprint: {
    ...observed.fingerprint,
    statIdentity: observed.fingerprint.statIdentity
      ? { ...observed.fingerprint.statIdentity }
      : null,
  },
});

export function assertPendingObservation(input: {
  readonly pending: PendingFileObservation;
  readonly lastObservationSequence: ObservationSequence;
  readonly observationWatermark: ObservationSequence;
  readonly limits: FileObservationStateLimits;
}): void {
  const { pending } = input;
  assertScope(pending.scope);
  assertNonEmpty(pending.fileKey);
  if (
    pending.id !== fileKey(pending.scope, pending.fileKey) ||
    !isSafePositiveInteger(pending.earliestSequence) ||
    !isSafePositiveInteger(pending.latestSequence) ||
    pending.earliestSequence > pending.latestSequence ||
    pending.latestSequence > input.lastObservationSequence ||
    pending.earliestSequence <= input.observationWatermark ||
    !isSafePositiveInteger(pending.fileWriterEpoch) ||
    !isSafeNonNegativeInteger(pending.attempts) ||
    pending.attempts > input.limits.maxObservationAttempts ||
    (pending.attempts === input.limits.maxObservationAttempts && pending.reconciliation === null) ||
    (pending.reconciliation !== null &&
      (pending.reconciliation.throughSequence < pending.earliestSequence ||
        pending.reconciliation.throughSequence > pending.latestSequence))
  ) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
  if (pending.reconciliation) {
    assertReconciliationId(pending.reconciliation.reconciliationId);
    assertFingerprint(pending.reconciliation.fingerprint);
    assertObservationActor(pending.reconciliation.actor, pending.scope);
    if (
      pending.reconciliation.reconciliationId !==
        buildExternalFileReconciliationId(
          pending.scope,
          pending.fileKey,
          pending.fileWriterEpoch,
          pending.earliestSequence
        ) ||
      (pending.reconciliation.actor.kind === 'external_file' &&
        (pending.reconciliation.actor.observationSequence !==
          pending.reconciliation.throughSequence ||
          pending.reconciliation.actor.fileKey !== pending.fileKey ||
          pending.reconciliation.actor.checksum !== pending.reconciliation.fingerprint.checksum))
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
  }
}

export function assertDirtyObservation(
  dirty: DirtyObservationScope,
  lastObservationSequence: ObservationSequence,
  observationWatermark: ObservationSequence
): void {
  assertScope(dirty.scope);
  if (
    dirty.reasons.length === 0 ||
    new Set(dirty.reasons).size !== dirty.reasons.length ||
    !isSafePositiveInteger(dirty.earliestSequence) ||
    !isSafePositiveInteger(dirty.latestSequence) ||
    dirty.earliestSequence > dirty.latestSequence ||
    dirty.latestSequence > lastObservationSequence ||
    dirty.earliestSequence <= observationWatermark
  ) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
}

export function assertObservationActor(
  actor: ExternalObservationActor,
  scope: ExternalWriterScope
): void {
  if (actor.teamId !== scope.teamId) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
  if (actor.kind === 'external_file') {
    assertNonEmpty(actor.featureKey);
    assertNonEmpty(actor.fileKey);
    if (
      actor.featureKey !== scope.featureKey ||
      !isSafePositiveInteger(actor.observationSequence) ||
      (actor.checksum !== null &&
        (actor.checksum.length === 0 || actor.checksum.length > MAX_STATE_STRING_LENGTH))
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    return;
  }
  if (
    actor.kind !== 'verified_run' ||
    actor.runId.length === 0 ||
    actor.runId.length > MAX_STATE_STRING_LENGTH ||
    !isSafePositiveInteger(actor.runGeneration) ||
    (actor.memberId !== null &&
      (actor.memberId.length === 0 || actor.memberId.length > MAX_STATE_STRING_LENGTH)) ||
    actor.evidenceRef.length === 0 ||
    actor.evidenceRef.length > MAX_STATE_STRING_LENGTH
  ) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
}
