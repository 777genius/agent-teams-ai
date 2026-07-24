import {
  type DirtyObservationScope,
  EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION,
  type ExternalContentChecksum,
  type ExternalFileKey,
  type ExternalFileReconciliationId,
  type ExternalFileSourceFingerprint,
  type ExternalObservationActor,
  type ExternalObservationCause,
  type ExternalSelfWriteIntent,
  type ExternalWriterDirtyReason,
  type ExternalWriterScope,
  type FileObservationStateCheckpoint,
  type FileWriterEpoch,
  type ObservationSequence,
  type ObservedExternalFile,
  type PendingFileObservation,
  type PendingFileReconciliation,
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

const cloneScope = (scope: ExternalWriterScope): ExternalWriterScope => ({ ...scope });

const scopeKey = (scope: ExternalWriterScope): string =>
  `${scope.teamId.length}:${scope.teamId}${scope.featureKey.length}:${scope.featureKey}`;

const fileKey = (scope: ExternalWriterScope, registeredFileKey: ExternalFileKey): string =>
  `${scopeKey(scope)}${registeredFileKey.length}:${registeredFileKey}`;

const scopesEqual = (left: ExternalWriterScope, right: ExternalWriterScope): boolean =>
  left.teamId === right.teamId && left.featureKey === right.featureKey;

const isSafeNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const isSafePositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const MAX_STATE_STRING_LENGTH = 1_024;
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

const assertNonEmpty = (value: string): void => {
  if (value.length === 0 || value.length > MAX_STATE_STRING_LENGTH) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
};

const assertReconciliationId = (value: string): void => {
  if (value.length === 0 || value.length > MAX_RECONCILIATION_ID_LENGTH) {
    throw new FileObservationStateError('checkpoint_invalid');
  }
};

const assertScope = (scope: ExternalWriterScope): void => {
  assertNonEmpty(scope.teamId);
  assertNonEmpty(scope.featureKey);
};

const assertFingerprint = (fingerprint: ExternalFileSourceFingerprint): void => {
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

const copyPending = (pending: PendingFileObservation): PendingFileObservation => ({
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

const copyDirty = (dirty: DirtyObservationScope): DirtyObservationScope => ({
  ...dirty,
  scope: cloneScope(dirty.scope),
  reasons: [...dirty.reasons],
});

const copyIntent = (intent: ExternalSelfWriteIntent): ExternalSelfWriteIntent => ({
  ...intent,
  scope: cloneScope(intent.scope),
});

const copyObserved = (observed: ObservedExternalFile): ObservedExternalFile => ({
  ...observed,
  scope: cloneScope(observed.scope),
  fingerprint: {
    ...observed.fingerprint,
    statIdentity: observed.fingerprint.statIdentity
      ? { ...observed.fingerprint.statIdentity }
      : null,
  },
});

export class FileObservationState {
  private lastObservationSequence = 0;
  private observationWatermark = 0;
  private readonly fileWriterEpochs = new Map<string, FileWriterEpoch>();
  private readonly teamIds = new Map<string, ExternalWriterScope['teamId']>();
  private readonly teamLastObservationSequences = new Map<string, ObservationSequence>();
  private readonly teamObservationWatermarks = new Map<string, ObservationSequence>();
  private readonly pendingObservations = new Map<string, PendingFileObservation>();
  private readonly dirtyScopes = new Map<string, DirtyObservationScope>();
  private readonly selfWriteIntents = new Map<string, ExternalSelfWriteIntent>();
  private readonly observedFiles = new Map<string, ObservedExternalFile>();

  private constructor(private readonly limits: FileObservationStateLimits) {
    if (
      !isSafePositiveInteger(limits.maxPendingObservations) ||
      !isSafePositiveInteger(limits.maxSelfWriteIntents) ||
      !isSafePositiveInteger(limits.maxObservationAttempts) ||
      !isSafePositiveInteger(limits.maxScopes) ||
      !isSafePositiveInteger(limits.maxObservedFiles)
    ) {
      throw new FileObservationStateError('limit_invalid');
    }
  }

  static create(limits: FileObservationStateLimits): FileObservationState {
    return new FileObservationState(limits);
  }

  static restore(
    checkpoint: FileObservationStateCheckpoint | null,
    limits: FileObservationStateLimits
  ): FileObservationState {
    const state = new FileObservationState(limits);
    if (!checkpoint) {
      return state;
    }
    state.restoreCheckpoint(checkpoint);
    return state;
  }

  getLastObservationSequence(): ObservationSequence {
    return this.lastObservationSequence;
  }

  getObservationWatermark(): ObservationSequence {
    return this.observationWatermark;
  }

  getLastTeamObservationSequence(teamId: ExternalWriterScope['teamId']): ObservationSequence {
    assertNonEmpty(teamId);
    return this.teamLastObservationSequences.get(teamId) ?? 0;
  }

  getTeamObservationWatermark(teamId: ExternalWriterScope['teamId']): ObservationSequence {
    assertNonEmpty(teamId);
    return this.teamObservationWatermarks.get(teamId) ?? 0;
  }

  getPendingObservationCount(): number {
    return this.pendingObservations.size;
  }

  getPendingObservations(): readonly PendingFileObservation[] {
    return [...this.pendingObservations.values()].map(copyPending);
  }

  getPendingObservation(id: string): PendingFileObservation | null {
    const pending = this.pendingObservations.get(id);
    return pending ? copyPending(pending) : null;
  }

  getDirtyScopes(teamId?: ExternalWriterScope['teamId']): readonly DirtyObservationScope[] {
    return [...this.dirtyScopes.values()]
      .filter((dirty) => teamId === undefined || dirty.scope.teamId === teamId)
      .map(copyDirty);
  }

  getFileWriterEpoch(teamId: ExternalWriterScope['teamId']): FileWriterEpoch {
    assertNonEmpty(teamId);
    const existing = this.fileWriterEpochs.get(teamId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.fileWriterEpochs.size >= this.limits.maxScopes) {
      throw new FileObservationStateError('tracked_state_limit_exceeded');
    }
    this.fileWriterEpochs.set(teamId, 1);
    this.teamIds.set(teamId, teamId);
    return 1;
  }

  enqueueObservation(input: {
    scope: ExternalWriterScope;
    fileKey: ExternalFileKey;
    cause: ExternalObservationCause;
  }): { outcome: EnqueueObservationOutcome; sequence: ObservationSequence; id: string | null } {
    assertScope(input.scope);
    assertNonEmpty(input.fileKey);
    const id = fileKey(input.scope, input.fileKey);
    const existing = this.pendingObservations.get(id);
    if (existing) {
      const sequence = this.allocateSequence([input.scope.teamId]);
      existing.latestSequence = sequence;
      existing.cause = input.cause;
      this.recalculateWatermark();
      return { outcome: 'coalesced', sequence, id };
    }
    if (this.pendingObservations.size >= this.limits.maxPendingObservations) {
      this.assertCanTrackDirtyScopes([input.scope]);
      const sequence = this.allocateSequence([input.scope.teamId]);
      this.mergeDirtyScope(input.scope, 'notification_overflow', sequence, sequence);
      this.recalculateWatermark();
      return { outcome: 'overflow_dirty', sequence, id: null };
    }
    const fileWriterEpoch = this.getFileWriterEpoch(input.scope.teamId);
    const sequence = this.allocateSequence([input.scope.teamId]);
    this.pendingObservations.set(id, {
      id,
      scope: cloneScope(input.scope),
      fileKey: input.fileKey,
      cause: input.cause,
      earliestSequence: sequence,
      latestSequence: sequence,
      fileWriterEpoch,
      attempts: 0,
      reconciliation: null,
    });
    this.recalculateWatermark();
    return { outcome: 'enqueued', sequence, id };
  }

  markOverflow(scopes: readonly ExternalWriterScope[]): ObservationSequence {
    if (scopes.length === 0 || scopes.length > this.limits.maxScopes) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    for (const scope of scopes) {
      assertScope(scope);
    }
    this.assertCanTrackDirtyScopes(scopes);
    const sequence = this.allocateSequence(scopes.map((scope) => scope.teamId));
    for (const scope of scopes) {
      this.mergeDirtyScope(scope, 'notification_overflow', sequence, sequence);
    }
    this.recalculateWatermark();
    return sequence;
  }

  markScopeDirty(
    scope: ExternalWriterScope,
    reason: ExternalWriterDirtyReason
  ): ObservationSequence {
    assertScope(scope);
    this.assertCanTrackDirtyScopes([scope]);
    const sequence = this.allocateSequence([scope.teamId]);
    this.mergeDirtyScope(scope, reason, sequence, sequence);
    this.recalculateWatermark();
    return sequence;
  }

  takeNextPending(teamId?: ExternalWriterScope['teamId']): PendingFileObservation | null {
    const next = [...this.pendingObservations.values()].find(
      (pending) =>
        pending.attempts < this.limits.maxObservationAttempts &&
        (teamId === undefined || pending.scope.teamId === teamId)
    );
    return next ? copyPending(next) : null;
  }

  completePending(
    id: string,
    throughSequence: ObservationSequence
  ): CompletePendingObservationOutcome {
    const pending = this.pendingObservations.get(id);
    if (!pending) {
      return 'missing';
    }
    if (
      !isSafePositiveInteger(throughSequence) ||
      throughSequence < pending.earliestSequence ||
      throughSequence > pending.latestSequence
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    if (pending.latestSequence > throughSequence) {
      pending.earliestSequence = throughSequence + 1;
      pending.attempts = 0;
      pending.reconciliation = null;
      this.recalculateWatermark();
      return 'newer_pending';
    }
    this.pendingObservations.delete(id);
    this.recalculateWatermark();
    return 'completed';
  }

  beginPendingReconciliation(input: {
    pendingId: string;
    reconciliationId: string;
    throughSequence: ObservationSequence;
    fingerprint: ExternalFileSourceFingerprint;
    actor: ExternalObservationActor;
  }): PendingFileReconciliation {
    assertReconciliationId(input.reconciliationId);
    assertFingerprint(input.fingerprint);
    const pending = this.pendingObservations.get(input.pendingId);
    if (
      !pending ||
      pending.reconciliation ||
      input.reconciliationId !==
        buildExternalFileReconciliationId(
          pending.scope,
          pending.fileKey,
          pending.fileWriterEpoch,
          pending.earliestSequence
        ) ||
      input.throughSequence < pending.earliestSequence ||
      input.throughSequence > pending.latestSequence
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    this.assertActor(input.actor, pending.scope);
    if (
      input.actor.kind === 'external_file' &&
      (input.actor.observationSequence !== input.throughSequence ||
        input.actor.fileKey !== pending.fileKey ||
        input.actor.checksum !== input.fingerprint.checksum)
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    pending.reconciliation = {
      reconciliationId: input.reconciliationId,
      throughSequence: input.throughSequence,
      fingerprint: {
        ...input.fingerprint,
        statIdentity: input.fingerprint.statIdentity ? { ...input.fingerprint.statIdentity } : null,
      },
      actor: { ...input.actor },
    };
    return copyPending(pending).reconciliation!;
  }

  clearPendingReconciliation(pendingId: string, reconciliationId: string): boolean {
    const pending = this.pendingObservations.get(pendingId);
    if (!pending) {
      return false;
    }
    if (pending.reconciliation?.reconciliationId !== reconciliationId) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    pending.reconciliation = null;
    return true;
  }

  deferPending(id: string): 'deferred' | 'dirty' | 'missing' {
    const pending = this.pendingObservations.get(id);
    if (!pending) {
      return 'missing';
    }
    pending.attempts = Math.min(pending.attempts + 1, this.limits.maxObservationAttempts);
    if (pending.attempts < this.limits.maxObservationAttempts) {
      return 'deferred';
    }
    if (pending.reconciliation) {
      this.mergeDirtyScope(
        pending.scope,
        'unstable',
        pending.earliestSequence,
        pending.latestSequence
      );
      this.recalculateWatermark();
      return 'dirty';
    }
    this.mergeDirtyScope(
      pending.scope,
      'unstable',
      pending.earliestSequence,
      pending.latestSequence
    );
    this.pendingObservations.delete(id);
    this.recalculateWatermark();
    return 'dirty';
  }

  suspendPendingAsDirty(id: string, reason: ExternalWriterDirtyReason): boolean {
    const pending = this.pendingObservations.get(id);
    if (!pending || !pending.reconciliation) {
      return false;
    }
    pending.attempts = this.limits.maxObservationAttempts;
    this.mergeDirtyScope(pending.scope, reason, pending.earliestSequence, pending.latestSequence);
    this.recalculateWatermark();
    return true;
  }

  failPendingAsDirty(id: string, reason: ExternalWriterDirtyReason): boolean {
    const pending = this.pendingObservations.get(id);
    if (!pending) {
      return false;
    }
    this.mergeDirtyScope(pending.scope, reason, pending.earliestSequence, pending.latestSequence);
    this.pendingObservations.delete(id);
    this.recalculateWatermark();
    return true;
  }

  markScopeRescanned(scope: ExternalWriterScope, throughSequence: ObservationSequence): boolean {
    const key = scopeKey(scope);
    const dirty = this.dirtyScopes.get(key);
    if (!dirty || dirty.latestSequence > throughSequence) {
      return false;
    }
    this.dirtyScopes.delete(key);
    this.recalculateWatermark();
    return true;
  }

  addSelfWriteIntent(intent: ExternalSelfWriteIntent): void {
    assertScope(intent.scope);
    assertNonEmpty(intent.fileKey);
    assertNonEmpty(intent.intentId);
    if (
      !isSafeNonNegativeInteger(intent.sourceGeneration) ||
      !isSafePositiveInteger(intent.fileWriterEpoch) ||
      !Number.isFinite(intent.expiresAtMs)
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    if (intent.fileWriterEpoch !== this.getFileWriterEpoch(intent.scope.teamId)) {
      throw new FileObservationStateError('epoch_stale');
    }
    const observed = this.observedFiles.get(fileKey(intent.scope, intent.fileKey));
    if (
      observed &&
      (intent.sourceGeneration < observed.sourceGeneration ||
        intent.fileWriterEpoch < observed.fileWriterEpoch)
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    for (const [intentId, existing] of this.selfWriteIntents) {
      if (fileKey(existing.scope, existing.fileKey) === fileKey(intent.scope, intent.fileKey)) {
        this.selfWriteIntents.delete(intentId);
      }
    }
    if (
      !this.selfWriteIntents.has(intent.intentId) &&
      this.selfWriteIntents.size >= this.limits.maxSelfWriteIntents
    ) {
      throw new FileObservationStateError('self_write_limit_exceeded');
    }
    this.selfWriteIntents.set(intent.intentId, copyIntent(intent));
  }

  matchSelfWriteChecksum(input: {
    scope: ExternalWriterScope;
    fileKey: ExternalFileKey;
    checksum: ExternalContentChecksum | null;
    fileWriterEpoch: FileWriterEpoch;
    nowMs: number;
  }): SelfWriteChecksumMatch {
    this.pruneExpiredSelfWrites(input.nowMs);
    const matchesFile = [...this.selfWriteIntents.values()].filter(
      (intent) => scopesEqual(intent.scope, input.scope) && intent.fileKey === input.fileKey
    );
    if (matchesFile.length === 0) {
      return { outcome: 'none', intent: null };
    }
    const matched = matchesFile.find(
      (intent) =>
        intent.expectedChecksum === input.checksum &&
        intent.fileWriterEpoch === input.fileWriterEpoch
    );
    for (const intent of matchesFile) {
      this.selfWriteIntents.delete(intent.intentId);
    }
    return matched
      ? { outcome: 'matched', intent: copyIntent(matched) }
      : { outcome: 'mismatch', intent: null };
  }

  getObservedFile(
    scope: ExternalWriterScope,
    registeredFileKey: ExternalFileKey
  ): ObservedExternalFile | null {
    const observed = this.observedFiles.get(fileKey(scope, registeredFileKey));
    return observed ? copyObserved(observed) : null;
  }

  recordObservedFile(input: {
    scope: ExternalWriterScope;
    fileKey: ExternalFileKey;
    fingerprint: ExternalFileSourceFingerprint;
    sourceGeneration: number;
    fileWriterEpoch: FileWriterEpoch;
    observationSequence: ObservationSequence;
  }): void {
    assertFingerprint(input.fingerprint);
    if (
      !isSafeNonNegativeInteger(input.sourceGeneration) ||
      !isSafePositiveInteger(input.fileWriterEpoch) ||
      !isSafeNonNegativeInteger(input.observationSequence) ||
      input.observationSequence > this.lastObservationSequence
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    if (input.fileWriterEpoch !== this.getFileWriterEpoch(input.scope.teamId)) {
      throw new FileObservationStateError('epoch_stale');
    }
    const key = fileKey(input.scope, input.fileKey);
    const existing = this.observedFiles.get(key);
    if (
      existing &&
      (input.sourceGeneration < existing.sourceGeneration ||
        input.fileWriterEpoch < existing.fileWriterEpoch ||
        input.observationSequence < existing.observationSequence)
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    if (!existing && this.observedFiles.size >= this.limits.maxObservedFiles) {
      throw new FileObservationStateError('tracked_state_limit_exceeded');
    }
    this.observedFiles.set(key, copyObserved({ ...input }));
  }

  isTeamClean(teamId: ExternalWriterScope['teamId']): boolean {
    return (
      ![...this.pendingObservations.values()].some((pending) => pending.scope.teamId === teamId) &&
      ![...this.dirtyScopes.values()].some((dirty) => dirty.scope.teamId === teamId)
    );
  }

  advanceFileWriterEpoch(input: {
    teamId: ExternalWriterScope['teamId'];
    expectedEpoch: FileWriterEpoch;
    throughWatermark: ObservationSequence;
  }): FileWriterEpoch {
    const current = this.getFileWriterEpoch(input.teamId);
    const teamWatermark = this.getTeamObservationWatermark(input.teamId);
    const teamLastSequence = this.getLastTeamObservationSequence(input.teamId);
    if (current !== input.expectedEpoch) {
      throw new FileObservationStateError('epoch_stale');
    }
    if (
      input.throughWatermark !== teamWatermark ||
      input.throughWatermark !== teamLastSequence ||
      !this.isTeamClean(input.teamId)
    ) {
      throw new FileObservationStateError('epoch_not_quiescent');
    }
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new FileObservationStateError('sequence_exhausted');
    }
    const next = current + 1;
    this.fileWriterEpochs.set(input.teamId, next);
    this.teamIds.set(input.teamId, input.teamId);
    return next;
  }

  snapshot(): FileObservationStateCheckpoint {
    return {
      schemaVersion: EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION,
      lastObservationSequence: this.lastObservationSequence,
      observationWatermark: this.observationWatermark,
      fileWriterEpochs: [...this.fileWriterEpochs.entries()].map(([teamId, epoch]) => ({
        teamId: this.teamIds.get(teamId) ?? (teamId as ExternalWriterScope['teamId']),
        epoch,
      })),
      teamObservationWatermarks: [...this.teamLastObservationSequences.entries()].map(
        ([teamId, lastObservationSequence]) => ({
          teamId: this.teamIds.get(teamId) ?? (teamId as ExternalWriterScope['teamId']),
          lastObservationSequence,
          observationWatermark: this.teamObservationWatermarks.get(teamId) ?? 0,
        })
      ),
      pendingObservations: [...this.pendingObservations.values()].map(copyPending),
      dirtyScopes: [...this.dirtyScopes.values()].map(copyDirty),
      selfWriteIntents: [...this.selfWriteIntents.values()].map(copyIntent),
      observedFiles: [...this.observedFiles.values()].map(copyObserved),
    };
  }

  private allocateSequence(teamIds: readonly ExternalWriterScope['teamId'][]): ObservationSequence {
    if (this.lastObservationSequence >= Number.MAX_SAFE_INTEGER) {
      throw new FileObservationStateError('sequence_exhausted');
    }
    const distinctTeamIds = new Set(teamIds);
    for (const teamId of distinctTeamIds) {
      assertNonEmpty(teamId);
    }
    const newTeamCount = [...distinctTeamIds].filter(
      (teamId) => !this.teamLastObservationSequences.has(teamId)
    ).length;
    if (this.teamLastObservationSequences.size + newTeamCount > this.limits.maxScopes) {
      throw new FileObservationStateError('tracked_state_limit_exceeded');
    }
    this.lastObservationSequence += 1;
    for (const teamId of distinctTeamIds) {
      this.teamIds.set(teamId, teamId);
      this.teamLastObservationSequences.set(teamId, this.lastObservationSequence);
      if (!this.teamObservationWatermarks.has(teamId)) {
        this.teamObservationWatermarks.set(teamId, 0);
      }
    }
    return this.lastObservationSequence;
  }

  private mergeDirtyScope(
    scope: ExternalWriterScope,
    reason: ExternalWriterDirtyReason,
    earliestSequence: ObservationSequence,
    latestSequence: ObservationSequence
  ): void {
    const key = scopeKey(scope);
    const existing = this.dirtyScopes.get(key);
    if (!existing) {
      if (this.dirtyScopes.size >= this.limits.maxScopes) {
        throw new FileObservationStateError('tracked_state_limit_exceeded');
      }
      this.dirtyScopes.set(key, {
        scope: cloneScope(scope),
        reasons: [reason],
        earliestSequence,
        latestSequence,
      });
      return;
    }
    existing.earliestSequence = Math.min(existing.earliestSequence, earliestSequence);
    existing.latestSequence = Math.max(existing.latestSequence, latestSequence);
    if (!existing.reasons.includes(reason)) {
      existing.reasons = [...existing.reasons, reason];
    }
  }

  private assertCanTrackDirtyScopes(scopes: readonly ExternalWriterScope[]): void {
    const newScopeKeys = new Set(scopes.map(scopeKey).filter((key) => !this.dirtyScopes.has(key)));
    if (this.dirtyScopes.size + newScopeKeys.size > this.limits.maxScopes) {
      throw new FileObservationStateError('tracked_state_limit_exceeded');
    }
  }

  private recalculateWatermark(): void {
    let earliestOutstanding = Number.POSITIVE_INFINITY;
    for (const pending of this.pendingObservations.values()) {
      earliestOutstanding = Math.min(earliestOutstanding, pending.earliestSequence);
    }
    for (const dirty of this.dirtyScopes.values()) {
      earliestOutstanding = Math.min(earliestOutstanding, dirty.earliestSequence);
    }
    const candidate = Number.isFinite(earliestOutstanding)
      ? earliestOutstanding - 1
      : this.lastObservationSequence;
    this.observationWatermark = Math.max(this.observationWatermark, candidate);
    for (const [teamId, lastTeamSequence] of this.teamLastObservationSequences) {
      let earliestTeamOutstanding = Number.POSITIVE_INFINITY;
      for (const pending of this.pendingObservations.values()) {
        if (pending.scope.teamId === teamId) {
          earliestTeamOutstanding = Math.min(earliestTeamOutstanding, pending.earliestSequence);
        }
      }
      for (const dirty of this.dirtyScopes.values()) {
        if (dirty.scope.teamId === teamId) {
          earliestTeamOutstanding = Math.min(earliestTeamOutstanding, dirty.earliestSequence);
        }
      }
      const teamCandidate = Number.isFinite(earliestTeamOutstanding)
        ? earliestTeamOutstanding - 1
        : lastTeamSequence;
      this.teamObservationWatermarks.set(
        teamId,
        Math.max(this.teamObservationWatermarks.get(teamId) ?? 0, teamCandidate)
      );
    }
  }

  private pruneExpiredSelfWrites(nowMs: number): void {
    for (const [intentId, intent] of this.selfWriteIntents) {
      if (intent.expiresAtMs <= nowMs) {
        this.selfWriteIntents.delete(intentId);
      }
    }
  }

  private restoreCheckpoint(checkpoint: FileObservationStateCheckpoint): void {
    if (
      checkpoint.schemaVersion !== EXTERNAL_WRITER_OBSERVATION_SCHEMA_VERSION ||
      !isSafeNonNegativeInteger(checkpoint.lastObservationSequence) ||
      !isSafeNonNegativeInteger(checkpoint.observationWatermark) ||
      checkpoint.observationWatermark > checkpoint.lastObservationSequence ||
      checkpoint.pendingObservations.length > this.limits.maxPendingObservations ||
      checkpoint.selfWriteIntents.length > this.limits.maxSelfWriteIntents ||
      checkpoint.fileWriterEpochs.length > this.limits.maxScopes ||
      checkpoint.teamObservationWatermarks.length > this.limits.maxScopes ||
      checkpoint.dirtyScopes.length > this.limits.maxScopes ||
      checkpoint.observedFiles.length > this.limits.maxObservedFiles
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    this.lastObservationSequence = checkpoint.lastObservationSequence;
    this.observationWatermark = checkpoint.observationWatermark;
    for (const record of checkpoint.fileWriterEpochs) {
      assertNonEmpty(record.teamId);
      if (this.fileWriterEpochs.has(record.teamId) || !isSafePositiveInteger(record.epoch)) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
      this.fileWriterEpochs.set(record.teamId, record.epoch);
      this.teamIds.set(record.teamId, record.teamId);
    }
    for (const record of checkpoint.teamObservationWatermarks) {
      assertNonEmpty(record.teamId);
      if (
        this.teamLastObservationSequences.has(record.teamId) ||
        !isSafeNonNegativeInteger(record.lastObservationSequence) ||
        !isSafeNonNegativeInteger(record.observationWatermark) ||
        record.observationWatermark > record.lastObservationSequence ||
        record.lastObservationSequence > this.lastObservationSequence
      ) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
      this.teamLastObservationSequences.set(record.teamId, record.lastObservationSequence);
      this.teamObservationWatermarks.set(record.teamId, record.observationWatermark);
      this.teamIds.set(record.teamId, record.teamId);
    }
    for (const pending of checkpoint.pendingObservations) {
      this.assertPending(pending);
      if (this.pendingObservations.has(pending.id)) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
      this.pendingObservations.set(pending.id, copyPending(pending));
    }
    for (const dirty of checkpoint.dirtyScopes) {
      this.assertDirty(dirty);
      const key = scopeKey(dirty.scope);
      if (this.dirtyScopes.has(key)) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
      this.dirtyScopes.set(key, copyDirty(dirty));
    }
    for (const intent of checkpoint.selfWriteIntents) {
      assertScope(intent.scope);
      assertNonEmpty(intent.intentId);
      assertNonEmpty(intent.fileKey);
      if (
        this.selfWriteIntents.has(intent.intentId) ||
        !isSafeNonNegativeInteger(intent.sourceGeneration) ||
        !isSafePositiveInteger(intent.fileWriterEpoch) ||
        !Number.isFinite(intent.expiresAtMs)
      ) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
      this.selfWriteIntents.set(intent.intentId, copyIntent(intent));
    }
    for (const observed of checkpoint.observedFiles) {
      assertScope(observed.scope);
      assertNonEmpty(observed.fileKey);
      assertFingerprint(observed.fingerprint);
      const key = fileKey(observed.scope, observed.fileKey);
      if (
        this.observedFiles.has(key) ||
        !isSafeNonNegativeInteger(observed.sourceGeneration) ||
        !isSafePositiveInteger(observed.fileWriterEpoch) ||
        !isSafeNonNegativeInteger(observed.observationSequence) ||
        observed.observationSequence > this.lastObservationSequence
      ) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
      this.observedFiles.set(key, copyObserved(observed));
    }
    for (const pending of this.pendingObservations.values()) {
      const teamLastSequence = this.teamLastObservationSequences.get(pending.scope.teamId);
      if (
        this.fileWriterEpochs.get(pending.scope.teamId) !== pending.fileWriterEpoch ||
        teamLastSequence === undefined ||
        teamLastSequence < pending.latestSequence
      ) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
    }
    for (const dirty of this.dirtyScopes.values()) {
      const teamLastSequence = this.teamLastObservationSequences.get(dirty.scope.teamId);
      if (teamLastSequence === undefined || teamLastSequence < dirty.latestSequence) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
    }
    for (const intent of this.selfWriteIntents.values()) {
      const epoch = this.fileWriterEpochs.get(intent.scope.teamId);
      if (epoch === undefined || intent.fileWriterEpoch > epoch) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
    }
    for (const observed of this.observedFiles.values()) {
      const epoch = this.fileWriterEpochs.get(observed.scope.teamId);
      const teamLastSequence = this.teamLastObservationSequences.get(observed.scope.teamId);
      if (
        epoch === undefined ||
        observed.fileWriterEpoch > epoch ||
        teamLastSequence === undefined ||
        teamLastSequence < observed.observationSequence
      ) {
        throw new FileObservationStateError('checkpoint_invalid');
      }
    }
    const restoredWatermark = this.observationWatermark;
    const restoredTeamWatermarks = new Map(this.teamObservationWatermarks);
    this.observationWatermark = 0;
    for (const teamId of this.teamObservationWatermarks.keys()) {
      this.teamObservationWatermarks.set(teamId, 0);
    }
    this.recalculateWatermark();
    if (
      restoredWatermark !== this.observationWatermark ||
      [...restoredTeamWatermarks].some(
        ([teamId, watermark]) => this.teamObservationWatermarks.get(teamId) !== watermark
      )
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
  }

  private assertPending(pending: PendingFileObservation): void {
    assertScope(pending.scope);
    assertNonEmpty(pending.fileKey);
    if (
      pending.id !== fileKey(pending.scope, pending.fileKey) ||
      !isSafePositiveInteger(pending.earliestSequence) ||
      !isSafePositiveInteger(pending.latestSequence) ||
      pending.earliestSequence > pending.latestSequence ||
      pending.latestSequence > this.lastObservationSequence ||
      pending.earliestSequence <= this.observationWatermark ||
      !isSafePositiveInteger(pending.fileWriterEpoch) ||
      !isSafeNonNegativeInteger(pending.attempts) ||
      pending.attempts > this.limits.maxObservationAttempts ||
      (pending.attempts === this.limits.maxObservationAttempts &&
        pending.reconciliation === null) ||
      (pending.reconciliation !== null &&
        (pending.reconciliation.throughSequence < pending.earliestSequence ||
          pending.reconciliation.throughSequence > pending.latestSequence))
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
    if (pending.reconciliation) {
      assertReconciliationId(pending.reconciliation.reconciliationId);
      assertFingerprint(pending.reconciliation.fingerprint);
      this.assertActor(pending.reconciliation.actor, pending.scope);
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

  private assertDirty(dirty: DirtyObservationScope): void {
    assertScope(dirty.scope);
    if (
      dirty.reasons.length === 0 ||
      new Set(dirty.reasons).size !== dirty.reasons.length ||
      !isSafePositiveInteger(dirty.earliestSequence) ||
      !isSafePositiveInteger(dirty.latestSequence) ||
      dirty.earliestSequence > dirty.latestSequence ||
      dirty.latestSequence > this.lastObservationSequence ||
      dirty.earliestSequence <= this.observationWatermark
    ) {
      throw new FileObservationStateError('checkpoint_invalid');
    }
  }

  private assertActor(actor: ExternalObservationActor, scope: ExternalWriterScope): void {
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
}
