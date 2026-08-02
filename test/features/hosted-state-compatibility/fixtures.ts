import {
  type ArchiveEntryChecksum,
  type BuiltArtifactStateManifest,
  type BuiltArtifactStateManifestEnvelope,
  HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT,
  HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
  HOSTED_STATE_HEADER_FORMAT,
  HOSTED_STATE_HEADER_SCHEMA_VERSION,
  HOSTED_STATE_MIGRATION_JOURNAL_FORMAT,
  HOSTED_STATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
  HOSTED_STATE_RESTORE_SET_FORMAT,
  HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION,
  type HostedStateHeader,
  type HostedStateMigrationJournal,
  type OfflineArchiveReadModel,
  type RestoreArchiveEvidence,
  type RestoreSetIdentity,
} from '@features/hosted-state-compatibility';

import type {
  BackupManifest,
  BackupVerificationPlan,
  ImmutableBackupVerification,
  Sha256Digest,
  StateCompatibilityManifestRef,
} from '@features/coordination-backup';
import type { CoordinationSnapshotMetadata, ReplayCursor } from '@features/coordination-events';

export const DIGEST_A = 'a'.repeat(64) as Sha256Digest;
export const DIGEST_B = 'b'.repeat(64) as Sha256Digest;
export const DIGEST_C = 'c'.repeat(64) as Sha256Digest;
export const DIGEST_D = 'd'.repeat(64) as Sha256Digest;

export function artifactManifest(
  overrides: Partial<BuiltArtifactStateManifest> = {}
): BuiltArtifactStateManifest {
  return {
    format: HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT,
    schemaVersion: HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
    manifestId: 'hosted-state-n-plus-one',
    artifactVersion: '2.0.0',
    hostedStateSchemaVersion: 2,
    minimumReadableHostedStateVersion: 1,
    orderedMigrations: [
      {
        migrationId: 'hosted-state-1-to-2',
        fromVersion: 1,
        toVersion: 2,
        sha256: DIGEST_A,
        backupRequirement: 'verified_offline_archive',
      },
    ],
    ...overrides,
  };
}

export function artifactEnvelope(
  overrides: Partial<BuiltArtifactStateManifestEnvelope> = {}
): BuiltArtifactStateManifestEnvelope {
  return {
    manifest: artifactManifest(),
    ref: stateManifestRef(),
    ...overrides,
  };
}

export function stateHeader(
  hostedStateSchemaVersion = 1,
  deploymentId = 'deployment-fixture'
): HostedStateHeader {
  return {
    format: HOSTED_STATE_HEADER_FORMAT,
    schemaVersion: HOSTED_STATE_HEADER_SCHEMA_VERSION,
    deploymentId,
    hostedStateSchemaVersion,
  };
}

export function migrationJournal(
  overrides: Partial<HostedStateMigrationJournal> = {}
): HostedStateMigrationJournal {
  return {
    format: HOSTED_STATE_MIGRATION_JOURNAL_FORMAT,
    schemaVersion: HOSTED_STATE_MIGRATION_JOURNAL_SCHEMA_VERSION,
    deploymentId: 'deployment-fixture',
    migrationId: 'hosted-state-1-to-2',
    fromVersion: 1,
    toVersion: 2,
    migrationSha256: DIGEST_A,
    phase: 'applying',
    ...overrides,
  };
}

export function stateManifestRef(): StateCompatibilityManifestRef {
  return { manifestId: 'hosted-state-n', schemaVersion: 3, sha256: DIGEST_C };
}

export function restoreSet(overrides: Partial<RestoreSetIdentity> = {}): RestoreSetIdentity {
  return {
    format: HOSTED_STATE_RESTORE_SET_FORMAT,
    schemaVersion: HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION,
    deploymentId: 'deployment-fixture',
    backupRunId: 'backup_fixture',
    manifestHash: DIGEST_B,
    fenceGeneration: 7,
    stateCompatibilityManifest: stateManifestRef(),
    snapshot: {
      deploymentId: 'deployment-fixture',
      eventEpoch: 'event-epoch-fixture',
      replayCursor: 'cursor-fixture',
    },
    ...overrides,
  };
}

export function checksum(overrides: Partial<ArchiveEntryChecksum> = {}): ArchiveEntryChecksum {
  return {
    entryId: 'state.sqlite',
    byteLength: 4096,
    mode: 0o600,
    sha256: DIGEST_D,
    ...overrides,
  };
}

export function verifiedImmutableBackup(): ImmutableBackupVerification {
  return { status: 'verified', inspection: {} as never };
}

export function restoreEvidence(
  overrides: Partial<RestoreArchiveEvidence> = {}
): RestoreArchiveEvidence {
  const identity = restoreSet();
  return {
    publication: 'committed',
    immutableVerification: verifiedImmutableBackup(),
    expectedRestoreSet: identity,
    observedRestoreSet: identity,
    manifestSnapshot: identity.snapshot,
    expectedChecksums: [checksum()],
    observedChecksums: [checksum()],
    sqliteIntegrity: 'ok',
    ...overrides,
  };
}

export function coordinationSnapshot(
  overrides: Partial<CoordinationSnapshotMetadata> = {}
): CoordinationSnapshotMetadata {
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-fixture',
    eventEpoch: 'event-epoch-fixture',
    handoffMode: 'same_transaction',
    replayCursor: 'cursor-fixture' as ReplayCursor,
    revisionVector: [],
    ...overrides,
  };
}

export function backupManifest(): BackupManifest {
  return {
    backupRunId: 'backup_fixture',
    deploymentId: 'deployment-fixture',
    manifestHash: DIGEST_B,
    fenceGeneration: 7,
    coordinationBarrier: {
      stateCompatibilityManifest: stateManifestRef(),
      eventEpoch: 'event-epoch-fixture',
      eventCursor: 'cursor-fixture',
    },
    entries: [checksum()],
    sqliteIntegrity: { integrityCheck: 'ok' },
  } as unknown as BackupManifest;
}

export function archiveReadModel(manifest = backupManifest()): OfflineArchiveReadModel {
  return {
    verificationPlan: { manifest } as BackupVerificationPlan,
    stateHeader: stateHeader(1),
    migrationJournal: null,
    snapshotMetadata: coordinationSnapshot(),
  };
}
