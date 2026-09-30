import { COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION } from '@features/coordination-backup/contracts';

import {
  type ArchiveEntryChecksum,
  HOSTED_STATE_RESTORE_SET_FORMAT,
  HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION,
  type OfflineRestoreAdmission,
  type OfflineRestoreAdmissionInput,
  type OfflineRestoreRefusalReason,
  type RestoreArchiveEvidence,
  type RestoreArchiveInspection,
  type RestoreArchiveRefusalReason,
  type RestoreSetIdentity,
} from '../../contracts';

import { isIdentifier, isSha256Digest } from './manifestPolicy';

export function inspectRestoreArchive(evidence: RestoreArchiveEvidence): RestoreArchiveInspection {
  const reasons: RestoreArchiveRefusalReason[] = [];
  if (evidence.publication !== 'committed') reasons.push('archive_incomplete');
  if (evidence.immutableVerification.status !== 'verified') {
    reasons.push('archive_integrity_failed');
  }
  const expectedIdentityValid = isValidRestoreSetIdentity(evidence.expectedRestoreSet);
  const observedIdentityValid = isValidRestoreSetIdentity(evidence.observedRestoreSet);
  if (
    !expectedIdentityValid ||
    !observedIdentityValid ||
    !sameRestoreSetBase(evidence.expectedRestoreSet, evidence.observedRestoreSet)
  ) {
    reasons.push('restore_set_identity_mismatch');
  }
  if (
    !isValidSnapshotIdentity(evidence.expectedRestoreSet.snapshot) ||
    !isValidSnapshotIdentity(evidence.observedRestoreSet.snapshot) ||
    !isValidSnapshotIdentity(evidence.manifestSnapshot) ||
    !sameSnapshotIdentity(
      evidence.expectedRestoreSet.snapshot,
      evidence.observedRestoreSet.snapshot
    ) ||
    !sameSnapshotIdentity(evidence.manifestSnapshot, evidence.observedRestoreSet.snapshot) ||
    evidence.observedRestoreSet.snapshot.deploymentId !== evidence.observedRestoreSet.deploymentId
  ) {
    reasons.push('snapshot_topology_mismatch');
  }
  reasons.push(...inspectChecksums(evidence.expectedChecksums, evidence.observedChecksums));
  if (evidence.sqliteIntegrity !== 'ok') reasons.push('sqlite_integrity_failed');

  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  if (uniqueReasons.length > 0) return { status: 'invalid', reasons: uniqueReasons };
  return { status: 'verified', restoreSet: evidence.observedRestoreSet };
}

export function evaluateOfflineRestoreAdmission(
  input: OfflineRestoreAdmissionInput
): OfflineRestoreAdmission {
  const reasons: OfflineRestoreRefusalReason[] = [];
  if (input.mode !== 'replace_deployment') reasons.push('restore_mode_unsupported');
  if (input.controllerState !== 'stopped') reasons.push('controller_not_stopped');
  if (!input.sourceOfflineAttested) reasons.push('source_offline_not_attested');
  if (input.targetState === 'non_empty') reasons.push('target_not_empty');
  else if (input.targetState === 'unavailable') reasons.push('target_unavailable');

  const archiveInspection = inspectRestoreArchive(input.archive);
  if (archiveInspection.status === 'invalid') reasons.push(...archiveInspection.reasons);

  if (input.stateAdmission.status === 'refused') {
    reasons.push(input.stateAdmission.reason);
  } else if (input.stateAdmission.status === 'migration_recovery_required') {
    reasons.push('source_migration_interrupted');
  }

  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  if (uniqueReasons.length > 0 || archiveInspection.status === 'invalid') {
    return { status: 'refused', reasons: uniqueReasons };
  }
  return {
    status: 'admitted',
    restoreSet: archiveInspection.restoreSet,
    postRestore: Object.freeze({
      preserveLogicalIdentities: true,
      rotateBootId: true,
      rotateEventEpoch: true,
      revokeBrowserAuthority: true,
      revokeRuntimeAuthority: true,
      establishFreshMountBindings: true,
    }),
  };
}

function inspectChecksums(
  expected: readonly ArchiveEntryChecksum[],
  observed: readonly ArchiveEntryChecksum[]
): RestoreArchiveRefusalReason[] {
  const expectedById = indexChecksums(expected);
  const observedById = indexChecksums(observed);
  if (
    !expectedById ||
    !observedById ||
    expectedById.size !== observedById.size ||
    [...expectedById.keys()].some((entryId) => !observedById.has(entryId))
  ) {
    return ['archive_entry_set_mismatch'];
  }
  for (const [entryId, expectedEntry] of expectedById) {
    const observedEntry = observedById.get(entryId);
    if (
      !observedEntry ||
      observedEntry.byteLength !== expectedEntry.byteLength ||
      observedEntry.mode !== expectedEntry.mode ||
      observedEntry.sha256 !== expectedEntry.sha256
    ) {
      return ['archive_checksum_mismatch'];
    }
  }
  return [];
}

function indexChecksums(
  entries: readonly ArchiveEntryChecksum[]
): ReadonlyMap<string, ArchiveEntryChecksum> | null {
  if (!Array.isArray(entries)) return null;
  const result = new Map<string, ArchiveEntryChecksum>();
  for (const entry of entries) {
    if (!isValidChecksum(entry) || result.has(entry.entryId)) return null;
    result.set(entry.entryId, entry);
  }
  return result;
}

function isValidChecksum(entry: ArchiveEntryChecksum): boolean {
  return (
    typeof entry?.entryId === 'string' &&
    entry.entryId.length > 0 &&
    Number.isSafeInteger(entry.byteLength) &&
    entry.byteLength >= 0 &&
    Number.isSafeInteger(entry.mode) &&
    entry.mode >= 0 &&
    isSha256Digest(entry.sha256)
  );
}

function isValidRestoreSetIdentity(identity: RestoreSetIdentity): boolean {
  return (
    identity?.format === HOSTED_STATE_RESTORE_SET_FORMAT &&
    identity.schemaVersion === HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION &&
    isIdentifier(identity.deploymentId) &&
    isIdentifier(identity.backupRunId) &&
    isSha256Digest(identity.manifestHash) &&
    Number.isSafeInteger(identity.fenceGeneration) &&
    identity.fenceGeneration > 0 &&
    isIdentifier(identity.stateCompatibilityManifest?.manifestId) &&
    identity.stateCompatibilityManifest.schemaVersion ===
      COORDINATION_BACKUP_COMPATIBILITY_SCHEMA_VERSION &&
    isSha256Digest(identity.stateCompatibilityManifest.sha256) &&
    isValidSnapshotIdentity(identity.snapshot)
  );
}

function isValidSnapshotIdentity(identity: RestoreSetIdentity['snapshot']): boolean {
  return (
    isIdentifier(identity?.deploymentId) &&
    isNonEmptyBoundedString(identity.eventEpoch) &&
    isNonEmptyBoundedString(identity.replayCursor, 4096)
  );
}

function isNonEmptyBoundedString(value: unknown, maximumLength = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value
  );
}

function sameRestoreSetBase(left: RestoreSetIdentity, right: RestoreSetIdentity): boolean {
  return (
    left.format === right.format &&
    left.schemaVersion === right.schemaVersion &&
    left.deploymentId === right.deploymentId &&
    left.backupRunId === right.backupRunId &&
    left.manifestHash === right.manifestHash &&
    left.fenceGeneration === right.fenceGeneration &&
    left.stateCompatibilityManifest.manifestId === right.stateCompatibilityManifest.manifestId &&
    left.stateCompatibilityManifest.schemaVersion ===
      right.stateCompatibilityManifest.schemaVersion &&
    left.stateCompatibilityManifest.sha256 === right.stateCompatibilityManifest.sha256
  );
}

function sameSnapshotIdentity(
  left: RestoreSetIdentity['snapshot'],
  right: RestoreSetIdentity['snapshot']
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.eventEpoch === right.eventEpoch &&
    left.replayCursor === right.replayCursor
  );
}
