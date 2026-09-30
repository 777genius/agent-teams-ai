export interface BackupManifestPort {
  teamName: string;
  identityId: string;
  projectPath?: string;
  displayName?: string;
  status: 'active' | 'deleted_by_user';
  deletedByUserAt?: string;
  firstBackupAt: string;
  lastBackupAt: string;
  fileStats: Record<string, { mtime: number; size: number }>;
}

export interface BackupRegistryEntryPort {
  teamName: string;
  identityId: string;
  status: 'active' | 'deleted_by_user';
  deletedByUserAt?: string;
  lastBackupAt: string;
}

export interface TeamPermanentDeletionCoordinatorPorts {
  awaitInitialization(): Promise<void>;
  isInitialized(): boolean;
  isShuttingDown(): boolean;
  withTeamMutex<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  registry(): Record<string, BackupRegistryEntryPort>;
  loadManifest(teamName: string): Promise<BackupManifestPort | null>;
  saveManifest(teamName: string, manifest: BackupManifestPort, strict?: boolean): Promise<void>;
  saveRegistryEntry(
    teamName: string,
    entry: BackupRegistryEntryPort,
    strict?: boolean
  ): Promise<void>;
}
