import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync, atomicWriteSync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('TeamBackupService');

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
  workSyncRestorePending?: { identityId: string; generation: string };
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
  } catch (error) {
    logger.warn(
      `[Backup] Failed to save manifest for ${manifest.teamName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error;
  }
}

/** Safety callers must distinguish a missing manifest from unreadable ownership. */
export async function readBackupManifestStrict(
  manifestPath: string,
  expectedTeamName: string
): Promise<BackupManifest | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return decodeBackupManifest(raw, expectedTeamName);
}

export function readBackupManifestStrictSync(
  manifestPath: string,
  expectedTeamName: string
): BackupManifest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return decodeBackupManifest(raw, expectedTeamName);
}

function decodeBackupManifest(raw: string, expectedTeamName: string): BackupManifest {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid backup manifest');
  }
  const record = value as Record<string, unknown>;
  if (
    record.teamName !== expectedTeamName ||
    typeof record.identityId !== 'string' ||
    !record.identityId.trim() ||
    (record.status !== 'active' && record.status !== 'deleted_by_user') ||
    typeof record.firstBackupAt !== 'string' ||
    typeof record.lastBackupAt !== 'string' ||
    !record.fileStats ||
    typeof record.fileStats !== 'object' ||
    Array.isArray(record.fileStats)
  ) {
    throw new Error('Invalid backup manifest ownership or shape');
  }
  for (const field of ['projectPath', 'displayName', 'deletedByUserAt']) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      throw new Error('Invalid backup manifest optional metadata');
    }
  }
  if (Object.hasOwn(record, 'workSyncRestorePending')) {
    const pending = record.workSyncRestorePending;
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
      throw new Error('Invalid backup restore pending');
    }
    const fields = pending as Record<string, unknown>;
    if (
      fields.identityId !== record.identityId ||
      typeof fields.generation !== 'string' ||
      !fields.generation.trim()
    ) {
      throw new Error('Invalid backup restore pending identity or generation');
    }
  }
  for (const stat of Object.values(record.fileStats) as unknown[]) {
    if (
      !stat ||
      typeof stat !== 'object' ||
      Array.isArray(stat) ||
      !Number.isFinite((stat as Record<string, unknown>).mtime) ||
      typeof (stat as Record<string, unknown>).size !== 'number' ||
      !Number.isFinite((stat as Record<string, unknown>).size) ||
      ((stat as Record<string, unknown>).size as number) < 0
    ) {
      throw new Error('Invalid backup manifest file statistics');
    }
  }
  return value as BackupManifest;
}

export async function writeBackupManifestStrictAware(
  manifestPath: string,
  manifest: BackupManifest,
  options: { strict: boolean; isShuttingDown(): boolean; beforeCommit?: () => Promise<void> }
): Promise<void> {
  const { strict, isShuttingDown, beforeCommit } = options;
  const validatePublication = async (): Promise<void> => {
    await beforeCommit?.();
    if (strict && isShuttingDown()) {
      throw new Error('Strict backup manifest publication interrupted by shutdown');
    }
  };
  if (isShuttingDown() && !strict) return;
  await validatePublication();
  await atomicWriteAsync(manifestPath, JSON.stringify(manifest, null, 2), {
    ...(strict ? { durability: 'strict' as const, syncDirectory: true } : {}),
    beforeCommit: validatePublication,
  });
}
