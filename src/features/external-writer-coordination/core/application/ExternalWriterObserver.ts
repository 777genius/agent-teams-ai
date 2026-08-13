import {
  type ExternalFileRegistration,
  type ExternalObservationCause,
  type ExternalSelfWriteIntent,
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
} from '../../contracts';
import { buildExternalFileReconciliationId, FileObservationState } from '../domain';

import {
  assertExternalWriterObserverOptions,
  classifyExternalWriterActor,
  DEFAULT_OPTIONS,
  type ExternalWriterObserverDependencies,
  ExternalWriterObserverError,
  externalWriterStateLimits,
  fingerprintsEqual,
  isClosedReconciliationResult,
  isSafePositiveInteger,
  readStableExternalFile,
  scopesEqual,
  type TeamQuiescenceFence,
} from './externalWriterObserverSupport';

import type {
  ExternalWriterCleanHandoffEligibilityPlan,
  ExternalWriterWatchHandle,
} from './ports';
import type { TeamId } from '@shared/contracts/hosted/identifiers';

export {
  type ExternalWriterObserverDependencies,
  ExternalWriterObserverError,
} from './externalWriterObserverSupport';

export class ExternalWriterObserver {
  private readonly options: ExternalWriterObserverOptions;
  private state: FileObservationState;
  private phase: ExternalWriterObserverPhase = 'idle';
  private acceptingNotifications = false;
  private watchHandle: ExternalWriterWatchHandle | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private retryableCleanHandoff: {
    readonly checkpoint: ReturnType<FileObservationState['snapshot']>;
    readonly plan: ExternalWriterCleanHandoffEligibilityPlan | null;
    readonly result: ExternalWriterShutdownHandoff;
  } | null = null;

  constructor(
    private readonly dependencies: ExternalWriterObserverDependencies,
    options: Partial<ExternalWriterObserverOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    assertExternalWriterObserverOptions(this.options);
    this.state = FileObservationState.create(externalWriterStateLimits(this.options));
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
        this.state = FileObservationState.restore(
          checkpoint,
          externalWriterStateLimits(this.options)
        );
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

  shutdown(
    deadlineMs?: number,
    cleanHandoffPlan?: ExternalWriterCleanHandoffEligibilityPlan
  ): Promise<ExternalWriterShutdownHandoff> {
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
      const dirtyScopes = this.state.getDirtyScopes();
      const pendingObservationCount = this.state.getPendingObservationCount();
      this.state.pruneExpiredSelfWriteIntents(this.dependencies.clock.nowMs());
      const checkpoint = this.state.snapshot();
      const retiredTeams = new Set(
        cleanHandoffPlan?.retirementProofs.map(({ teamId }) => teamId) ?? []
      );
      const retainedRegistrations = new Set(
        cleanHandoffPlan?.retainedRegistrations.map(
          ({ scope, fileKey }) => `${scope.teamId}\0${scope.featureKey}\0${fileKey}`
        ) ?? []
      );
      const selfWriteIntentsSafeForHandoff = checkpoint.selfWriteIntents.every(
        (intent) =>
          !retiredTeams.has(intent.scope.teamId) &&
          retainedRegistrations.has(
            `${intent.scope.teamId}\0${intent.scope.featureKey}\0${intent.fileKey}`
          )
      );
      const deadlineExceeded = !drained && this.dependencies.clock.nowMs() >= effectiveDeadline;
      const clean =
        !deadlineExceeded &&
        !closeFailed &&
        dirtyScopes.length === 0 &&
        pendingObservationCount === 0 &&
        (!cleanHandoffPlan || selfWriteIntentsSafeForHandoff);
      const result: ExternalWriterShutdownHandoff = {
        status: deadlineExceeded ? 'deadline_exceeded' : clean ? 'clean' : 'dirty',
        capturedSequence,
        persistedWatermark: this.state.getObservationWatermark(),
        dirtyScopes,
        pendingObservationCount,
      };
      if (clean && cleanHandoffPlan) {
        this.retryableCleanHandoff = { checkpoint, plan: cleanHandoffPlan, result };
        await this.dependencies.stateStore.saveCleanHandoffEligibility(
          checkpoint,
          cleanHandoffPlan
        );
      } else {
        this.retryableCleanHandoff = { checkpoint, plan: null, result };
        await this.persist();
      }
      this.phase = 'stopped';
      this.retryableCleanHandoff = null;
      return result;
    });
  }

  /** Retries only the exact final checkpoint/plan after a lost storage response. */
  retryCleanHandoffEligibility(): Promise<ExternalWriterShutdownHandoff> {
    return this.schedule(async () => {
      const retry = this.retryableCleanHandoff;
      if (this.phase !== 'stopping' || !retry) {
        throw new ExternalWriterObserverError('not_running');
      }
      if (retry.plan === null) {
        await this.dependencies.stateStore.save(retry.checkpoint);
      } else {
        await this.dependencies.stateStore.saveCleanHandoffEligibility(
          retry.checkpoint,
          retry.plan
        );
      }
      this.retryableCleanHandoff = null;
      this.phase = 'stopped';
      return retry.result;
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
    const stableRead = await readStableExternalFile(this.dependencies, this.options, registration);
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
    const actor = await classifyExternalWriterActor(this.dependencies, {
      registration,
      content: stableRead.content,
      checksum: stableRead.fingerprint.checksum,
      observationSequence: pending.latestSequence,
      fileWriterEpoch: pending.fileWriterEpoch,
    });
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
}
