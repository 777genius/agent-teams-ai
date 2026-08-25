import { parseTeamId } from '@shared/contracts/hosted/identifiers';

import {
  type ActiveBackupRunState,
  type BackupRunRecord,
  type BackupRunState,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  COORDINATION_BACKUP_IDENTITY_INVENTORY_SCHEMA_VERSION,
  type CopiedSourceBackupRun,
  type ImmutableBackupInspection,
  type RestoreSetValidationRequest,
  type RestoreSetValidationResult,
  SQLITE_ONLINE_BACKUP_METHOD,
} from '../../contracts';

import { BackupRunInvariantError } from './backupRunInvariantError';
import {
  assertBackupRunState,
  assertNonEmpty,
  assertPositiveInteger,
  assertSupportedParticipantDescriptor,
  compareIdentityInventories,
  findSqliteEntry,
  invalidRecord,
  requireEvidence,
  sameManifestEntry,
  stateAtOrAfter,
  validateCompatibilityManifest,
  validateCoordinationBarrier,
  validateCopiedSourceRun,
  validateFenceCompletion,
  validateIdentityInventory,
  validateManifestEntries,
  validateParticipantSet,
  validatePersistedParticipantEvidence,
  validateRecoveryPointEvidence,
} from './backupRunValidation';

export {
  BackupRunInvariantError,
  type BackupRunInvariantErrorCode,
} from './backupRunInvariantError';

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
