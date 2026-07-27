import type * as fs from 'node:fs';

export interface BackupFileStat {
  readonly mtime: number;
  readonly size: number;
  readonly dev?: number;
  readonly ino?: number;
  readonly birthtimeMs?: number;
}

export function getBackupFileStat(stats: fs.Stats): BackupFileStat {
  return {
    mtime: stats.mtimeMs,
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

export function isSameBackupFileGeneration(
  cached: BackupFileStat | undefined,
  stats: fs.Stats
): boolean {
  return (
    cached?.mtime === stats.mtimeMs &&
    cached.size === stats.size &&
    stats.ino !== 0 &&
    cached.dev === stats.dev &&
    cached.ino === stats.ino &&
    cached.birthtimeMs === stats.birthtimeMs
  );
}
