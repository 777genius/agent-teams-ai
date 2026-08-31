import {
  type ActiveBackupRunState,
  BACKUP_RUN_STATES,
  type BackupCoordinationBarrier,
  type BackupFenceCompletionDisposition,
  type BackupIdentityInventory,
  type BackupManifestEntry,
  type BackupParticipantDescriptor,
  type BackupRunRecord,
  type BackupRunState,
  COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION,
  COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION,
  type FlushedBackupParticipant,
  type ImmutableBackupInspection,
  type MeasuredBackupEntry,
} from '../../contracts';

import { BackupRunInvariantError } from './backupRunInvariantError';

export function assertBackupRunState(state: BackupRunState): void {
  if (!(BACKUP_RUN_STATES as readonly unknown[]).includes(state)) {
    throw new BackupRunInvariantError('invalid_state', 'Unknown BackupRun state', { state });
  }
}

export function stateAtOrAfter(state: BackupRunState, threshold: ActiveBackupRunState): boolean {
  const order: readonly BackupRunState[] = [
    'requested',
    'fencing',
    'quiescing',
    'sqlite_snapshot',
    'file_stage',
    'verifying',
    'committed',
  ];
  const stateIndex = order.indexOf(state);
  const thresholdIndex = order.indexOf(threshold);
  return stateIndex >= thresholdIndex;
}

export function requireEvidence(
  value: unknown,
  state: BackupRunState,
  evidenceName: string
): asserts value {
  if (value === null || value === undefined) {
    throw new BackupRunInvariantError(
      'missing_transition_evidence',
      'BackupRun is missing evidence required by its durable state',
      { state, evidenceName }
    );
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new BackupRunInvariantError('invalid_record', 'BackupRun field must not be empty', {
      field,
    });
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new BackupRunInvariantError(
      'invalid_record',
      'BackupRun numeric field must be a positive integer',
      { field, value }
    );
  }
}

export function assertSupportedParticipantDescriptor(
  descriptor: BackupParticipantDescriptor
): void {
  assertNonEmpty(descriptor.participantId, 'participantId');
  assertNonEmpty(descriptor.kind, 'participant kind');
  if (
    descriptor.contractVersion !== COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION ||
    descriptor.schemaVersion !== COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION
  ) {
    throw invalidRecord('BackupRun participant contract or schema version is unsupported');
  }
}

export function validateFenceCompletion(
  record: BackupRunRecord,
  expectedDisposition: BackupFenceCompletionDisposition
): void {
  if (!record.fence) {
    if (record.fenceLeaseId !== null || record.fenceCompletion !== null) {
      throw invalidRecord('BackupRun fence completion exists without a durable fence');
    }
    if (expectedDisposition === 'committed') {
      throw invalidRecord('A committed BackupRun must complete its durable writer fence');
    }
    return;
  }
  requireEvidence(record.fenceLeaseId, record.state, 'fenceLeaseId');
  requireEvidence(record.fenceCompletion, record.state, 'fenceCompletion');
  if (
    record.fenceCompletion.generation !== record.fence.generation ||
    record.fenceCompletion.disposition !== expectedDisposition ||
    (record.fenceCompletion.status === 'pending' && record.fenceCompletion.completedAt !== null) ||
    (record.fenceCompletion.status === 'completed' && !record.fenceCompletion.completedAt)
  ) {
    throw invalidRecord('BackupRun fence completion evidence is inconsistent');
  }
}

export function validateCoordinationBarrier(
  backupRunId: BackupRunRecord['backupRunId'],
  fenceGeneration: number,
  barrier: BackupCoordinationBarrier,
  participants: readonly FlushedBackupParticipant[]
): void {
  const reasons: string[] = [];
  validateCompatibilityManifest(barrier, reasons);
  validateRecoveryPointEvidence(backupRunId, fenceGeneration, barrier, participants, reasons);
  if (reasons.length > 0) {
    throw invalidRecord('BackupRun coordination recovery-point evidence is inconsistent');
  }
}

export function validateCompatibilityManifest(
  barrier: BackupCoordinationBarrier,
  reasons: string[]
): void {
  const compatibility = barrier.stateCompatibilityManifest;
  if (compatibility.schemaVersion !== COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION) {
    reasons.push('unsupported_compatibility_schema_version');
  }
  if (!compatibility.manifestId || !/^[0-9a-f]{64}$/.test(compatibility.sha256)) {
    reasons.push('compatibility_manifest_invalid');
  }
}

export function validateRecoveryPointEvidence(
  backupRunId: BackupRunRecord['backupRunId'],
  fenceGeneration: number,
  barrier: BackupCoordinationBarrier,
  participants: readonly FlushedBackupParticipant[],
  reasons: string[]
): void {
  const drain = barrier.acceptedCommandDrain;
  if (
    drain.admittedRunId !== backupRunId ||
    drain.fenceGeneration !== fenceGeneration ||
    !drain.throughCommandCursor ||
    !drain.durableBarrier
  ) {
    reasons.push('accepted_command_drain_mismatch');
  }
  if (!barrier.eventCursor || !barrier.eventEpoch) {
    reasons.push('coordination_cursor_invalid');
  }
  if (Object.values(barrier.journalCursors).some((cursor) => !cursor)) {
    reasons.push('journal_cursor_invalid');
  }

  const participantPoints = barrier.participantRecoveryPoints
    .map(participantRecoveryPointKey)
    .sort((left, right) => left.localeCompare(right));
  const flushedPoints = participants
    .map((participant) =>
      participantRecoveryPointKey({
        participantId: participant.descriptor.participantId,
        sourceGeneration: participant.sourceGeneration,
        durableBarrier: participant.durableBarrier,
      })
    )
    .sort((left, right) => left.localeCompare(right));
  if (
    new Set(participantPoints).size !== participantPoints.length ||
    !sameStrings(participantPoints, flushedPoints)
  ) {
    reasons.push('participant_recovery_point_mismatch');
  }
}

function participantRecoveryPointKey(point: {
  readonly participantId: string;
  readonly sourceGeneration: string;
  readonly durableBarrier: string;
}): string {
  return JSON.stringify([point.participantId, point.sourceGeneration, point.durableBarrier]);
}

export function invalidRecord(message: string): BackupRunInvariantError {
  return new BackupRunInvariantError('invalid_record', message);
}

export function validatePersistedParticipantEvidence(
  descriptors: readonly BackupRunRecord['participantDescriptors'][number][],
  evidence: readonly NonNullable<BackupRunRecord['preparedParticipants']>[number][],
  requireFlush: boolean
): void {
  if (descriptors.length !== evidence.length) {
    throw invalidRecord('BackupRun participant evidence set is incomplete');
  }
  const evidenceById = new Map(
    evidence.map((item) => [item.descriptor.participantId, item] as const)
  );
  if (evidenceById.size !== evidence.length) {
    throw invalidRecord('BackupRun participant evidence set contains duplicates');
  }
  for (const descriptor of descriptors) {
    const item = evidenceById.get(descriptor.participantId);
    if (!item) {
      throw invalidRecord('BackupRun participant evidence disagrees with its durable contract');
    }
    if (
      item.descriptor.kind !== descriptor.kind ||
      item.descriptor.contractVersion !== descriptor.contractVersion ||
      item.descriptor.schemaVersion !== descriptor.schemaVersion ||
      item.descriptor.required !== descriptor.required ||
      !item.sourceGeneration ||
      (requireFlush &&
        (!('durableBarrier' in item) ||
          typeof item.durableBarrier !== 'string' ||
          !item.durableBarrier))
    ) {
      throw invalidRecord('BackupRun participant evidence disagrees with its durable contract');
    }
  }
}

export function validateManifestEntries(
  manifestEntries: readonly BackupManifestEntry[],
  measuredEntries: readonly MeasuredBackupEntry[],
  reasons: string[]
): void {
  const manifestById = new Map<string, BackupManifestEntry>();
  let sqliteEntries = 0;
  for (const entry of manifestEntries) {
    if (manifestById.has(entry.entryId)) reasons.push('duplicate_manifest_entry');
    manifestById.set(entry.entryId, entry);
    if (entry.kind === 'sqlite_snapshot') sqliteEntries += 1;
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      reasons.push('manifest_entry_length_invalid');
    }
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0)
      reasons.push('manifest_entry_mode_invalid');
  }
  if (sqliteEntries !== 1) reasons.push('sqlite_manifest_entry_count_invalid');

  const measuredById = new Map<string, MeasuredBackupEntry>();
  for (const measured of measuredEntries) {
    if (measuredById.has(measured.entryId)) reasons.push('duplicate_measured_entry');
    measuredById.set(measured.entryId, measured);
  }
  if (manifestById.size !== measuredById.size) reasons.push('entry_set_incomplete');
  for (const [entryId, entry] of manifestById) {
    const measured = measuredById.get(entryId);
    if (!measured) {
      reasons.push('entry_missing');
      continue;
    }
    if (
      entry.byteLength !== measured.byteLength ||
      entry.mode !== measured.mode ||
      entry.sha256 !== measured.sha256
    ) {
      reasons.push('entry_measurement_mismatch');
    }
  }
}

export function findSqliteEntry(
  entries: readonly BackupManifestEntry[]
): BackupManifestEntry | undefined {
  return entries.find((entry) => entry.kind === 'sqlite_snapshot');
}

export function sameManifestEntry(
  left: BackupManifestEntry,
  right: BackupManifestEntry | undefined
): boolean {
  return (
    !!right &&
    left.entryId === right.entryId &&
    left.participantId === right.participantId &&
    left.kind === right.kind &&
    left.logicalOwner === right.logicalOwner &&
    left.logicalType === right.logicalType &&
    left.schemaVersion === right.schemaVersion &&
    left.byteLength === right.byteLength &&
    left.mode === right.mode &&
    left.sha256 === right.sha256 &&
    left.sourceGeneration === right.sourceGeneration
  );
}

export function validateParticipantSet(
  manifest: ImmutableBackupInspection['manifest'],
  reasons: string[]
): void {
  const participantIds = new Set<string>();
  for (const participant of manifest.participants) {
    const { descriptor } = participant;
    if (participantIds.has(descriptor.participantId)) reasons.push('duplicate_participant');
    participantIds.add(descriptor.participantId);
    if (descriptor.contractVersion !== COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION) {
      reasons.push('unsupported_participant_contract_version');
    }
    if (descriptor.schemaVersion !== COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION) {
      reasons.push('unsupported_participant_schema_version');
    }
    if (!descriptor.participantId || !participant.sourceGeneration || !participant.durableBarrier) {
      reasons.push('participant_evidence_incomplete');
    }
  }
  for (const entry of manifest.entries) {
    if (entry.kind !== 'sqlite_snapshot') {
      const participant = manifest.participants.find(
        (candidate) => candidate.descriptor.participantId === entry.participantId
      );
      if (!participant) reasons.push('entry_participant_missing');
      else if (entry.sourceGeneration !== participant.sourceGeneration) {
        reasons.push('entry_participant_generation_mismatch');
      }
    }
  }
}

export function validateIdentityInventory(
  inventory: BackupIdentityInventory,
  entries: readonly BackupManifestEntry[],
  reasons: string[]
): void {
  if (inventory.schemaVersion !== COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION) {
    reasons.push('unsupported_identity_inventory_schema_version');
  }
  const entryById = new Map(entries.map((entry) => [entry.entryId, entry]));
  const identities = new Set<string>();
  const teamIds = new Set<string>();
  let deploymentIdentities = 0;
  for (const identity of inventory.identities) {
    if (identities.has(identity.identityId)) reasons.push('duplicate_identity');
    identities.add(identity.identityId);
    if (identity.kind === 'team') teamIds.add(identity.identityId);
    if (identity.kind === 'deployment') {
      deploymentIdentities += 1;
      if (
        identity.identityId !== inventory.deploymentId ||
        identity.parentIdentityId !== null ||
        identity.state !== 'active'
      ) {
        reasons.push('deployment_identity_disagreement');
      }
    }
    if (identity.fileEntryId === null) {
      if (identity.state !== 'tombstoned') reasons.push('identity_anchor_missing');
    } else {
      const fileEntry = entryById.get(identity.fileEntryId);
      if (!fileEntry) reasons.push('identity_anchor_missing');
      else if (fileEntry.kind !== 'identity_anchor' || fileEntry.sha256 !== identity.checksum) {
        reasons.push('identity_anchor_disagreement');
      }
    }
  }
  if (deploymentIdentities !== 1) reasons.push('deployment_identity_count_invalid');
  for (const identity of inventory.identities) {
    if (identity.kind === 'team' && identity.parentIdentityId !== inventory.deploymentId) {
      reasons.push('team_identity_parent_mismatch');
    }
    if (
      identity.kind === 'member' &&
      (!identity.parentIdentityId || !teamIds.has(identity.parentIdentityId))
    ) {
      reasons.push('member_identity_parent_missing');
    }
  }

  const workspaceIds = new Set<string>();
  const registrationKeys = new Set<string>();
  for (const workspace of inventory.workspaceRegistrations) {
    if (workspaceIds.has(workspace.workspaceId)) reasons.push('duplicate_workspace_id');
    if (registrationKeys.has(workspace.registrationKey)) reasons.push('duplicate_registration_key');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(workspace.registrationKey)) {
      reasons.push('workspace_registration_key_invalid');
    }
    workspaceIds.add(workspace.workspaceId);
    registrationKeys.add(workspace.registrationKey);
  }
}

export function compareIdentityInventories(
  expected: BackupIdentityInventory,
  observed: BackupIdentityInventory,
  reasons: string[]
): void {
  if (
    expected.schemaVersion !== observed.schemaVersion ||
    expected.deploymentId !== observed.deploymentId
  ) {
    reasons.push('observed_identity_inventory_disagreement');
  }
  const expectedIdentities = expected.identities
    .map(identityComparisonKey)
    .sort((left, right) => left.localeCompare(right));
  const observedIdentities = observed.identities
    .map(identityComparisonKey)
    .sort((left, right) => left.localeCompare(right));
  if (!sameStrings(expectedIdentities, observedIdentities)) {
    reasons.push('observed_identity_inventory_disagreement');
  }
  const expectedWorkspaces = expected.workspaceRegistrations
    .map(workspaceComparisonKey)
    .sort((left, right) => left.localeCompare(right));
  const observedWorkspaces = observed.workspaceRegistrations
    .map(workspaceComparisonKey)
    .sort((left, right) => left.localeCompare(right));
  if (!sameStrings(expectedWorkspaces, observedWorkspaces)) {
    reasons.push('observed_workspace_inventory_disagreement');
  }
}

function identityComparisonKey(identity: BackupIdentityInventory['identities'][number]): string {
  return JSON.stringify([
    identity.kind,
    identity.identityId,
    identity.parentIdentityId ?? '',
    identity.state,
    identity.checksum,
    identity.fileEntryId ?? '',
  ]);
}

function workspaceComparisonKey(
  workspace: BackupIdentityInventory['workspaceRegistrations'][number]
): string {
  return JSON.stringify([workspace.workspaceId, workspace.registrationKey, workspace.state]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateCopiedSourceRun(
  inspection: ImmutableBackupInspection,
  reasons: string[]
): void {
  const { copiedSourceRun, manifest } = inspection;
  if (copiedSourceRun.backupRunId !== manifest.sourceBackupRunId) {
    reasons.push('copied_source_run_missing_or_mismatched');
  }
  if (copiedSourceRun.deploymentId !== manifest.deploymentId) {
    reasons.push('copied_source_deployment_mismatch');
  }
  if (copiedSourceRun.productKind !== manifest.productKind) {
    reasons.push('copied_source_product_mismatch');
  }
  if (copiedSourceRun.purpose !== manifest.purpose) {
    reasons.push('copied_source_purpose_mismatch');
  }
  if (copiedSourceRun.state !== 'sqlite_snapshot') {
    reasons.push('copied_source_state_invalid');
  }
  if (copiedSourceRun.fenceGeneration !== manifest.fenceGeneration) {
    reasons.push('copied_source_fence_mismatch');
  }
  const copiedBarrierReasons: string[] = [];
  validateCompatibilityManifest(copiedSourceRun.coordinationBarrier, copiedBarrierReasons);
  validateRecoveryPointEvidence(
    copiedSourceRun.backupRunId,
    copiedSourceRun.fenceGeneration,
    copiedSourceRun.coordinationBarrier,
    copiedSourceRun.participants,
    copiedBarrierReasons
  );
  if (
    copiedBarrierReasons.length > 0 ||
    coordinationBarrierComparisonKey(copiedSourceRun.coordinationBarrier) !==
      coordinationBarrierComparisonKey(manifest.coordinationBarrier)
  ) {
    reasons.push('copied_source_coordination_barrier_mismatch');
  }
  const copiedParticipants = copiedSourceRun.participants
    .map(flushedParticipantComparisonKey)
    .sort((left, right) => left.localeCompare(right));
  const manifestParticipants = manifest.participants
    .map(flushedParticipantComparisonKey)
    .sort((left, right) => left.localeCompare(right));
  if (!sameStrings(copiedParticipants, manifestParticipants)) {
    reasons.push('copied_source_participant_mismatch');
  }
  const copiedIdentityReasons: string[] = [];
  validateIdentityInventory(
    copiedSourceRun.identityInventory,
    manifest.entries,
    copiedIdentityReasons
  );
  compareIdentityInventories(
    manifest.identityInventory,
    copiedSourceRun.identityInventory,
    copiedIdentityReasons
  );
  if (copiedIdentityReasons.length > 0) {
    reasons.push('copied_source_identity_inventory_mismatch');
  }
}

function coordinationBarrierComparisonKey(barrier: BackupCoordinationBarrier): string {
  const compatibility = barrier.stateCompatibilityManifest;
  const drain = barrier.acceptedCommandDrain;
  const participantPoints = barrier.participantRecoveryPoints
    .map(participantRecoveryPointKey)
    .sort((left, right) => left.localeCompare(right));
  const journalCursors = Object.entries(barrier.journalCursors)
    .map(([journal, cursor]) => [journal, cursor] as const)
    .sort(
      ([leftJournal, leftCursor], [rightJournal, rightCursor]) =>
        leftJournal.localeCompare(rightJournal) || leftCursor.localeCompare(rightCursor)
    );
  return JSON.stringify([
    compatibility.manifestId,
    compatibility.schemaVersion,
    compatibility.sha256,
    drain.admittedRunId,
    drain.fenceGeneration,
    drain.throughCommandCursor,
    drain.durableBarrier,
    participantPoints,
    barrier.eventCursor,
    barrier.eventEpoch,
    journalCursors,
  ]);
}

function flushedParticipantComparisonKey(participant: FlushedBackupParticipant): string {
  return JSON.stringify([
    participant.descriptor.participantId,
    participant.descriptor.kind,
    participant.descriptor.contractVersion,
    participant.descriptor.schemaVersion,
    participant.descriptor.required ? 'required' : 'optional',
    participant.sourceGeneration,
    participant.durableBarrier,
  ]);
}
