/** An injected source restriction; existing lifecycle/Team authority remains required. */
export interface AdmittedLegacySourceWrite {
  readonly kind: 'admitted';
  readonly sourceKey: string;
  assertOwnerCurrent(): void;
  assertCurrent(): void;
  run<T>(operation: () => T): T;
  /** Local filesystem/SQLite publication only, with every physical tail awaited. */
  publish<T>(operation: () => Promise<T>): Promise<T>;
}
export type LegacySourceWriteAdmission =
  | { readonly kind: 'read-only'; readonly sourceKey: string; assertOwnerCurrent(): void }
  | AdmittedLegacySourceWrite;
export interface LegacySourceExecutionScope {
  assertCurrent(): void;
  run<T>(operation: () => T): T;
}
export interface LegacySourceWriteAdmissionPolicy {
  capture(teamName: string): LegacySourceWriteAdmission;
  current(teamName: string): AdmittedLegacySourceWrite;
  bindExecution(teamName: string): LegacySourceExecutionScope;
}

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
  sourceWriteAdmissionPolicy?(): LegacySourceWriteAdmissionPolicy | undefined;
  invalidateTeamConfig?(teamName: string): void;
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
