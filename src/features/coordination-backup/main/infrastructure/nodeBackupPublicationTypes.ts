import type {
  BackupManifestEntry,
  BackupRunId,
  MeasuredBackupEntry,
  Sha256Digest,
} from '../../contracts';

export interface NodeBackupPublicationOptions {
  readonly backupRoot: string;
}

export interface BackupArtifactWriteRequest {
  readonly backupRunId: BackupRunId;
  readonly entryId: string;
  readonly participantId: string;
  readonly kind: BackupManifestEntry['kind'];
  readonly logicalOwner: string;
  readonly logicalType: string;
  readonly schemaVersion: number;
  readonly sourceGeneration: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface BackupArtifactMeasureRequest {
  readonly backupRunId: BackupRunId;
  readonly entryId: string;
}

/** A capability writer for one declared artifact; it never exposes its filesystem location. */
export interface BackupPublicationArtifactWriter {
  writeArtifact(request: BackupArtifactWriteRequest): Promise<BackupManifestEntry>;
  measureStagedArtifact(request: BackupArtifactMeasureRequest): Promise<MeasuredBackupEntry>;
}

export interface SqliteBackupArtifactChunk {
  readonly offset: number;
  readonly totalByteLength: number;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}

/**
 * A run/entry-bound publication sink. The SQLite worker supplies immutable
 * chunks from its private Online Backup scratch file; no reusable filesystem
 * path capability crosses the main/worker boundary.
 */
export interface SqliteBackupArtifactPublisher {
  publishSqliteSnapshot(request: {
    readonly backupRunId: BackupRunId;
    readonly entryId: string;
    readonly byteLength: number;
    readonly sha256: Sha256Digest;
    readonly readChunk: (offset: number) => Promise<SqliteBackupArtifactChunk>;
  }): Promise<MeasuredBackupEntry>;
}

export class BackupPublicationError extends Error {
  constructor(readonly code: string) {
    super(`coordination-backup-publication-${code}`);
    this.name = 'BackupPublicationError';
  }
}
