export type StoppedStackRecoveryStage =
  | 'archive_verified'
  | 'journal_published'
  | 'rotation_marker_published'
  | 'payload_copy_completed'
  | 'payload_restored'
  | 'database_transaction_committed'
  | 'database_rotated'
  | 'secret_generation_published'
  | 'secrets_published'
  | 'restore_completed'
  | 'authority_rotated';

export type StoppedStackArchiveCommitStage =
  | 'payload_directories_synced'
  | 'manifest_durable'
  | 'ready_durable'
  | 'staging_directory_synced'
  | 'archive_published'
  | 'archive_parent_synced';

export interface StoppedStackRecoveryOptions {
  readonly sourceRoot?: string;
  readonly archiveRoot: string;
  readonly targetRoot?: string;
  readonly restoreGeneration?: number;
  readonly random?: (bytes: number) => string;
  readonly openDatabase?: (path: string) => unknown;
  readonly onRestoreStage?: (stage: StoppedStackRecoveryStage) => void | Promise<void>;
  readonly onSqliteSourceDescriptorVerified?: (path: string) => void | Promise<void>;
  readonly onDirectoryDescriptorVerified?: (path: string) => void | Promise<void>;
  readonly onTargetRootDescriptorVerified?: () => void | Promise<void>;
  readonly onArchiveCommitStage?: (stage: StoppedStackArchiveCommitStage) => void | Promise<void>;
}

export function createStoppedStackArchive(
  options: StoppedStackRecoveryOptions
): Promise<Readonly<{ status: 'committed'; manifestHash: string; entries: number }>>;

export function verifyStoppedStackArchive(
  options: StoppedStackRecoveryOptions
): Promise<Readonly<{ status: 'verified'; manifestHash: string; entries: number }>>;

export function restoreStoppedStackArchive(options: StoppedStackRecoveryOptions): Promise<
  Readonly<{
    status: 'restored';
    manifestHash: string;
    rotation: Readonly<{
      format: 'hosted-restored-authority-rotation/v1';
      schemaVersion: 1;
      deploymentId: string;
      restoreGeneration: number;
      bootId: string;
      eventEpoch: string;
      browserAuthorityRotated: true;
      runtimeAuthorityRotationRequired: true;
      freshMountBindingsRequired: true;
    }>;
  }>
>;
