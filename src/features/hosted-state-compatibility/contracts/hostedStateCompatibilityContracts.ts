import type {
  BackupVerificationPlan,
  ImmutableBackupVerification,
  Sha256Digest,
  StateCompatibilityManifestRef,
} from '@features/coordination-backup/contracts';
import type { CoordinationSnapshotMetadata } from '@features/coordination-events/contracts';

export const HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT =
  'hosted-state-compatibility-manifest/v1' as const;
export const HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const HOSTED_STATE_HEADER_FORMAT = 'hosted-state-header/v1' as const;
export const HOSTED_STATE_HEADER_SCHEMA_VERSION = 1 as const;
export const HOSTED_STATE_MIGRATION_JOURNAL_FORMAT = 'hosted-state-migration-journal/v1' as const;
export const HOSTED_STATE_MIGRATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const HOSTED_STATE_RESTORE_SET_FORMAT = 'hosted-state-restore-set/v1' as const;
export const HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION = 1 as const;

export const HOSTED_STATE_MIGRATION_PHASES = Object.freeze([
  'prepared',
  'applying',
  'verifying',
] as const);

export type HostedStateMigrationPhase = (typeof HOSTED_STATE_MIGRATION_PHASES)[number];
export type HostedStateMigrationBackupRequirement = 'none' | 'verified_offline_archive';

export interface HostedStateMigrationDescriptor {
  readonly migrationId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly sha256: Sha256Digest;
  readonly backupRequirement: HostedStateMigrationBackupRequirement;
}

/** Immutable compatibility contract shipped with one built application artifact. */
export interface BuiltArtifactStateManifest {
  readonly format: typeof HOSTED_STATE_COMPATIBILITY_MANIFEST_FORMAT;
  readonly schemaVersion: typeof HOSTED_STATE_COMPATIBILITY_MANIFEST_SCHEMA_VERSION;
  readonly manifestId: string;
  readonly artifactVersion: string;
  readonly hostedStateSchemaVersion: number;
  readonly minimumReadableHostedStateVersion: number;
  readonly orderedMigrations: readonly HostedStateMigrationDescriptor[];
}

export interface BuiltArtifactStateManifestEnvelope {
  readonly manifest: BuiltArtifactStateManifest;
  /** Hash evidence is produced by an artifact integrity adapter, never by the pure core. */
  readonly ref: StateCompatibilityManifestRef;
}

/** Small header read without mutating the hosted state store. */
export interface HostedStateHeader {
  readonly format: typeof HOSTED_STATE_HEADER_FORMAT;
  readonly schemaVersion: typeof HOSTED_STATE_HEADER_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly hostedStateSchemaVersion: number;
}

/** Durable, idempotent forward-migration recovery record. */
export interface HostedStateMigrationJournal {
  readonly format: typeof HOSTED_STATE_MIGRATION_JOURNAL_FORMAT;
  readonly schemaVersion: typeof HOSTED_STATE_MIGRATION_JOURNAL_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly migrationId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrationSha256: Sha256Digest;
  readonly phase: HostedStateMigrationPhase;
}

export type HostedStateCompatibilityRefusalReason =
  | 'artifact_manifest_invalid'
  | 'artifact_manifest_integrity_failed'
  | 'state_header_invalid'
  | 'future_state_version'
  | 'state_version_too_old'
  | 'migration_path_unavailable'
  | 'migration_journal_invalid'
  | 'migration_journal_mismatch';

export type HostedStateAdmission =
  | {
      readonly status: 'read_write';
      readonly hostedStateSchemaVersion: number;
    }
  | {
      readonly status: 'migration_required';
      readonly fromVersion: number;
      readonly toVersion: number;
      readonly orderedMigrations: readonly HostedStateMigrationDescriptor[];
      readonly backupRequired: boolean;
    }
  | {
      readonly status: 'migration_recovery_required';
      readonly recovery: 'resume_idempotently' | 'verify_before_commit';
      readonly migration: HostedStateMigrationDescriptor;
      readonly journalPhase: HostedStateMigrationPhase;
    }
  | {
      readonly status: 'refused';
      readonly reason: HostedStateCompatibilityRefusalReason;
    };

export interface ArchiveEntryChecksum {
  readonly entryId: string;
  readonly byteLength: number;
  readonly mode: number;
  readonly sha256: Sha256Digest;
}

export interface RestoreSetIdentity {
  readonly format: typeof HOSTED_STATE_RESTORE_SET_FORMAT;
  readonly schemaVersion: typeof HOSTED_STATE_RESTORE_SET_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly backupRunId: string;
  readonly manifestHash: Sha256Digest;
  readonly fenceGeneration: number;
  readonly stateCompatibilityManifest: StateCompatibilityManifestRef;
  readonly snapshot: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly replayCursor: string;
  };
}

export type RestoreArchiveRefusalReason =
  | 'archive_incomplete'
  | 'archive_integrity_failed'
  | 'archive_checksum_mismatch'
  | 'archive_entry_set_mismatch'
  | 'sqlite_integrity_failed'
  | 'restore_set_identity_mismatch'
  | 'snapshot_topology_mismatch';

export interface RestoreArchiveEvidence {
  readonly publication: 'committed' | 'partial';
  readonly immutableVerification: ImmutableBackupVerification;
  readonly expectedRestoreSet: RestoreSetIdentity;
  readonly observedRestoreSet: RestoreSetIdentity;
  /** Snapshot identity recorded by the checksum-bound backup manifest. */
  readonly manifestSnapshot: RestoreSetIdentity['snapshot'];
  readonly expectedChecksums: readonly ArchiveEntryChecksum[];
  readonly observedChecksums: readonly ArchiveEntryChecksum[];
  readonly sqliteIntegrity: 'ok' | 'failed';
}

export type RestoreArchiveInspection =
  | { readonly status: 'verified'; readonly restoreSet: RestoreSetIdentity }
  | {
      readonly status: 'invalid';
      readonly reasons: readonly RestoreArchiveRefusalReason[];
    };

export type OfflineRestoreRefusalReason =
  | RestoreArchiveRefusalReason
  | HostedStateCompatibilityRefusalReason
  | 'controller_not_stopped'
  | 'source_offline_not_attested'
  | 'restore_mode_unsupported'
  | 'target_not_empty'
  | 'target_unavailable'
  | 'source_migration_interrupted';

export interface OfflineRestoreAdmissionInput {
  readonly mode: 'replace_deployment' | 'fork_deployment';
  readonly controllerState: 'stopped' | 'running' | 'unknown';
  readonly sourceOfflineAttested: boolean;
  readonly targetState: 'empty' | 'non_empty' | 'unavailable';
  readonly archive: RestoreArchiveEvidence;
  readonly stateAdmission: HostedStateAdmission;
}

export type OfflineRestoreAdmission =
  | {
      readonly status: 'admitted';
      readonly restoreSet: RestoreSetIdentity;
      readonly postRestore: {
        readonly preserveLogicalIdentities: true;
        readonly rotateBootId: true;
        readonly rotateEventEpoch: true;
        readonly revokeBrowserAuthority: true;
        readonly revokeRuntimeAuthority: true;
        readonly establishFreshMountBindings: true;
      };
    }
  | {
      readonly status: 'refused';
      readonly reasons: readonly OfflineRestoreRefusalReason[];
    };

/** Archive metadata read through the existing public backup and snapshot contracts. */
export interface OfflineArchiveReadModel {
  readonly verificationPlan: BackupVerificationPlan;
  readonly stateHeader: HostedStateHeader;
  readonly migrationJournal: HostedStateMigrationJournal | null;
  readonly snapshotMetadata: CoordinationSnapshotMetadata;
}

export interface OfflineRestoreRequest {
  readonly archiveRef: string;
  readonly mode: 'replace_deployment' | 'fork_deployment';
  readonly sourceOfflineAttested: boolean;
  readonly expectedRestoreSet: RestoreSetIdentity;
}
