import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync, atomicWriteSync } from '@main/utils/atomicWrite';

/**
 * The per-team backup manifest: the record that says which identity owns the
 * backup directory, whether the team was deleted by the user, and what the
 * source files looked like the last time they were copied.
 */
export interface BackupManifest {
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

export interface BackupManifestWriteOptions {
  /** Flush the manifest and its directory before returning. */
  strict?: boolean;
  /** Last publication fence, evaluated inside the atomic write. */
  beforeCommit?: () => Promise<void>;
}

export function getBackupManifestPath(backupDir: string): string {
  return path.join(backupDir, 'manifest.json');
}

export async function readBackupManifest(backupDir: string): Promise<BackupManifest | null> {
  try {
    const raw = await fs.promises.readFile(getBackupManifestPath(backupDir), 'utf8');
    return JSON.parse(raw) as BackupManifest;
  } catch {
    return null;
  }
}

export function readBackupManifestSync(backupDir: string): BackupManifest | null {
  try {
    const raw = fs.readFileSync(getBackupManifestPath(backupDir), 'utf8');
    return JSON.parse(raw) as BackupManifest;
  } catch {
    return null;
  }
}

export async function writeBackupManifest(
  backupDir: string,
  manifest: BackupManifest,
  { strict = false, beforeCommit }: BackupManifestWriteOptions = {}
): Promise<void> {
  await atomicWriteAsync(getBackupManifestPath(backupDir), JSON.stringify(manifest, null, 2), {
    ...(strict ? { durability: 'strict' as const, syncDirectory: true } : {}),
    ...(beforeCommit ? { beforeCommit } : {}),
  });
}

export function writeBackupManifestSync(backupDir: string, manifest: BackupManifest): void {
  try {
    const manifestPath = getBackupManifestPath(backupDir);
    atomicWriteSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch {
    // best-effort
  }
}
