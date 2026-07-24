import { parseTeamId } from '@shared/contracts/hosted/identifiers';

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
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION,
  COORDINATION_BACKUP_FORMAT,
  COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION,
  COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION,
  type CopiedSourceBackupRun,
  type FlushedBackupParticipant,
  type ImmutableBackupInspection,
  type MeasuredBackupEntry,
  type RestoreSetValidationRequest,
  type RestoreSetValidationResult,
  SQLITE_ONLINE_BACKUP_METHOD,
} from '../../contracts';

export type BackupRunInvariantErrorCode =
  | 'invalid_state'
  | 'invalid_transition'
  | 'missing_transition_evidence'
  | 'invalid_record'
  | 'invalid_artifact_source';

export class BackupRunInvariantError extends Error {
  constructor(
    readonly code: BackupRunInvariantErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'BackupRunInvariantError';
  }
}

const LIVE_FORWARD_TRANSITIONS = new Map<BackupRunState, BackupRunState>([
  ['requested', 'fencing'],
  ['fencing', 'quiescing'],
  ['quiescing', 'sqlite_snapshot'],
  ['sqlite_snapshot', 'file_stage'],
  ['file_stage', 'verifying'],
  ['verifying', 'committed'],
]);

const ACTIVE_STATES = new Set<BackupRunState>([
  'requested',
  'fencing',
  'quiescing',
  'sqlite_snapshot',
  'file_stage',
  'verifying',
]);

const TERMINAL_STATES = new Set<BackupRunState>([
  'committed',
  'failed',
  'operator_required',
  'artifact_source',
]);

export function transitionBackupRunState(
  current: BackupRunState,
  next: BackupRunState
): BackupRunState {
  assertBackupRunState(current);
  assertBackupRunState(next);

  const isForward = LIVE_FORWARD_TRANSITIONS.get(current) === next;
  const isFailure =
    ACTIVE_STATES.has(current) && (next === 'failed' || next === 'operator_required');
  if (!isForward && !isFailure) {
    throw new BackupRunInvariantError(
      'invalid_transition',
      'BackupRun state transition is not allowed',
      { current, next }
    );
  }
  return next;
}

export function isActiveBackupRunState(state: BackupRunState): state is ActiveBackupRunState {
  assertBackupRunState(state);
  return ACTIVE_STATES.has(state);
}

export function isTerminalBackupRunState(state: BackupRunState): boolean {
  assertBackupRunState(state);
  return TERMINAL_STATES.has(state);
}

export function assertBackupRunRecord(record: BackupRunRecord): void {
  assertBackupRunState(record.state);
  assertNonEmpty(record.backupRunId, 'backupRunId');
  assertNonEmpty(record.deploymentId, 'deploymentId');
  assertPositiveInteger(record.revision, 'revision');

  const descriptorIds = new Set<string>();
  for (const descriptor of record.participantDescriptors) {
    assertSupportedParticipantDescriptor(descriptor);
    if (descriptorIds.has(descriptor.participantId)) {
      throw new BackupRunInvariantError(
        'invalid_record',
        'BackupRun participant descriptors must be unique',
        { participantId: descriptor.participantId }
      );
    }
    descriptorIds.add(descriptor.participantId);
  }

  if ((record.fence === null) !== (record.fenceLeaseId === null)) {
    throw invalidRecord('BackupRun writer fence lease identity is incomplete');
  }
  if (
    record.fence &&
    (record.fence.admittedRunId !== record.backupRunId ||
      !Number.isSafeInteger(record.fence.generation) ||
      record.fence.generation < 1)
  ) {
    throw invalidRecord('BackupRun writer fence evidence is invalid');
  }
  if (isActiveBackupRunState(record.state) && record.fenceCompletion !== null) {
    throw invalidRecord('An active BackupRun cannot claim writer fence completion');
  }

  if (stateAtOrAfter(record.state, 'quiescing')) {
    requireEvidence(record.fence, record.state, 'fence');
    requireEvidence(record.fenceLeaseId, record.state, 'fenceLeaseId');
  }
  if (stateAtOrAfter(record.state, 'sqlite_snapshot')) {
    requireEvidence(record.preparedParticipants, record.state, 'preparedParticipants');
    requireEvidence(record.flushedParticipants, record.state, 'flushedParticipants');
    requireEvidence(record.coordinationBarrier, record.state, 'coordinationBarrier');
    requireEvidence(record.identityInventory, record.state, 'identityInventory');
    validatePersistedParticipantEvidence(
      record.participantDescriptors,
      record.flushedParticipants,
      true
    );
    validateCoordinationBarrier(
      record.backupRunId,
      record.fence?.generation ?? 0,
      record.coordinationBarrier,
      record.flushedParticipants
    );
    if (
      record.identityInventory?.schemaVersion !==
        COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION ||
      record.identityInventory.deploymentId !== record.deploymentId
    ) {
      throw invalidRecord('BackupRun identity inventory deployment does not match the run');
    }
  }
  if (stateAtOrAfter(record.state, 'file_stage')) {
    requireEvidence(record.sqliteSnapshot, record.state, 'sqliteSnapshot');
    if (record.sqliteSnapshot?.method !== SQLITE_ONLINE_BACKUP_METHOD) {
      throw new BackupRunInvariantError(
        'invalid_record',
        'BackupRun snapshot was not created by the SQLite Online Backup API',
        { method: record.sqliteSnapshot?.method }
      );
    }
    if (
      record.sqliteSnapshot.sourceRunId !== record.backupRunId ||
      record.sqliteSnapshot.entry.kind !== 'sqlite_snapshot'
    ) {
      throw invalidRecord('BackupRun SQLite snapshot evidence does not match the run');
    }
  }
  if (stateAtOrAfter(record.state, 'verifying')) {
    requireEvidence(record.stagedEntries, record.state, 'stagedEntries');
    requireEvidence(record.exclusions, record.state, 'exclusions');
  }
  if (record.state === 'committed') {
    requireEvidence(record.verificationPlan, record.state, 'verificationPlan');
    requireEvidence(record.publication, record.state, 'publication');
    if (
      record.verificationPlan?.manifest.backupRunId !== record.backupRunId ||
      record.verificationPlan.manifest.sourceBackupRunId !== record.backupRunId ||
      record.verificationPlan.manifest.deploymentId !== record.deploymentId ||
      record.verificationPlan.manifest.productKind !== record.productKind ||
      record.verificationPlan.manifest.purpose !== record.purpose ||
      record.verificationPlan.manifest.fenceGeneration !== record.fence?.generation ||
      record.verificationPlan.manifest.format !== COORDINATION_BACKUP_FORMAT ||
      record.verificationPlan.marker.format !== COORDINATION_BACKUP_COMMIT_MARKER_FORMAT ||
      record.verificationPlan.marker.backupRunId !== record.backupRunId ||
      record.verificationPlan.marker.deploymentId !== record.deploymentId ||
      record.verificationPlan.marker.sealedAt !== record.verificationPlan.manifest.sealedAt ||
      record.verificationPlan.marker.manifestHash !==
        record.verificationPlan.manifest.manifestHash ||
      record.publication?.backupRunId !== record.backupRunId ||
      record.publication.manifestHash !== record.verificationPlan.manifest.manifestHash
    ) {
      throw invalidRecord('Committed BackupRun publication evidence is inconsistent');
    }
    validateFenceCompletion(record, 'committed');
  }
  if (record.state === 'failed' || record.state === 'operator_required') {
    requireEvidence(record.failure, record.state, 'failure');
    validateFenceCompletion(record, record.state === 'failed' ? 'aborted' : 'operator_required');
  }
  if (record.state === 'artifact_source' && record.fenceCompletion !== null) {
    throw invalidRecord('A copied artifact source cannot complete the source deployment fence');
  }
}

export function finalizeCopiedSourceRun(
  source: CopiedSourceBackupRun,
  expectedRunId: CopiedSourceBackupRun['backupRunId']
): CopiedSourceBackupRun & { readonly state: 'artifact_source' } {
  if (source.backupRunId !== expectedRunId || source.state !== 'sqlite_snapshot') {
    throw new BackupRunInvariantError(
      'invalid_artifact_source',
      'Only the matching sqlite_snapshot BackupRun copied by its own artifact may be finalized',
      {
        actualRunId: source.backupRunId,
        expectedRunId,
        sourceState: source.state,
      }
    );
  }
  return Object.freeze({ ...source, state: 'artifact_source' as const });
}

export type ImmutableInspectionValidation =
  | { readonly status: 'valid' }
  | { readonly status: 'invalid'; readonly reasons: readonly string[] };

export function validateImmutableBackupInspection(
  inspection: ImmutableBackupInspection
): ImmutableInspectionValidation {
  const reasons: string[] = [];
  const { manifest, marker } = inspection;

  if (manifest.format !== COORDINATION_BACKUP_FORMAT) reasons.push('unsupported_manifest_format');
  if (marker.format !== COORDINATION_BACKUP_COMMIT_MARKER_FORMAT) {
    reasons.push('unsupported_commit_marker_format');
  }
  if (manifest.manifestHash !== inspection.computedManifestHash) {
    reasons.push('manifest_hash_mismatch');
  }
  if (marker.manifestHash !== manifest.manifestHash) reasons.push('marker_hash_mismatch');
  if (marker.backupRunId !== manifest.backupRunId) reasons.push('marker_run_mismatch');
  if (marker.deploymentId !== manifest.deploymentId) reasons.push('marker_deployment_mismatch');
  if (marker.sealedAt !== manifest.sealedAt) reasons.push('marker_sealed_at_mismatch');
  if (manifest.sourceBackupRunId !== manifest.backupRunId) {
    reasons.push('source_run_manifest_mismatch');
  }
  if (manifest.productKind !== 'coordination_backup') reasons.push('unsupported_product_kind');
  if (manifest.sqliteSnapshot.method !== SQLITE_ONLINE_BACKUP_METHOD) {
    reasons.push('sqlite_snapshot_method_invalid');
  }
  if (manifest.sqliteSnapshot.sourceRunId !== manifest.sourceBackupRunId) {
    reasons.push('sqlite_source_run_mismatch');
  }
  if (!sameManifestEntry(manifest.sqliteSnapshot.entry, findSqliteEntry(manifest.entries))) {
    reasons.push('sqlite_manifest_entry_mismatch');
  }
  if (manifest.sqliteIntegrity.integrityCheck !== 'ok') reasons.push('sqlite_integrity_not_ok');
  if (manifest.sqliteIntegrity.applicationId !== manifest.sqliteSnapshot.applicationId) {
    reasons.push('sqlite_application_id_mismatch');
  }
  if (manifest.sqliteIntegrity.userVersion !== manifest.sqliteSnapshot.userVersion) {
    reasons.push('sqlite_user_version_mismatch');
  }
  if (manifest.identityInventory.deploymentId !== manifest.deploymentId) {
    reasons.push('identity_deployment_mismatch');
  }
  validateCompatibilityManifest(manifest.coordinationBarrier, reasons);
  validateRecoveryPointEvidence(
    manifest.backupRunId,
    manifest.fenceGeneration,
    manifest.coordinationBarrier,
    manifest.participants,
    reasons
  );

  validateManifestEntries(manifest.entries, inspection.measuredEntries, reasons);
  validateParticipantSet(manifest, reasons);
  validateIdentityInventory(manifest.identityInventory, manifest.entries, reasons);
  compareIdentityInventories(
    manifest.identityInventory,
    inspection.observedIdentityInventory,
    reasons
  );
  validateCopiedSourceRun(inspection, reasons);

  return reasons.length === 0
    ? { status: 'valid' }
    : { status: 'invalid', reasons: Object.freeze(reasons) };
}

export function validateCoordinationBackupRestoreSet(
  request: RestoreSetValidationRequest
): RestoreSetValidationResult {
  const reasons: string[] = [];
  if (request.classification !== 'committed_v2') {
    reasons.push(
      request.classification === 'legacy_unverified'
        ? 'legacy_unverified_not_restorable'
        : 'partial_backup_not_restorable'
    );
  }
  if (request.purpose === 'replace_deployment') {
    reasons.push('coordination_backup_cannot_replace_deployment');
  }
  if (!request.inspection) {
    reasons.push('immutable_inspection_missing');
    return { status: 'invalid', reasons: Object.freeze(reasons) };
  }

  const validation = validateImmutableBackupInspection(request.inspection);
  if (validation.status === 'invalid') reasons.push(...validation.reasons);
  const { manifest, copiedSourceRun } = request.inspection;
  if (manifest.purpose !== request.purpose) {
    reasons.push('restore_purpose_mismatch');
  }
  if (manifest.deploymentId !== request.expectedDeploymentId) {
    reasons.push('restore_deployment_mismatch');
  }

  const activeTeamIds: ReturnType<typeof parseTeamId>[] = [];
  const tombstonedIdentityIds: string[] = [];
  for (const identity of manifest.identityInventory.identities) {
    if (identity.state === 'tombstoned') tombstonedIdentityIds.push(identity.identityId);
    if (identity.kind === 'team' && identity.state === 'active') {
      try {
        activeTeamIds.push(parseTeamId(identity.identityId));
      } catch {
        reasons.push('team_identity_id_invalid');
      }
    }
  }

  if (reasons.length > 0) {
    return { status: 'invalid', reasons: Object.freeze([...new Set(reasons)]) };
  }

  const finalized = finalizeCopiedSourceRun(copiedSourceRun, manifest.sourceBackupRunId);
  const workspaceRegistrations = Object.freeze(
    Object.fromEntries(
      manifest.identityInventory.workspaceRegistrations
        .filter((workspace) => workspace.state === 'registered')
        .map((workspace) => [workspace.registrationKey, workspace.workspaceId])
    )
  );

  return {
    status: 'valid',
    mapping: Object.freeze({
      deploymentId: manifest.deploymentId,
      activeTeamIds: Object.freeze(activeTeamIds),
      tombstonedIdentityIds: Object.freeze(tombstonedIdentityIds),
      workspaceRegistrations,
      sourceRunFinalization: Object.freeze({
        backupRunId: finalized.backupRunId,
        from: 'sqlite_snapshot' as const,
        to: finalized.state,
      }),
    }),
  };
}

function assertBackupRunState(state: BackupRunState): void {
  if (!(BACKUP_RUN_STATES as readonly unknown[]).includes(state)) {
    throw new BackupRunInvariantError('invalid_state', 'Unknown BackupRun state', { state });
  }
}

function stateAtOrAfter(state: BackupRunState, threshold: ActiveBackupRunState): boolean {
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

function requireEvidence(
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

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new BackupRunInvariantError('invalid_record', 'BackupRun field must not be empty', {
      field,
    });
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new BackupRunInvariantError(
      'invalid_record',
      'BackupRun numeric field must be a positive integer',
      { field, value }
    );
  }
}

function assertSupportedParticipantDescriptor(descriptor: BackupParticipantDescriptor): void {
  assertNonEmpty(descriptor.participantId, 'participantId');
  assertNonEmpty(descriptor.kind, 'participant kind');
  if (
    descriptor.contractVersion !== COORDINATION_BACKUP_PARTICIPANT_CONTRACT_VERSION ||
    descriptor.schemaVersion !== COORDINATION_BACKUP_PARTICIPANT_SCHEMA_VERSION
  ) {
    throw invalidRecord('BackupRun participant contract or schema version is unsupported');
  }
}

function validateFenceCompletion(
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

function validateCoordinationBarrier(
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

function validateCompatibilityManifest(
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

function validateRecoveryPointEvidence(
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

function invalidRecord(message: string): BackupRunInvariantError {
  return new BackupRunInvariantError('invalid_record', message);
}

function validatePersistedParticipantEvidence(
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

function validateManifestEntries(
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

function findSqliteEntry(entries: readonly BackupManifestEntry[]): BackupManifestEntry | undefined {
  return entries.find((entry) => entry.kind === 'sqlite_snapshot');
}

function sameManifestEntry(
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

function validateParticipantSet(
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

function validateIdentityInventory(
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

function compareIdentityInventories(
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

function validateCopiedSourceRun(inspection: ImmutableBackupInspection, reasons: string[]): void {
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
