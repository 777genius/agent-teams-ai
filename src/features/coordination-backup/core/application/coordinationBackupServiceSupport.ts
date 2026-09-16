import {
  type BackupAcceptedCommandDrain,
  type BackupCoordinationBarrier,
  type BackupExclusion,
  type BackupFenceCompletionDisposition,
  type BackupManifestEntry,
  type BackupParticipantDescriptor,
  type BackupRunId,
  type BackupRunRecord,
  COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION,
  type FlushedBackupParticipant,
  type PendingBackupFenceCompletion,
  type PreparedBackupParticipant,
  type RequestCoordinationBackup,
} from '../../contracts';
import {
  assertBackupRunRecord,
  BackupRunInvariantError,
  transitionBackupRunState,
} from '../domain';

import {
  BackupExecutionFault,
  CoordinationBackupServiceError,
} from './coordinationBackupServiceTypes';

import type {
  BackupRunRepository,
  BackupWriterFenceLease,
  CoordinationBackupParticipant,
} from './ports';

export function assertTransitionEvidenceMatches(
  request: Parameters<BackupRunRepository['transition']>[0],
  next: BackupRunRecord
): void {
  if (request.to === 'quiescing') {
    if (
      next.fenceLeaseId !== request.fenceLeaseId ||
      next.fence?.admittedRunId !== request.fence.admittedRunId ||
      next.fence.generation !== request.fence.generation
    ) {
      throw contractFault('transition_fence_evidence_mismatch');
    }
    return;
  }
  if (request.to === 'committed') {
    if (
      next.publication?.backupRunId !== request.publication.backupRunId ||
      next.publication.manifestHash !== request.publication.manifestHash ||
      next.publication.immutableGeneration !== request.publication.immutableGeneration ||
      next.fenceCompletion?.status !== 'pending' ||
      next.fenceCompletion.generation !== request.fenceCompletion.generation ||
      next.fenceCompletion.disposition !== request.fenceCompletion.disposition
    ) {
      throw contractFault('transition_commit_evidence_mismatch');
    }
    return;
  }
  if (request.to === 'failed' || request.to === 'operator_required') {
    const completionMatches = request.fenceCompletion
      ? next.fenceCompletion?.status === 'pending' &&
        next.fenceCompletion.generation === request.fenceCompletion.generation &&
        next.fenceCompletion.disposition === request.fenceCompletion.disposition
      : next.fenceCompletion === null;
    if (
      next.failure?.code !== request.failure.code ||
      next.failure.phase !== request.failure.phase ||
      next.failure.safeMessage !== request.failure.safeMessage ||
      next.fenceLeaseId !== request.fenceLeaseId ||
      next.fence?.admittedRunId !== request.fence?.admittedRunId ||
      next.fence?.generation !== request.fence?.generation ||
      !completionMatches
    ) {
      throw contractFault('transition_failure_evidence_mismatch');
    }
  }
}

export function normalizeParticipants(
  participants: readonly CoordinationBackupParticipant[]
): readonly CoordinationBackupParticipant[] {
  const normalized = participants.map((participant) =>
    Object.freeze({
      descriptor: Object.freeze({ ...participant.descriptor }),
      prepare: (request: Parameters<typeof participant.prepare>[0]) => participant.prepare(request),
      flush: (request: Parameters<typeof participant.flush>[0]) => participant.flush(request),
      stage: (request: Parameters<typeof participant.stage>[0]) => participant.stage(request),
      verify: (request: Parameters<typeof participant.verify>[0]) => participant.verify(request),
    })
  );
  const sorted = normalized.toSorted((left, right) =>
    left.descriptor.participantId.localeCompare(right.descriptor.participantId)
  );
  const ids = new Set<string>();
  for (const participant of sorted) {
    const descriptor = participant.descriptor;
    if (
      !descriptor.participantId ||
      !descriptor.kind ||
      descriptor.contractVersion !== COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION ||
      descriptor.schemaVersion !== COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION ||
      ids.has(descriptor.participantId)
    ) {
      throw new BackupRunInvariantError(
        'invalid_record',
        'Coordination backup participant descriptor is invalid or duplicated',
        { participantId: descriptor.participantId }
      );
    }
    ids.add(descriptor.participantId);
  }
  return Object.freeze(sorted);
}

export function assertRequestedRun(
  run: BackupRunRecord,
  request: RequestCoordinationBackup,
  participants: readonly CoordinationBackupParticipant[]
): void {
  assertBackupRunRecord(run);
  if (
    run.state !== 'requested' ||
    run.backupRunId !== request.backupRunId ||
    run.deploymentId !== request.deploymentId ||
    run.purpose !== request.purpose
  ) {
    throw new CoordinationBackupServiceError(
      'run_contract_invalid',
      'BackupRun repository returned a record that disagrees with the request',
      run
    );
  }
  assertParticipantContract(run, participants);
}

export function assertParticipantContract(
  run: BackupRunRecord,
  participants: readonly CoordinationBackupParticipant[]
): void {
  const current = participants.map((participant) => participant.descriptor);
  if (!sameDescriptorLists(run.participantDescriptors, current)) {
    throw new CoordinationBackupServiceError(
      'participant_contract_mismatch',
      'Durable BackupRun participant contract does not match the registered participants',
      run
    );
  }
}

export async function requireBackupRun(
  runs: BackupRunRepository,
  backupRunId: BackupRunId
): Promise<BackupRunRecord> {
  const run = await runs.get(backupRunId);
  if (!run) throw new CoordinationBackupServiceError('run_not_found', 'BackupRun was not found');
  assertBackupRunRecord(run);
  return run;
}

export async function transitionBackupRun(
  runs: BackupRunRepository,
  current: BackupRunRecord,
  request: Parameters<BackupRunRepository['transition']>[0]
): Promise<BackupRunRecord> {
  transitionBackupRunState(request.from, request.to);
  if (
    request.backupRunId !== current.backupRunId ||
    request.expectedRevision !== current.revision ||
    request.from !== current.state
  ) {
    throw contractFault('transition_request_mismatch');
  }
  const next = await runs.transition(request);
  assertBackupRunRecord(next);
  if (
    next.backupRunId !== current.backupRunId ||
    next.state !== request.to ||
    next.revision <= current.revision
  ) {
    throw contractFault('transition_result_mismatch');
  }
  assertTransitionEvidenceMatches(request, next);
  return next;
}

export function assertRunState<TState extends BackupRunRecord['state']>(
  run: BackupRunRecord,
  state: TState
): asserts run is BackupRunRecord & { readonly state: TState } {
  if (run.state !== state) throw contractFault('backup_run_state_mismatch');
}

export function assertPreparedParticipant(
  descriptor: BackupParticipantDescriptor,
  prepared: PreparedBackupParticipant
): void {
  if (!sameDescriptor(descriptor, prepared.descriptor) || !prepared.sourceGeneration) {
    throw contractFault('prepared_participant_contract_mismatch');
  }
}

export function assertFlushedParticipant(
  descriptor: BackupParticipantDescriptor,
  prepared: PreparedBackupParticipant,
  flushed: FlushedBackupParticipant
): void {
  if (
    !sameDescriptor(descriptor, flushed.descriptor) ||
    flushed.sourceGeneration !== prepared.sourceGeneration ||
    !flushed.durableBarrier
  ) {
    throw contractFault('flushed_participant_contract_mismatch');
  }
}

export function assertAcceptedCommandDrain(
  run: BackupRunRecord,
  lease: BackupWriterFenceLease,
  drain: BackupAcceptedCommandDrain
): void {
  if (
    drain.admittedRunId !== run.backupRunId ||
    drain.fenceGeneration !== lease.evidence.generation ||
    !drain.throughCommandCursor ||
    !drain.durableBarrier
  ) {
    throw contractFault('accepted_command_drain_invalid');
  }
}

export function assertCoordinationBarrierEvidence(
  run: BackupRunRecord,
  lease: BackupWriterFenceLease,
  drain: BackupAcceptedCommandDrain,
  participants: readonly FlushedBackupParticipant[],
  barrier: BackupCoordinationBarrier
): void {
  const observedPoints = barrier.participantRecoveryPoints
    .map(recoveryPointKey)
    .sort((left, right) => left.localeCompare(right));
  const expectedPoints = participants
    .map((participant) =>
      recoveryPointKey({
        participantId: participant.descriptor.participantId,
        sourceGeneration: participant.sourceGeneration,
        durableBarrier: participant.durableBarrier,
      })
    )
    .sort((left, right) => left.localeCompare(right));
  if (
    barrier.stateCompatibilityManifest.schemaVersion !==
      COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION ||
    barrier.acceptedCommandDrain.admittedRunId !== run.backupRunId ||
    barrier.acceptedCommandDrain.fenceGeneration !== lease.evidence.generation ||
    barrier.acceptedCommandDrain.throughCommandCursor !== drain.throughCommandCursor ||
    barrier.acceptedCommandDrain.durableBarrier !== drain.durableBarrier ||
    new Set(observedPoints).size !== observedPoints.length ||
    !sameStrings(observedPoints, expectedPoints)
  ) {
    throw contractFault('coordination_barrier_invalid');
  }
}

export function recoveryPointKey(point: {
  readonly participantId: string;
  readonly sourceGeneration: string;
  readonly durableBarrier: string;
}): string {
  return JSON.stringify([point.participantId, point.sourceGeneration, point.durableBarrier]);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function requireParticipantEvidence<TEvidence extends PreparedBackupParticipant>(
  evidence: readonly TEvidence[],
  participantId: string
): TEvidence {
  const matches = evidence.filter(
    (candidate) => candidate.descriptor.participantId === participantId
  );
  if (matches.length !== 1) throw contractFault('participant_evidence_missing_or_duplicated');
  return matches[0];
}

export function sameDescriptorLists(
  left: readonly BackupParticipantDescriptor[],
  right: readonly BackupParticipantDescriptor[]
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.participantId.localeCompare(b.participantId));
  const sortedRight = [...right].sort((a, b) => a.participantId.localeCompare(b.participantId));
  return sortedLeft.every((descriptor, index) => sameDescriptor(descriptor, sortedRight[index]));
}

export function sameDescriptor(
  left: BackupParticipantDescriptor,
  right: BackupParticipantDescriptor | undefined
): boolean {
  return (
    !!right &&
    left.participantId === right.participantId &&
    left.kind === right.kind &&
    left.contractVersion === right.contractVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.required === right.required
  );
}

export function sortEntries(entries: readonly BackupManifestEntry[]): BackupManifestEntry[] {
  return [...entries].sort((left, right) => left.entryId.localeCompare(right.entryId));
}

export function sortExclusions(exclusions: readonly BackupExclusion[]): BackupExclusion[] {
  return [...exclusions].sort((left, right) => {
    const participantOrder = left.participantId.localeCompare(right.participantId);
    return participantOrder || left.logicalType.localeCompare(right.logicalType);
  });
}

export function sortFlushedParticipants(
  participants: readonly FlushedBackupParticipant[]
): FlushedBackupParticipant[] {
  return [...participants].sort((left, right) =>
    left.descriptor.participantId.localeCompare(right.descriptor.participantId)
  );
}

export function assertVerificationPlanMatchesRun(run: BackupRunRecord): void {
  const plan = run.verificationPlan;
  if (!plan) throw contractFault('verification_plan_run_mismatch');
  if (
    plan.manifest.backupRunId !== run.backupRunId ||
    plan.manifest.deploymentId !== run.deploymentId ||
    plan.manifest.productKind !== run.productKind ||
    plan.manifest.purpose !== run.purpose ||
    plan.marker.backupRunId !== run.backupRunId ||
    plan.marker.manifestHash !== plan.manifest.manifestHash
  ) {
    throw contractFault('verification_plan_run_mismatch');
  }
}

export function contractFault(code: string): BackupExecutionFault {
  return new BackupExecutionFault(
    code,
    'operator_required',
    'Durable coordination backup contract evidence is inconsistent'
  );
}

export function classifyExecutionFault(error: unknown): BackupExecutionFault {
  if (error instanceof BackupExecutionFault) return error;
  if (error instanceof BackupRunInvariantError) {
    return new BackupExecutionFault(
      error.code,
      'operator_required',
      'BackupRun invariant validation failed',
      { cause: error }
    );
  }
  return new BackupExecutionFault(
    'backup_port_failure',
    'failed',
    'A coordination backup boundary failed',
    { cause: error }
  );
}

export function asServiceError(
  error: unknown,
  run: BackupRunRecord
): CoordinationBackupServiceError {
  if (error instanceof CoordinationBackupServiceError) return error;
  if (error instanceof BackupExecutionFault && error.code === 'immutable_verification_failed') {
    return new CoordinationBackupServiceError(
      'immutable_verification_failed',
      'Committed backup failed immutable verification',
      run,
      { cause: error }
    );
  }
  return new CoordinationBackupServiceError(
    'run_contract_invalid',
    'BackupRun recovery could not establish a safe durable result',
    run,
    { cause: error }
  );
}

export function pendingFenceCompletion(
  run: BackupRunRecord,
  disposition: BackupFenceCompletionDisposition
): PendingBackupFenceCompletion {
  if (!run.fence) throw contractFault('pending_fence_completion_missing_fence');
  return pendingFenceCompletionFor(run.fence.generation, disposition);
}

export function pendingFenceCompletionFor(
  generation: number,
  disposition: BackupFenceCompletionDisposition
): PendingBackupFenceCompletion {
  return Object.freeze({
    generation,
    disposition,
    status: 'pending' as const,
    completedAt: null,
  });
}

export function assertCompletedFenceRecord(
  previous: BackupRunRecord,
  completed: BackupRunRecord
): void {
  assertBackupRunRecord(completed);
  const previousCompletion = previous.fenceCompletion;
  if (
    !previousCompletion ||
    completed.backupRunId !== previous.backupRunId ||
    completed.state !== previous.state ||
    completed.revision <= previous.revision ||
    completed.fenceCompletion?.status !== 'completed' ||
    completed.fenceCompletion.generation !== previousCompletion.generation ||
    completed.fenceCompletion.disposition !== previousCompletion.disposition
  ) {
    throw contractFault('fence_completion_result_mismatch');
  }
}

export function replaceTerminalRecord(error: Error, run: BackupRunRecord): Error {
  if (!(error instanceof CoordinationBackupServiceError) || !error.terminalRecord) return error;
  return new CoordinationBackupServiceError(error.code, error.message, run, { cause: error.cause });
}
