import type {
  BuiltArtifactStateManifestEnvelope,
  HostedStateHeader,
  HostedStateMigrationJournal,
  HostedStateMigrationPhase,
  OfflineArchiveReadModel,
  OfflineRestoreAdmission,
} from '../../contracts';
import type {
  ImmutableBackupVerification,
  StateCompatibilityManifestRef,
} from '@features/coordination-backup/contracts';

export interface BuiltArtifactStateManifestReaderPort {
  readBuiltArtifactManifest(): Promise<BuiltArtifactStateManifestEnvelope>;
}

export interface BuiltArtifactStateManifestIntegrityProbePort {
  verify(
    input: BuiltArtifactStateManifestEnvelope
  ): Promise<
    { readonly status: 'verified' } | { readonly status: 'invalid'; readonly reason: string }
  >;
}

export interface HostedStateHeaderReaderPort {
  readStateHeader(): Promise<HostedStateHeader>;
}

export interface HostedStateMigrationJournalReaderPort {
  readMigrationJournal(): Promise<HostedStateMigrationJournal | null>;
}

/** Compare-and-set journal writes are owned by the migration adapter. */
export interface HostedStateMigrationJournalWriterPort {
  prepare(journal: HostedStateMigrationJournal): Promise<void>;
  advance(input: {
    readonly migrationId: string;
    readonly expectedPhase: HostedStateMigrationPhase;
    readonly nextPhase: HostedStateMigrationPhase;
  }): Promise<void>;
  clearVerified(input: {
    readonly migrationId: string;
    readonly expectedStateVersion: number;
  }): Promise<void>;
}

/** Commits only the hosted schema header; adapters own their transactional storage mechanism. */
export interface HostedStateVersionWriterPort {
  commitMigratedVersion(input: {
    readonly deploymentId: string;
    readonly expectedVersion: number;
    readonly nextVersion: number;
    readonly migrationId: string;
  }): Promise<void>;
}

export interface OfflineArchiveReaderPort {
  readArchive(archiveRef: string): Promise<OfflineArchiveReadModel | null>;
}

export interface OfflineArchiveIntegrityProbePort {
  verify(input: OfflineArchiveReadModel): Promise<ImmutableBackupVerification>;
}

export interface OfflineControllerStateProbePort {
  inspectControllerState(): Promise<'stopped' | 'running' | 'unknown'>;
}

export interface OfflineRestoreTargetProbePort {
  inspectTarget(): Promise<'empty' | 'non_empty' | 'unavailable'>;
}

/** The application admits a restore set before any writer receives it. */
export interface OfflineRestoreWriterPort {
  restore(input: {
    readonly archiveRef: string;
    readonly admission: Extract<OfflineRestoreAdmission, { status: 'admitted' }>;
  }): Promise<void>;
}

export interface StateCompatibilityManifestRefWriterPort {
  publishCurrent(ref: StateCompatibilityManifestRef): Promise<void>;
}
