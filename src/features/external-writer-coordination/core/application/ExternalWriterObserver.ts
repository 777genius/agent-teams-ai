import {
  type ExternalContentChecksum,
  type ExternalFileActor,
  type ExternalFileReconciliationResult,
  type ExternalFileRegistration,
  type ExternalFileSourceFingerprint,
  type ExternalFileStat,
  type ExternalFileStatIdentity,
  type ExternalObservationCause,
  type ExternalSelfWriteIntent,
  type ExternalWriterDirtyReason,
  type ExternalWriterNotification,
  type ExternalWriterObserverOptions,
  type ExternalWriterObserverPhase,
  type ExternalWriterObserverSnapshot,
  type ExternalWriterOverflowNotification,
  type ExternalWriterQuiescenceResult,
  type ExternalWriterScope,
  type ExternalWriterShutdownHandoff,
  type FileWriterEpoch,
  type ObservationSequence,
  type PendingFileObservation,
  type PendingFileReconciliation,
  type VerifiedRunActor,
} from '../../contracts';
import { buildExternalFileReconciliationId, FileObservationState } from '../domain';

import type {
  ExternalContentChecksumPort,
  ExternalFileObservationCatalog,
  ExternalFileObservationSource,
  ExternalFileReconciliationPort,
  ExternalWriterObservationStateStore,
  ExternalWriterObserverClock,
  ExternalWriterWatchHandle,
  ExternalWriterWatchPort,
  VerifiedRunEvidencePort,
} from './ports';
import type { TeamId } from '@shared/contracts/hosted/identifiers';

const DEFAULT_OPTIONS: ExternalWriterObserverOptions = {
  maxPendingObservations: 1_024,
  maxSelfWriteIntents: 1_024,
  maxScopes: 1_024,
  maxObservedFiles: 100_000,
  maxFilesPerScope: 10_000,
  maxReadBytes: 4 * 1_024 * 1_024,
  maxStableReadAttempts: 4,
  maxObservationAttempts: 3,
  maxDrainPassObservations: 20_000,
  maxQuiescenceAttempts: 4,
  stableReadDeadlineMs: 2_000,
  retryDelayMs: 10,
  atomicReplaceDebounceMs: 25,
  shutdownDrainDeadlineMs: 5_000,
};

type StableReadOutcome =
  | {
      outcome: 'stable';
      content: Uint8Array | null;
      fingerprint: ExternalFileSourceFingerprint;
    }
  | {
      outcome: 'invalid';
      reason: Extract<
        ExternalWriterDirtyReason,
        'outside_containment' | 'oversized' | 'unsupported_file_type'
      >;
    }
  | { outcome: 'unstable' };

interface TeamQuiescenceFence {
  fileWriterEpoch: FileWriterEpoch;
  lastObservationSequence: ObservationSequence;
  observationWatermark: ObservationSequence;
  clean: boolean;
}

export interface ExternalWriterObserverDependencies {
  watch: ExternalWriterWatchPort;
  catalog: ExternalFileObservationCatalog;
  source: ExternalFileObservationSource;
  checksums: ExternalContentChecksumPort;
  reconciliation: ExternalFileReconciliationPort;
  stateStore: ExternalWriterObservationStateStore;
  clock: ExternalWriterObserverClock;
  verifiedRunEvidence?: VerifiedRunEvidencePort;
}

export class ExternalWriterObserverError extends Error {
  constructor(
    readonly code: 'already_started' | 'catalog_invalid' | 'not_running' | 'options_invalid'
  ) {
    super(`external-writer-observer:${code}`);
    this.name = 'ExternalWriterObserverError';
  }
}

const scopesEqual = (left: ExternalWriterScope, right: ExternalWriterScope): boolean =>
  left.teamId === right.teamId && left.featureKey === right.featureKey;

const fingerprintsEqual = (
  left: ExternalFileSourceFingerprint,
  right: ExternalFileSourceFingerprint
): boolean => left.exists === right.exists && left.checksum === right.checksum;

const isSafeNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const isSafePositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isClosedReconciliationResult = (
  value: unknown
): value is ExternalFileReconciliationResult => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.outcome) {
    case 'accepted_change':
      return (
        typeof value.sourceGeneration === 'number' &&
        isSafeNonNegativeInteger(value.sourceGeneration) &&
        typeof value.featureRevision === 'number' &&
        isSafeNonNegativeInteger(value.featureRevision)
      );
    case 'semantic_noop':
      return (
        typeof value.sourceGeneration === 'number' &&
        isSafeNonNegativeInteger(value.sourceGeneration)
      );
    case 'invalid':
      return (
        isNonEmptyString(value.diagnosticCode) &&
        typeof value.blocksDependentMutations === 'boolean'
      );
    case 'conflict':
      return isNonEmptyString(value.diagnosticCode);
    default:
      return false;
  }
};

const statIdentity = (stat: ExternalFileStat): ExternalFileStatIdentity | null => {
  if (
    stat.kind !== 'file' ||
    stat.device === null ||
    stat.inode === null ||
    stat.modifiedTimeNs === null ||
    stat.changedTimeNs === null
  ) {
    return null;
  }
  return {
    byteLength: stat.byteLength,
    device: stat.device,
    inode: stat.inode,
    modifiedTimeNs: stat.modifiedTimeNs,
    changedTimeNs: stat.changedTimeNs,
  };
};

const statIdentitiesEqual = (
  left: ExternalFileStatIdentity,
  right: ExternalFileStatIdentity
): boolean =>
  left.byteLength === right.byteLength &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.modifiedTimeNs === right.modifiedTimeNs &&
  left.changedTimeNs === right.changedTimeNs;

export class ExternalWriterObserver {
  private readonly options: ExternalWriterObserverOptions;
  private state: FileObservationState;
  private phase: ExternalWriterObserverPhase = 'idle';
  private acceptingNotifications = false;
  private watchHandle: ExternalWriterWatchHandle | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: ExternalWriterObserverDependencies,
    options: Partial<ExternalWriterObserverOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.assertOptions();
    this.state = FileObservationState.create(this.stateLimits());
  }

  start(): Promise<ExternalWriterObserverSnapshot> {
    if (this.phase !== 'idle') {
      throw new ExternalWriterObserverError('already_started');
    }
    this.phase = 'starting';
    return this.schedule(async () => {
      let stateLoaded = false;
      try {
        const checkpoint = await this.dependencies.stateStore.load();
        this.state = FileObservationState.restore(checkpoint, this.stateLimits());
        stateLoaded = true;
        this.acceptingNotifications = true;
        // The watch callback is live before the first catalog scan begins.
        this.watchHandle = await this.dependencies.watch.start({
          onNotification: (notification) => this.acceptNotification(notification),
          onOverflow: (notification) => this.acceptOverflow(notification),
        });
        const scopes = await this.listScopes();
        for (const scope of scopes) {
          await this.scanScopeInternal(scope, 'startup_scan');
        }
        await this.drainAvailable(this.options.maxDrainPassObservations);
        const persistedThrough = this.state.getLastObservationSequence();
        const startupOverflowScopes = this.state
          .getDirtyScopes()
          .filter((dirty) => dirty.reasons.includes('notification_overflow'))
          .map((dirty) => dirty.scope);
        await this.persist();
        this.phase = 'running';
        if (
          this.state.getLastObservationSequence() > persistedThrough ||
          startupOverflowScopes.length > 0
        ) {
          this.finishStartupInBackground(persistedThrough, startupOverflowScopes);
        }
        return this.getSnapshot();
      } catch (error) {
        this.acceptingNotifications = false;
        this.phase = 'stopped';
        if (this.watchHandle) {
          await this.watchHandle.close().catch(() => undefined);
        }
        if (stateLoaded) {
          await this.persist().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  acceptNotification(notification: ExternalWriterNotification): ObservationSequence {
    if (!this.acceptingNotifications) {
      const sequence = this.state.markScopeDirty(notification.scope, 'shutdown_handoff');
      this.persistInBackground();
      return sequence;
    }
    const queued = this.state.enqueueObservation({
      scope: notification.scope,
      fileKey: notification.fileKey,
      cause: notification.kind,
    });
    if (this.phase === 'running') {
      this.drainInBackground(notification.scope);
    }
    return queued.sequence;
  }

  acceptOverflow(notification: ExternalWriterOverflowNotification): ObservationSequence {
    const sequence = this.state.markOverflow(notification.scopes);
    if (this.phase === 'running') {
      for (const scope of notification.scopes) {
        this.rescanInBackground(scope);
      }
    } else if (!this.acceptingNotifications) {
      this.persistInBackground();
    }
    return sequence;
  }

  recordSelfWriteIntent(intent: ExternalSelfWriteIntent): Promise<void> {
    return this.schedule(async () => {
      if (this.phase !== 'running' && this.phase !== 'starting') {
        throw new ExternalWriterObserverError('not_running');
      }
      if (this.state.getFileWriterEpoch(intent.scope.teamId) !== intent.fileWriterEpoch) {
        throw new ExternalWriterObserverError('catalog_invalid');
      }
      this.state.addSelfWriteIntent(intent);
      await this.persist();
    });
  }

  rescanScope(scope: ExternalWriterScope): Promise<ExternalWriterObserverSnapshot> {
    return this.schedule(async () => {
      if (this.phase !== 'running') {
        throw new ExternalWriterObserverError('not_running');
      }
      await this.scanScopeInternal(scope, 'periodic_scan');
      await this.persist();
      return this.getSnapshot();
    });
  }

  quiesceTeam(teamId: TeamId, deadlineMs: number): Promise<ExternalWriterQuiescenceResult> {
    return this.schedule(async () => {
      if (this.phase !== 'running' || !Number.isFinite(deadlineMs)) {
        throw new ExternalWriterObserverError('not_running');
      }
      for (let attempt = 0; attempt < this.options.maxQuiescenceAttempts; attempt += 1) {
        const capturedSequence = this.state.getLastTeamObservationSequence(teamId);
        await this.drainTeamThrough(teamId, capturedSequence, deadlineMs);
        if (this.dependencies.clock.nowMs() >= deadlineMs) {
          break;
        }
        const teamScopes = (await this.listScopes()).filter((scope) => scope.teamId === teamId);
        for (const scope of teamScopes) {
          if (this.dependencies.clock.nowMs() >= deadlineMs) {
            break;
          }
          await this.scanScopeInternal(scope, 'dirty_scope_rescan');
        }
        const afterScan = this.state.getLastTeamObservationSequence(teamId);
        await this.drainTeamThrough(teamId, afterScan, deadlineMs);
        const beforePersistence = this.captureTeamQuiescenceFence(teamId);
        if (
          beforePersistence.lastObservationSequence === afterScan &&
          beforePersistence.observationWatermark === beforePersistence.lastObservationSequence &&
          beforePersistence.clean
        ) {
          await this.persist();
          const afterPersistence = this.captureTeamQuiescenceFence(teamId);
          if (this.sameTeamQuiescenceFence(beforePersistence, afterPersistence)) {
            return {
              outcome: 'quiesced',
              proof: {
                teamId,
                fileWriterEpoch: afterPersistence.fileWriterEpoch,
                observationWatermark: afterPersistence.observationWatermark,
              },
            };
          }
        }
        if (this.dependencies.clock.nowMs() >= deadlineMs) {
          break;
        }
      }
      await this.persist();
      return {
        outcome: 'external_writer_busy',
        capturedSequence: this.state.getLastTeamObservationSequence(teamId),
        observationWatermark: this.state.getTeamObservationWatermark(teamId),
        dirtyScopes: this.state.getDirtyScopes(teamId),
      };
    });
  }

  advanceFileWriterEpoch(input: {
    teamId: TeamId;
    expectedEpoch: FileWriterEpoch;
    observationWatermark: ObservationSequence;
  }): Promise<FileWriterEpoch> {
    return this.schedule(async () => {
      if (this.phase !== 'running') {
        throw new ExternalWriterObserverError('not_running');
      }
      const epoch = this.state.advanceFileWriterEpoch({
        teamId: input.teamId,
        expectedEpoch: input.expectedEpoch,
        throughWatermark: input.observationWatermark,
      });
      await this.persist();
      return epoch;
    });
  }

  shutdown(deadlineMs?: number): Promise<ExternalWriterShutdownHandoff> {
    if (this.phase !== 'running') {
      throw new ExternalWriterObserverError('not_running');
    }
    this.acceptingNotifications = false;
    this.phase = 'stopping';
    return this.schedule(async () => {
      const effectiveDeadline =
        deadlineMs ?? this.dependencies.clock.nowMs() + this.options.shutdownDrainDeadlineMs;
      let closeFailed = false;
      try {
        await this.watchHandle?.close();
      } catch {
        closeFailed = true;
        for (const scope of await this.listScopes().catch(() => [])) {
          this.state.markScopeDirty(scope, 'shutdown_handoff');
        }
      }
      const capturedSequence = this.state.getLastObservationSequence();
      const drained = await this.drainThrough(capturedSequence, effectiveDeadline);
      if (!drained) {
        for (const pending of this.state.getPendingObservations()) {
          if (!this.state.suspendPendingAsDirty(pending.id, 'shutdown_handoff')) {
            this.state.failPendingAsDirty(pending.id, 'shutdown_handoff');
          }
        }
      }
      await this.persist();
      const dirtyScopes = this.state.getDirtyScopes();
      const pendingObservationCount = this.state.getPendingObservationCount();
      const deadlineExceeded = !drained && this.dependencies.clock.nowMs() >= effectiveDeadline;
      this.phase = 'stopped';
      return {
        status: deadlineExceeded
          ? 'deadline_exceeded'
          : closeFailed || dirtyScopes.length > 0 || pendingObservationCount > 0
            ? 'dirty'
            : 'clean',
        capturedSequence,
        persistedWatermark: this.state.getObservationWatermark(),
        dirtyScopes,
        pendingObservationCount,
      };
    });
  }

  getSnapshot(): ExternalWriterObserverSnapshot {
    const checkpoint = this.state.snapshot();
    return {
      phase: this.phase,
      acceptingNotifications: this.acceptingNotifications,
      readiness:
        checkpoint.dirtyScopes.length === 0 && checkpoint.pendingObservations.length === 0
          ? 'clean'
          : 'dirty',
      checkpoint,
    };
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private drainInBackground(scope: ExternalWriterScope): void {
    void this.schedule(async () => {
      try {
        await this.persist();
        await this.drainAvailable(this.options.maxDrainPassObservations);
      } catch {
        this.state.markScopeDirty(scope, 'unstable');
      }
      await this.persist();
    });
  }

  private rescanInBackground(scope: ExternalWriterScope): void {
    void this.schedule(async () => {
      try {
        await this.persist();
        await this.scanScopeInternal(scope, 'dirty_scope_rescan');
      } catch {
        this.state.markScopeDirty(scope, 'unstable');
      }
      await this.persist();
    });
  }

  private persistInBackground(): void {
    void this.schedule(() => this.persist());
  }

  private finishStartupInBackground(
    persistedThrough: ObservationSequence,
    startupOverflowScopes: readonly ExternalWriterScope[]
  ): void {
    void this.schedule(async () => {
      await this.persist();
      await this.drainAvailable(this.options.maxDrainPassObservations);
      const dirtyScopes = [
        ...startupOverflowScopes,
        ...this.state
          .getDirtyScopes()
          .filter((dirty) => dirty.latestSequence > persistedThrough)
          .map((dirty) => dirty.scope),
      ].filter(
        (scope, index, scopes) =>
          scopes.findIndex((candidate) => scopesEqual(candidate, scope)) === index
      );
      for (const scope of dirtyScopes) {
        try {
          await this.scanScopeInternal(scope, 'dirty_scope_rescan');
        } catch {
          this.state.markScopeDirty(scope, 'unstable');
        }
      }
      await this.persist();
    });
  }

  private async scanScopeInternal(
    scope: ExternalWriterScope,
    cause: Extract<
      ExternalObservationCause,
      'dirty_scope_rescan' | 'periodic_scan' | 'startup_scan'
    >
  ): Promise<void> {
    const repairThrough = this.state.getLastObservationSequence();
    let registrations: readonly ExternalFileRegistration[];
    try {
      registrations = await this.listRegistrations(scope);
    } catch (error) {
      this.state.markScopeDirty(scope, 'catalog_changed');
      if (error instanceof ExternalWriterObserverError) {
        return;
      }
      throw error;
    }
    let scanComplete = true;
    for (const registration of registrations) {
      const queued = this.state.enqueueObservation({
        scope,
        fileKey: registration.fileKey,
        cause,
      });
      if (queued.outcome === 'overflow_dirty') {
        scanComplete = false;
        continue;
      }
      if (queued.id !== null) {
        for (let attempt = 0; attempt < this.options.maxObservationAttempts; attempt += 1) {
          const scanPending = this.state.getPendingObservation(queued.id);
          if (!scanPending) {
            break;
          }
          await this.processPending(scanPending);
        }
      }
      if (queued.id !== null && this.state.getPendingObservation(queued.id)) {
        scanComplete = false;
      }
    }
    if (scanComplete) {
      this.state.markScopeRescanned(scope, repairThrough);
    }
  }

  private async drainAvailable(maxObservations: number): Promise<number> {
    let processed = 0;
    while (processed < maxObservations) {
      const pending = this.state.takeNextPending();
      if (!pending) {
        break;
      }
      await this.processPending(pending);
      processed += 1;
    }
    if (processed >= maxObservations && this.state.getPendingObservationCount() > 0) {
      for (const pending of this.state.getPendingObservations()) {
        if (!this.state.suspendPendingAsDirty(pending.id, 'drain_budget_exhausted')) {
          this.state.failPendingAsDirty(pending.id, 'drain_budget_exhausted');
        }
      }
    }
    return processed;
  }

  private async drainThrough(target: ObservationSequence, deadlineMs: number): Promise<boolean> {
    let processed = 0;
    while (
      this.state.getObservationWatermark() < target &&
      processed < this.options.maxDrainPassObservations &&
      this.dependencies.clock.nowMs() < deadlineMs
    ) {
      const pending = this.state.takeNextPending();
      if (!pending) {
        return false;
      }
      await this.processPending(pending);
      processed += 1;
    }
    return this.state.getObservationWatermark() >= target;
  }

  private async drainTeamThrough(
    teamId: TeamId,
    target: ObservationSequence,
    deadlineMs: number
  ): Promise<boolean> {
    let processed = 0;
    while (
      this.state.getTeamObservationWatermark(teamId) < target &&
      processed < this.options.maxDrainPassObservations &&
      this.dependencies.clock.nowMs() < deadlineMs
    ) {
      const pending = this.state.takeNextPending(teamId);
      if (!pending) {
        return false;
      }
      await this.processPending(pending);
      processed += 1;
    }
    return this.state.getTeamObservationWatermark(teamId) >= target;
  }

  private async processPending(initialPending: PendingFileObservation): Promise<void> {
    let pending = initialPending;
    if (pending.reconciliation) {
      let recovered: unknown;
      try {
        recovered = await this.dependencies.reconciliation.getResult(
          pending.reconciliation.reconciliationId
        );
      } catch {
        await this.deferPending(pending.id);
        return;
      }
      if (recovered !== null) {
        this.settleReconciliation(pending, pending.reconciliation, recovered);
        return;
      }
      this.state.clearPendingReconciliation(pending.id, pending.reconciliation.reconciliationId);
      const refreshed = this.state.getPendingObservation(pending.id);
      if (!refreshed) {
        return;
      }
      pending = refreshed;
    }
    let registration: ExternalFileRegistration | null;
    try {
      registration = await this.findRegistration(pending);
    } catch {
      this.state.failPendingAsDirty(pending.id, 'catalog_changed');
      return;
    }
    if (!registration) {
      this.state.failPendingAsDirty(pending.id, 'catalog_changed');
      return;
    }
    const stableRead = await this.readStable(registration);
    if (stableRead.outcome === 'invalid') {
      this.state.failPendingAsDirty(pending.id, stableRead.reason);
      return;
    }
    if (stableRead.outcome === 'unstable') {
      const result = this.state.deferPending(pending.id);
      if (result === 'deferred') {
        await this.dependencies.clock.sleep(this.options.retryDelayMs);
      }
      return;
    }
    const checksumMatch = this.state.matchSelfWriteChecksum({
      scope: pending.scope,
      fileKey: pending.fileKey,
      checksum: stableRead.fingerprint.checksum,
      fileWriterEpoch: pending.fileWriterEpoch,
      nowMs: this.dependencies.clock.nowMs(),
    });
    if (checksumMatch.outcome === 'matched') {
      this.state.recordObservedFile({
        scope: pending.scope,
        fileKey: pending.fileKey,
        fingerprint: stableRead.fingerprint,
        sourceGeneration: checksumMatch.intent.sourceGeneration,
        fileWriterEpoch: pending.fileWriterEpoch,
        observationSequence: pending.latestSequence,
      });
      this.state.completePending(pending.id, pending.latestSequence);
      return;
    }
    const previous = this.state.getObservedFile(pending.scope, pending.fileKey);
    if (previous && fingerprintsEqual(previous.fingerprint, stableRead.fingerprint)) {
      this.state.recordObservedFile({
        scope: pending.scope,
        fileKey: pending.fileKey,
        fingerprint: stableRead.fingerprint,
        sourceGeneration: previous.sourceGeneration,
        fileWriterEpoch: pending.fileWriterEpoch,
        observationSequence: pending.latestSequence,
      });
      this.state.completePending(pending.id, pending.latestSequence);
      return;
    }
    const actor = await this.classifyActor(
      registration,
      stableRead.content,
      stableRead.fingerprint.checksum,
      pending.latestSequence,
      pending.fileWriterEpoch
    );
    const reconciliationAttempt = this.state.beginPendingReconciliation({
      pendingId: pending.id,
      reconciliationId: buildExternalFileReconciliationId(
        pending.scope,
        pending.fileKey,
        pending.fileWriterEpoch,
        pending.earliestSequence
      ),
      throughSequence: pending.latestSequence,
      fingerprint: stableRead.fingerprint,
      actor,
    });
    try {
      // Write-ahead state makes the id/result lookup recoverable if the atomic
      // feature commit succeeds but its response is lost.
      await this.persist();
      const reconciliation: unknown = await this.dependencies.reconciliation.reconcile({
        reconciliationId: reconciliationAttempt.reconciliationId,
        registration,
        content: stableRead.content,
        fingerprint: stableRead.fingerprint,
        observationSequence: reconciliationAttempt.throughSequence,
        fileWriterEpoch: pending.fileWriterEpoch,
        actor,
      });
      this.settleReconciliation(pending, reconciliationAttempt, reconciliation);
    } catch {
      await this.deferPending(pending.id);
    }
  }

  private settleReconciliation(
    pending: PendingFileObservation,
    attempt: PendingFileReconciliation,
    reconciliation: unknown
  ): void {
    if (!isClosedReconciliationResult(reconciliation)) {
      this.state.failPendingAsDirty(pending.id, 'reconciliation_conflict');
      return;
    }
    if (reconciliation.outcome === 'invalid') {
      this.state.failPendingAsDirty(pending.id, 'corrupt');
      return;
    }
    if (reconciliation.outcome === 'conflict') {
      this.state.failPendingAsDirty(pending.id, 'reconciliation_conflict');
      return;
    }
    const previous = this.state.getObservedFile(pending.scope, pending.fileKey);
    if (previous && reconciliation.sourceGeneration < previous.sourceGeneration) {
      this.state.failPendingAsDirty(pending.id, 'reconciliation_conflict');
      return;
    }
    this.state.recordObservedFile({
      scope: pending.scope,
      fileKey: pending.fileKey,
      fingerprint: attempt.fingerprint,
      sourceGeneration: reconciliation.sourceGeneration,
      fileWriterEpoch: pending.fileWriterEpoch,
      observationSequence: attempt.throughSequence,
    });
    this.state.completePending(pending.id, attempt.throughSequence);
  }

  private async deferPending(pendingId: string): Promise<void> {
    const result = this.state.deferPending(pendingId);
    if (result === 'deferred') {
      await this.dependencies.clock.sleep(this.options.retryDelayMs);
    }
  }

  private async classifyActor(
    registration: ExternalFileRegistration,
    content: Uint8Array | null,
    checksum: ExternalContentChecksum | null,
    observationSequence: ObservationSequence,
    fileWriterEpoch: FileWriterEpoch
  ): Promise<ExternalFileActor | VerifiedRunActor> {
    const externalActor: ExternalFileActor = {
      kind: 'external_file',
      teamId: registration.scope.teamId,
      featureKey: registration.scope.featureKey,
      fileKey: registration.fileKey,
      checksum,
      observationSequence,
    };
    if (
      registration.attributionPolicy !== 'verified_run_evidence' ||
      !this.dependencies.verifiedRunEvidence
    ) {
      return externalActor;
    }
    let verified: VerifiedRunActor | null;
    try {
      verified = await this.dependencies.verifiedRunEvidence.verify({
        registration,
        content,
        checksum,
        observationSequence,
        fileWriterEpoch,
      });
    } catch {
      return externalActor;
    }
    if (!verified) {
      return externalActor;
    }
    if (
      verified.kind !== 'verified_run' ||
      verified.teamId !== registration.scope.teamId ||
      typeof verified.runId !== 'string' ||
      verified.runId.length === 0 ||
      (verified.memberId !== null && typeof verified.memberId !== 'string') ||
      typeof verified.evidenceRef !== 'string' ||
      verified.evidenceRef.length === 0 ||
      !isSafePositiveInteger(verified.runGeneration)
    ) {
      return externalActor;
    }
    return verified;
  }

  private async readStable(registration: ExternalFileRegistration): Promise<StableReadOutcome> {
    const startedAt = this.dependencies.clock.nowMs();
    for (let attempt = 0; attempt < this.options.maxStableReadAttempts; attempt += 1) {
      try {
        const before = await this.dependencies.source.stat(registration);
        if (!before.contained) {
          return { outcome: 'invalid', reason: 'outside_containment' };
        }
        if (before.kind === 'missing') {
          await this.dependencies.clock.sleep(this.options.atomicReplaceDebounceMs);
          const confirmed =
            await this.dependencies.source.confirmAbsentByParentRescan(registration);
          const afterConfirmation = await this.dependencies.source.stat(registration);
          if (confirmed && afterConfirmation.kind === 'missing' && afterConfirmation.contained) {
            return {
              outcome: 'stable',
              content: null,
              fingerprint: { exists: false, checksum: null, statIdentity: null },
            };
          }
          await this.retryStableRead(startedAt, attempt);
          continue;
        }
        if (before.kind !== 'file') {
          return { outcome: 'invalid', reason: 'unsupported_file_type' };
        }
        const maximumBytes = Math.min(registration.maxBytes, this.options.maxReadBytes);
        if (!isSafeNonNegativeInteger(before.byteLength) || before.byteLength > maximumBytes) {
          return { outcome: 'invalid', reason: 'oversized' };
        }
        const beforeIdentity = statIdentity(before);
        if (!beforeIdentity) {
          await this.retryStableRead(startedAt, attempt);
          continue;
        }
        const content = await this.dependencies.source.read(registration, maximumBytes);
        const after = await this.dependencies.source.stat(registration);
        const afterIdentity = statIdentity(after);
        if (
          !after.contained ||
          !afterIdentity ||
          content.byteLength !== before.byteLength ||
          !statIdentitiesEqual(beforeIdentity, afterIdentity)
        ) {
          await this.retryStableRead(startedAt, attempt);
          continue;
        }
        const checksum = await this.dependencies.checksums.checksum(content);
        if (checksum.length === 0) {
          await this.retryStableRead(startedAt, attempt);
          continue;
        }
        return {
          outcome: 'stable',
          content,
          fingerprint: { exists: true, checksum, statIdentity: afterIdentity },
        };
      } catch {
        await this.retryStableRead(startedAt, attempt);
      }
    }
    return { outcome: 'unstable' };
  }

  private async retryStableRead(startedAt: number, attempt: number): Promise<void> {
    if (
      attempt + 1 < this.options.maxStableReadAttempts &&
      this.dependencies.clock.nowMs() - startedAt < this.options.stableReadDeadlineMs
    ) {
      await this.dependencies.clock.sleep(this.options.retryDelayMs * (attempt + 1));
    }
  }

  private async findRegistration(
    pending: PendingFileObservation
  ): Promise<ExternalFileRegistration | null> {
    const registrations = await this.listRegistrations(pending.scope);
    return registrations.find((registration) => registration.fileKey === pending.fileKey) ?? null;
  }

  private async listScopes(): Promise<readonly ExternalWriterScope[]> {
    const scopes = await this.dependencies.catalog.listScopes();
    if (scopes.length > this.options.maxScopes) {
      throw new ExternalWriterObserverError('catalog_invalid');
    }
    const seen = new Set<string>();
    for (const scope of scopes) {
      const key = `${scope.teamId.length}:${scope.teamId}${scope.featureKey.length}:${scope.featureKey}`;
      if (scope.teamId.length === 0 || scope.featureKey.length === 0 || seen.has(key)) {
        throw new ExternalWriterObserverError('catalog_invalid');
      }
      seen.add(key);
    }
    return scopes;
  }

  private async listRegistrations(
    scope: ExternalWriterScope
  ): Promise<readonly ExternalFileRegistration[]> {
    const registrations = await this.dependencies.catalog.listRegistrations(scope);
    if (registrations.length > this.options.maxFilesPerScope) {
      throw new ExternalWriterObserverError('catalog_invalid');
    }
    const seen = new Set<string>();
    for (const registration of registrations) {
      if (
        !scopesEqual(registration.scope, scope) ||
        registration.fileKey.length === 0 ||
        !isSafePositiveInteger(registration.maxBytes) ||
        registration.maxBytes > this.options.maxReadBytes ||
        (registration.attributionPolicy !== 'external_file_only' &&
          registration.attributionPolicy !== 'verified_run_evidence') ||
        seen.has(registration.fileKey)
      ) {
        throw new ExternalWriterObserverError('catalog_invalid');
      }
      seen.add(registration.fileKey);
    }
    return registrations;
  }

  private async persist(): Promise<void> {
    await this.dependencies.stateStore.save(this.state.snapshot());
  }

  private captureTeamQuiescenceFence(teamId: TeamId): TeamQuiescenceFence {
    return {
      fileWriterEpoch: this.state.getFileWriterEpoch(teamId),
      lastObservationSequence: this.state.getLastTeamObservationSequence(teamId),
      observationWatermark: this.state.getTeamObservationWatermark(teamId),
      clean: this.state.isTeamClean(teamId),
    };
  }

  private sameTeamQuiescenceFence(left: TeamQuiescenceFence, right: TeamQuiescenceFence): boolean {
    return (
      left.fileWriterEpoch === right.fileWriterEpoch &&
      left.lastObservationSequence === right.lastObservationSequence &&
      left.observationWatermark === right.observationWatermark &&
      left.clean === right.clean
    );
  }

  private stateLimits(): {
    maxPendingObservations: number;
    maxSelfWriteIntents: number;
    maxObservationAttempts: number;
    maxScopes: number;
    maxObservedFiles: number;
  } {
    return {
      maxPendingObservations: this.options.maxPendingObservations,
      maxSelfWriteIntents: this.options.maxSelfWriteIntents,
      maxObservationAttempts: this.options.maxObservationAttempts,
      maxScopes: this.options.maxScopes,
      maxObservedFiles: this.options.maxObservedFiles,
    };
  }

  private assertOptions(): void {
    const positiveIntegerOptions = [
      this.options.maxPendingObservations,
      this.options.maxSelfWriteIntents,
      this.options.maxScopes,
      this.options.maxObservedFiles,
      this.options.maxFilesPerScope,
      this.options.maxReadBytes,
      this.options.maxStableReadAttempts,
      this.options.maxObservationAttempts,
      this.options.maxDrainPassObservations,
      this.options.maxQuiescenceAttempts,
    ];
    if (
      positiveIntegerOptions.some((value) => !isSafePositiveInteger(value)) ||
      !isSafeNonNegativeInteger(this.options.stableReadDeadlineMs) ||
      !isSafeNonNegativeInteger(this.options.retryDelayMs) ||
      !isSafeNonNegativeInteger(this.options.atomicReplaceDebounceMs) ||
      !isSafeNonNegativeInteger(this.options.shutdownDrainDeadlineMs)
    ) {
      throw new ExternalWriterObserverError('options_invalid');
    }
  }
}
