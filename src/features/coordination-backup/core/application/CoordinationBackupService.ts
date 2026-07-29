import {
  type BackupCommitMarker,
  type BackupExclusion,
  type BackupManifest,
  type BackupManifestBody,
  type BackupManifestEntry,
  type BackupRunId,
  type BackupRunRecord,
  type BackupVerificationPlan,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION,
  type FlushedBackupParticipant,
  type ImmutableBackupInspection,
  type PreparedBackupParticipant,
  type RequestCoordinationBackup,
  type RestoreSetValidationRequest,
  type RestoreSetValidationResult,
  SQLITE_ONLINE_BACKUP_METHOD,
  type SqliteIntegrityEvidence,
} from '../../contracts';
import {
  assertBackupRunRecord,
  isActiveBackupRunState,
  validateCoordinationBackupRestoreSet,
  validateImmutableBackupInspection,
} from '../domain';

import {
  assertAcceptedCommandDrain,
  assertCompletedFenceRecord,
  assertCoordinationBarrierEvidence,
  assertFlushedParticipant,
  assertParticipantContract,
  assertPreparedParticipant,
  assertRequestedRun,
  assertRunState,
  assertVerificationPlanMatchesRun,
  asServiceError,
  classifyExecutionFault,
  contractFault,
  normalizeParticipants,
  pendingFenceCompletion,
  pendingFenceCompletionFor,
  replaceTerminalRecord,
  requireBackupRun,
  requireParticipantEvidence,
  sortEntries,
  sortExclusions,
  sortFlushedParticipants,
  transitionBackupRun,
} from './coordinationBackupServiceSupport';
import {
  BackupExecutionFault,
  type CoordinationBackupServiceDependencies,
  CoordinationBackupServiceError,
} from './coordinationBackupServiceTypes';

import type {
  BackupRunRepository,
  BackupWriterFenceLease,
  BackupWriterFencePort,
  CoordinationBackupParticipant,
} from './ports';

export {
  type CoordinationBackupServiceDependencies,
  CoordinationBackupServiceError,
  type CoordinationBackupServiceErrorCode,
} from './coordinationBackupServiceTypes';

export class CoordinationBackupService {
  private readonly participants: readonly CoordinationBackupParticipant[];
  constructor(private readonly dependencies: CoordinationBackupServiceDependencies) {
    this.participants = normalizeParticipants(dependencies.participants);
  }

  async createCoordinationBackup(request: RequestCoordinationBackup): Promise<BackupRunRecord> {
    const requestedAt = this.dependencies.clock.nowIso();
    const run = await this.dependencies.runs.create({
      ...request,
      requestedAt,
      participantDescriptors: this.participants.map((participant) => participant.descriptor),
    });
    assertRequestedRun(run, request, this.participants);
    return this.resume(run);
  }

  async recoverBackupRun(backupRunId: BackupRunId): Promise<BackupRunRecord> {
    const run = await this.dependencies.runs.get(backupRunId);
    if (!run) {
      throw new CoordinationBackupServiceError('run_not_found', 'BackupRun was not found');
    }
    assertBackupRunRecord(run);
    if (isActiveBackupRunState(run.state)) assertParticipantContract(run, this.participants);
    return this.resume(run);
  }

  async recoverAllBackupRuns(): Promise<readonly BackupRunRecord[]> {
    const recoverable = await this.dependencies.runs.listRecoverable();
    const recovered: BackupRunRecord[] = [];
    for (const run of recoverable) {
      assertBackupRunRecord(run);
      if (isActiveBackupRunState(run.state)) assertParticipantContract(run, this.participants);
      recovered.push(await this.resume(run));
    }
    return Object.freeze(recovered);
  }

  async verifyCommittedBackup(backupRunId: BackupRunId): Promise<ImmutableBackupInspection> {
    const run = await this.requireRun(backupRunId);
    if (run.state !== 'committed' || !run.verificationPlan || !run.publication) {
      throw new CoordinationBackupServiceError(
        'run_contract_invalid',
        'Only a durably committed BackupRun can be verified',
        run
      );
    }
    try {
      return await this.verifyImmutable(run, 'committed');
    } catch (error) {
      throw asServiceError(error, run);
    }
  }

  validateRestoreSet(request: RestoreSetValidationRequest): RestoreSetValidationResult {
    return validateCoordinationBackupRestoreSet(request);
  }

  private async resume(initial: BackupRunRecord): Promise<BackupRunRecord> {
    let run = initial;
    let lease: BackupWriterFenceLease | null = null;
    let result: BackupRunRecord | null = null;
    let pendingError: Error | null = null;

    try {
      if (run.state === 'committed') {
        await this.verifyImmutable(run, 'committed');
        result = run;
      } else if (run.state === 'failed' || run.state === 'operator_required') {
        result = run;
      } else if (run.state === 'artifact_source') {
        throw new CoordinationBackupServiceError(
          'run_contract_invalid',
          'An artifact_source record cannot execute on the source deployment',
          run
        );
      } else {
        while (isActiveBackupRunState(run.state)) {
          if (run.state === 'requested') {
            run = await this.transition(run, {
              backupRunId: run.backupRunId,
              expectedRevision: run.revision,
              from: 'requested',
              to: 'fencing',
              at: this.dependencies.clock.nowIso(),
            });
            continue;
          }

          lease ??= await this.acquireFence(run);
          if (run.state === 'fencing') {
            run = await this.performFencing(run, lease);
          } else if (run.state === 'quiescing') {
            run = await this.performQuiescing(run, lease);
          } else if (run.state === 'sqlite_snapshot') {
            run = await this.performSqliteSnapshot(run, lease);
          } else if (run.state === 'file_stage') {
            run = await this.performFileStage(run, lease);
          } else {
            run = await this.performVerificationAndPublication(run);
          }
        }
        result = run;
      }
    } catch (error) {
      if (error instanceof CoordinationBackupServiceError) {
        pendingError = error;
      } else {
        try {
          run = await this.reconcileFailure(run.backupRunId, error, lease);
          if (run.state === 'committed') result = run;
          else {
            pendingError = new CoordinationBackupServiceError(
              run.state === 'operator_required'
                ? 'backup_run_operator_required'
                : 'backup_run_failed',
              run.state === 'operator_required'
                ? 'BackupRun requires operator review'
                : 'BackupRun failed closed',
              run,
              { cause: error }
            );
          }
        } catch (reconciliationError) {
          pendingError = asServiceError(reconciliationError, run);
        }
      }
    }

    if (run.fenceCompletion?.status === 'pending') {
      try {
        run = await this.completeFence(run, lease);
        if (result) result = run;
        if (pendingError) pendingError = replaceTerminalRecord(pendingError, run);
      } catch (error) {
        pendingError = new CoordinationBackupServiceError(
          'fence_completion_failed',
          'Backup writer fence completion failed; mutation admission must remain closed',
          run,
          { cause: error }
        );
      }
    }

    if (pendingError) throw pendingError;
    if (!result) throw contractFault('backup_run_result_missing');
    return result;
  }

  private async performFencing(
    run: BackupRunRecord,
    lease: BackupWriterFenceLease
  ): Promise<BackupRunRecord> {
    assertRunState(run, 'fencing');
    return this.transition(run, {
      backupRunId: run.backupRunId,
      expectedRevision: run.revision,
      from: 'fencing',
      to: 'quiescing',
      at: this.dependencies.clock.nowIso(),
      fence: lease.evidence,
      fenceLeaseId: lease.leaseId,
    });
  }

  private async performQuiescing(
    run: BackupRunRecord,
    lease: BackupWriterFenceLease
  ): Promise<BackupRunRecord> {
    assertRunState(run, 'quiescing');
    const acceptedCommandDrain = await this.dependencies.coordinationFlush.drainAcceptedCommands({
      backupRunId: run.backupRunId,
      fence: lease.evidence,
    });
    assertAcceptedCommandDrain(run, lease, acceptedCommandDrain);

    const prepared: PreparedBackupParticipant[] = [];
    const flushed: FlushedBackupParticipant[] = [];
    for (const participant of this.participants) {
      const preparedEvidence = await participant.prepare({
        backupRunId: run.backupRunId,
        fence: lease.evidence,
      });
      assertPreparedParticipant(participant.descriptor, preparedEvidence);
      prepared.push(preparedEvidence);
      const evidence = await participant.flush({
        backupRunId: run.backupRunId,
        fence: lease.evidence,
        prepared: preparedEvidence,
      });
      assertFlushedParticipant(participant.descriptor, preparedEvidence, evidence);
      flushed.push(evidence);
    }

    const coordinationBarrier = await this.dependencies.coordinationFlush.captureBarrier({
      backupRunId: run.backupRunId,
      fence: lease.evidence,
      acceptedCommandDrain,
      participants: flushed,
    });
    assertCoordinationBarrierEvidence(
      run,
      lease,
      acceptedCommandDrain,
      flushed,
      coordinationBarrier
    );
    const identityInventory = await this.dependencies.identityInventory.capture({
      backupRunId: run.backupRunId,
      fence: lease.evidence,
      barrier: coordinationBarrier,
    });
    if (
      identityInventory.schemaVersion !== COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION ||
      identityInventory.deploymentId !== run.deploymentId
    ) {
      throw contractFault('identity_inventory_deployment_mismatch');
    }

    return this.transition(run, {
      backupRunId: run.backupRunId,
      expectedRevision: run.revision,
      from: 'quiescing',
      to: 'sqlite_snapshot',
      at: this.dependencies.clock.nowIso(),
      preparedParticipants: Object.freeze(prepared),
      flushedParticipants: Object.freeze(flushed),
      coordinationBarrier,
      identityInventory,
    });
  }

  private async performSqliteSnapshot(
    run: BackupRunRecord,
    lease: BackupWriterFenceLease
  ): Promise<BackupRunRecord> {
    assertRunState(run, 'sqlite_snapshot');
    if (!run.coordinationBarrier || !run.flushedParticipants) {
      throw contractFault('sqlite_recovery_point_evidence_missing');
    }
    await this.dependencies.publication.preparePrivateStage(run.backupRunId);
    const result = await this.dependencies.onlineBackup.createOnlineSnapshot({
      backupRunId: run.backupRunId,
      fence: lease.evidence,
      coordinationBarrier: run.coordinationBarrier,
      participants: run.flushedParticipants,
    });
    if (result.status === 'failed') {
      throw new BackupExecutionFault(
        `online_backup_${result.reason}`,
        'failed',
        'SQLite Online Backup API snapshot failed'
      );
    }
    if (
      result.snapshot.method !== SQLITE_ONLINE_BACKUP_METHOD ||
      result.snapshot.sourceRunId !== run.backupRunId ||
      result.snapshot.entry.kind !== 'sqlite_snapshot'
    ) {
      throw contractFault('online_backup_evidence_invalid');
    }
    return this.transition(run, {
      backupRunId: run.backupRunId,
      expectedRevision: run.revision,
      from: 'sqlite_snapshot',
      to: 'file_stage',
      at: this.dependencies.clock.nowIso(),
      sqliteSnapshot: result.snapshot,
    });
  }

  private async performFileStage(
    run: BackupRunRecord,
    lease: BackupWriterFenceLease
  ): Promise<BackupRunRecord> {
    assertRunState(run, 'file_stage');
    if (!run.flushedParticipants || !run.sqliteSnapshot) {
      throw contractFault('file_stage_evidence_missing');
    }
    const entries: BackupManifestEntry[] = [];
    const exclusions: BackupExclusion[] = [];
    const entryIds = new Set<string>([run.sqliteSnapshot.entry.entryId]);

    for (const participant of this.participants) {
      const flushed = requireParticipantEvidence(
        run.flushedParticipants,
        participant.descriptor.participantId
      );
      const staged = await participant.stage({
        backupRunId: run.backupRunId,
        fence: lease.evidence,
        flushed,
      });
      if (staged.participantId !== participant.descriptor.participantId) {
        throw contractFault('staged_participant_id_mismatch');
      }
      for (const entry of staged.entries) {
        if (
          entry.participantId !== participant.descriptor.participantId ||
          entry.kind === 'sqlite_snapshot' ||
          entry.sourceGeneration !== flushed.sourceGeneration ||
          entryIds.has(entry.entryId)
        ) {
          throw contractFault('staged_entry_invalid');
        }
        entryIds.add(entry.entryId);
        entries.push(entry);
      }
      for (const exclusion of staged.exclusions) {
        if (exclusion.participantId !== participant.descriptor.participantId) {
          throw contractFault('staged_exclusion_invalid');
        }
        exclusions.push(exclusion);
      }
    }

    return this.transition(run, {
      backupRunId: run.backupRunId,
      expectedRevision: run.revision,
      from: 'file_stage',
      to: 'verifying',
      at: this.dependencies.clock.nowIso(),
      stagedEntries: Object.freeze(sortEntries(entries)),
      exclusions: Object.freeze(sortExclusions(exclusions)),
    });
  }

  private async performVerificationAndPublication(
    initial: BackupRunRecord
  ): Promise<BackupRunRecord> {
    assertRunState(initial, 'verifying');
    let run: BackupRunRecord = initial;
    const publication = await this.dependencies.publication.inspect(run.backupRunId);
    if (publication.status === 'ambiguous') {
      throw new BackupExecutionFault(
        'publication_ambiguous',
        'operator_required',
        'Backup publication state is ambiguous'
      );
    }
    if (publication.status === 'committed') {
      return this.commitRecoveredPublication(run, publication.publication);
    }
    if (publication.status === 'absent') {
      throw new BackupExecutionFault(
        'publication_missing',
        'failed',
        'Backup private stage is missing'
      );
    }
    if (publication.status === 'staging_sealed') {
      if (!run.verificationPlan) throw contractFault('sealed_stage_plan_missing');
      return this.commitSealedStage(run);
    }

    const integrity = await this.checkSqliteIntegrity(run);
    await this.verifyParticipants(run);
    if (!run.verificationPlan) {
      const plan = await this.buildVerificationPlan(run, integrity);
      run = await this.dependencies.runs.saveVerificationPlan({
        backupRunId: run.backupRunId,
        expectedRevision: run.revision,
        plan,
        at: this.dependencies.clock.nowIso(),
      });
      assertBackupRunRecord(run);
      if (run.state !== 'verifying' || !run.verificationPlan) {
        throw contractFault('verification_plan_not_durable');
      }
    } else {
      assertVerificationPlanMatchesRun(run);
    }

    await this.dependencies.publication.writeRootManifest({
      backupRunId: run.backupRunId,
      manifest: run.verificationPlan.manifest,
    });
    await this.dependencies.publication.writeCommitMarkerLast({
      backupRunId: run.backupRunId,
      marker: run.verificationPlan.marker,
    });
    return this.commitSealedStage(run);
  }

  private async checkSqliteIntegrity(run: BackupRunRecord): Promise<SqliteIntegrityEvidence> {
    if (!run.sqliteSnapshot) throw contractFault('sqlite_snapshot_missing');
    const result = await this.dependencies.sqliteIntegrity.reopenAndCheck({
      backupRunId: run.backupRunId,
      snapshot: run.sqliteSnapshot,
    });
    if (result.status === 'invalid') {
      throw new BackupExecutionFault(
        `sqlite_${result.reason}`,
        'failed',
        'Independently reopened SQLite snapshot failed integrity validation'
      );
    }
    if (
      result.evidence.applicationId !== run.sqliteSnapshot.applicationId ||
      result.evidence.userVersion !== run.sqliteSnapshot.userVersion
    ) {
      throw contractFault('sqlite_integrity_evidence_mismatch');
    }
    return result.evidence;
  }

  private async verifyParticipants(run: BackupRunRecord): Promise<void> {
    if (!run.flushedParticipants || !run.stagedEntries || !run.fence) {
      throw contractFault('participant_verification_evidence_missing');
    }
    for (const participant of this.participants) {
      const flushed = requireParticipantEvidence(
        run.flushedParticipants,
        participant.descriptor.participantId
      );
      const stagedEntries = run.stagedEntries.filter(
        (entry) => entry.participantId === participant.descriptor.participantId
      );
      const result = await participant.verify({
        backupRunId: run.backupRunId,
        fence: run.fence,
        flushed,
        stagedEntries,
      });
      if (result.status !== 'verified') {
        throw new BackupExecutionFault(
          'participant_verification_failed',
          'failed',
          'A required backup participant failed immutable verification'
        );
      }
    }
  }

  private async buildVerificationPlan(
    run: BackupRunRecord,
    sqliteIntegrity: BackupManifestBody['sqliteIntegrity']
  ): Promise<BackupVerificationPlan> {
    assertRunState(run, 'verifying');
    if (
      !run.fence ||
      !run.coordinationBarrier ||
      !run.identityInventory ||
      !run.flushedParticipants ||
      !run.sqliteSnapshot ||
      !run.stagedEntries ||
      !run.exclusions
    ) {
      throw contractFault('manifest_evidence_missing');
    }
    const sealedAt = this.dependencies.clock.nowIso();
    const body: BackupManifestBody = Object.freeze({
      format: COORDINATION_BACKUP_FORMAT,
      backupRunId: run.backupRunId,
      sourceBackupRunId: run.backupRunId,
      productKind: run.productKind,
      purpose: run.purpose,
      deploymentId: run.deploymentId,
      requestedAt: run.requestedAt,
      sealedAt,
      fenceGeneration: run.fence.generation,
      coordinationBarrier: run.coordinationBarrier,
      identityInventory: run.identityInventory,
      participants: Object.freeze(sortFlushedParticipants(run.flushedParticipants)),
      sqliteSnapshot: run.sqliteSnapshot,
      sqliteIntegrity,
      entries: Object.freeze(sortEntries([run.sqliteSnapshot.entry, ...run.stagedEntries])),
      exclusions: Object.freeze(sortExclusions(run.exclusions)),
    });
    const manifestHash = await this.dependencies.manifestHash.hashCanonicalManifest(body);
    const manifest: BackupManifest = Object.freeze({ ...body, manifestHash });
    const marker: BackupCommitMarker = Object.freeze({
      format: COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
      backupRunId: run.backupRunId,
      deploymentId: run.deploymentId,
      manifestHash,
      sealedAt,
    });
    return Object.freeze({ manifest, marker });
  }

  private async commitSealedStage(run: BackupRunRecord): Promise<BackupRunRecord> {
    assertRunState(run, 'verifying');
    if (!run.verificationPlan) throw contractFault('verification_plan_missing');
    await this.verifyImmutable(run, 'staging');
    const publication = await this.dependencies.publication.commitSealedStage({
      backupRunId: run.backupRunId,
      manifestHash: run.verificationPlan.manifest.manifestHash,
    });
    await this.verifyImmutable(run, 'committed');
    return this.completeCommittedTransition(run, publication);
  }

  private async commitRecoveredPublication(
    run: BackupRunRecord,
    publication: NonNullable<BackupRunRecord['publication']>
  ): Promise<BackupRunRecord> {
    assertRunState(run, 'verifying');
    if (!run.verificationPlan) throw contractFault('committed_publication_plan_missing');
    await this.verifyImmutable(run, 'committed');
    return this.completeCommittedTransition(run, publication);
  }

  private async completeCommittedTransition(
    run: BackupRunRecord,
    publication: NonNullable<BackupRunRecord['publication']>
  ): Promise<BackupRunRecord> {
    assertRunState(run, 'verifying');
    if (
      !run.verificationPlan ||
      publication.backupRunId !== run.backupRunId ||
      publication.manifestHash !== run.verificationPlan.manifest.manifestHash
    ) {
      throw contractFault('committed_publication_mismatch');
    }
    return this.transition(run, {
      backupRunId: run.backupRunId,
      expectedRevision: run.revision,
      from: 'verifying',
      to: 'committed',
      at: this.dependencies.clock.nowIso(),
      publication,
      fenceCompletion: pendingFenceCompletion(run, 'committed'),
    });
  }

  private async verifyImmutable(
    run: BackupRunRecord,
    location: 'staging' | 'committed'
  ): Promise<ImmutableBackupInspection> {
    if (!run.verificationPlan) throw contractFault('verification_plan_missing');
    const result = await this.dependencies.immutableVerifier.verify({
      backupRunId: run.backupRunId,
      location,
      expectedPlan: run.verificationPlan,
    });
    if (result.status === 'invalid') {
      throw new BackupExecutionFault(
        'immutable_verification_failed',
        location === 'committed' ? 'operator_required' : 'failed',
        'Immutable backup verification failed'
      );
    }
    const domainValidation = validateImmutableBackupInspection(result.inspection);
    if (
      domainValidation.status === 'invalid' ||
      result.inspection.manifest.manifestHash !== run.verificationPlan.manifest.manifestHash ||
      result.inspection.marker.manifestHash !== run.verificationPlan.marker.manifestHash
    ) {
      throw new BackupExecutionFault(
        'immutable_verification_failed',
        location === 'committed' ? 'operator_required' : 'failed',
        'Immutable backup evidence disagrees with the durable verification plan'
      );
    }
    return result.inspection;
  }

  private async reconcileFailure(
    backupRunId: BackupRunId,
    error: unknown,
    lease: BackupWriterFenceLease | null
  ): Promise<BackupRunRecord> {
    let run = await this.requireRun(backupRunId);
    if (run.state === 'committed') {
      await this.verifyImmutable(run, 'committed');
      return run;
    }
    if (run.state === 'failed' || run.state === 'operator_required') return run;
    if (!isActiveBackupRunState(run.state)) throw error;

    const fault = classifyExecutionFault(error);
    let disposition = fault.disposition;
    if (run.state === 'verifying') {
      try {
        const inspection = await this.dependencies.publication.inspect(run.backupRunId);
        if (inspection.status === 'committed' && run.verificationPlan) {
          return await this.commitRecoveredPublication(run, inspection.publication);
        }
        if (inspection.status === 'staging_sealed' && run.verificationPlan) {
          return await this.commitSealedStage(run);
        }
        if (inspection.status === 'ambiguous') disposition = 'operator_required';
        else await this.dependencies.publication.abortUncommittedStage(run.backupRunId);
      } catch {
        disposition = 'operator_required';
      }
    } else {
      try {
        await this.dependencies.publication.abortUncommittedStage(run.backupRunId);
      } catch {
        disposition = 'operator_required';
      }
    }

    run = await this.requireRun(backupRunId);
    if (!isActiveBackupRunState(run.state)) return run;
    const durableFence = run.fence ?? lease?.evidence ?? null;
    const durableFenceLeaseId = run.fenceLeaseId ?? lease?.leaseId ?? null;
    return this.transition(run, {
      backupRunId: run.backupRunId,
      expectedRevision: run.revision,
      from: run.state,
      to: disposition,
      at: this.dependencies.clock.nowIso(),
      failure: {
        code: fault.code,
        phase: run.state,
        safeMessage: fault.safeMessage,
      },
      fence: durableFence,
      fenceLeaseId: durableFenceLeaseId,
      fenceCompletion: durableFence
        ? pendingFenceCompletionFor(
            durableFence.generation,
            disposition === 'failed' ? 'aborted' : 'operator_required'
          )
        : null,
    });
  }

  private async acquireFence(run: BackupRunRecord): Promise<BackupWriterFenceLease> {
    let result: Awaited<ReturnType<BackupWriterFencePort['acquire']>>;
    try {
      result = await this.dependencies.writerFence.acquire({
        backupRunId: run.backupRunId,
        expectedGeneration: run.fence?.generation ?? null,
      });
    } catch (error) {
      throw new BackupExecutionFault(
        'writer_fence_acquire_failed',
        'operator_required',
        'Writer fence acquisition outcome is unknown',
        { cause: error }
      );
    }
    if (result.status === 'busy') {
      throw new CoordinationBackupServiceError(
        'backup_fence_busy',
        'Another BackupRun currently owns the deployment writer fence',
        run
      );
    }
    const { lease } = result;
    if (!lease.leaseId) throw contractFault('fence_lease_id_missing');
    if (lease.evidence.admittedRunId !== run.backupRunId) {
      throw contractFault('fence_run_mismatch');
    }
    if (run.fence && lease.evidence.generation !== run.fence.generation) {
      throw new BackupExecutionFault(
        'fence_generation_mismatch',
        'operator_required',
        'Recovered writer fence generation does not match durable BackupRun evidence'
      );
    }
    if (run.fenceLeaseId && lease.leaseId !== run.fenceLeaseId) {
      throw new BackupExecutionFault(
        'fence_lease_mismatch',
        'operator_required',
        'Recovered writer fence lease does not match durable BackupRun evidence'
      );
    }
    return lease;
  }

  private async completeFence(
    run: BackupRunRecord,
    acquiredLease: BackupWriterFenceLease | null
  ): Promise<BackupRunRecord> {
    const completion = run.fenceCompletion;
    if (!completion || completion.status === 'completed') return run;
    if (!run.fence || !run.fenceLeaseId) throw contractFault('fence_completion_evidence_missing');
    if (
      acquiredLease &&
      (acquiredLease.leaseId !== run.fenceLeaseId ||
        acquiredLease.evidence.generation !== run.fence.generation ||
        acquiredLease.evidence.admittedRunId !== run.backupRunId)
    ) {
      throw contractFault('fence_completion_lease_mismatch');
    }

    await this.dependencies.writerFence.complete({
      lease: { leaseId: run.fenceLeaseId, evidence: run.fence },
      disposition: completion.disposition,
    });

    try {
      const completed = await this.dependencies.runs.markFenceCompleted({
        backupRunId: run.backupRunId,
        expectedRevision: run.revision,
        generation: completion.generation,
        disposition: completion.disposition,
        completedAt: this.dependencies.clock.nowIso(),
      });
      assertCompletedFenceRecord(run, completed);
      return completed;
    } catch (error) {
      const recovered = await this.requireRun(run.backupRunId);
      if (
        recovered.fenceCompletion?.status === 'completed' &&
        recovered.fenceCompletion.generation === completion.generation &&
        recovered.fenceCompletion.disposition === completion.disposition
      ) {
        return recovered;
      }
      throw error;
    }
  }

  private async requireRun(backupRunId: BackupRunId): Promise<BackupRunRecord> {
    return requireBackupRun(this.dependencies.runs, backupRunId);
  }

  private async transition(
    current: BackupRunRecord,
    request: Parameters<BackupRunRepository['transition']>[0]
  ): Promise<BackupRunRecord> {
    return transitionBackupRun(this.dependencies.runs, current, request);
  }
}
