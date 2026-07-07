import * as fs from 'node:fs';

import type { LegacyJsonStoreSource } from '../../../core/application/ports';

export const PRE_SQLITE_ARCHIVE_SUFFIX = '.pre-sqlite';
const MAX_ARCHIVE_ATTEMPTS = 100;

export interface TeamScopedLegacyJsonSourceOptions<TRecord> {
  getFilePath(teamName: string): string;
  /**
   * Turns the raw file contents into wire records. Corrupt-file policy is the
   * store's own: the stall journal treats it as empty, the comment journal
   * rethrows (an emptied comment journal would re-notify the lead about every
   * historical comment).
   */
  parse(raw: string, teamName: string): TRecord[];
}

/**
 * Shared read/archive behavior for per-team legacy JSON stores. Archives are
 * never overwritten or deleted: repeated migrations (e.g. after a downgrade
 * recreated the JSON file) get numbered suffixes so every generation stays
 * recoverable.
 */
export class TeamScopedLegacyJsonSource<TRecord> implements LegacyJsonStoreSource<TRecord> {
  constructor(private readonly options: TeamScopedLegacyJsonSourceOptions<TRecord>) {}

  async read(teamName: string): Promise<TRecord[] | null> {
    const filePath = this.options.getFilePath(teamName);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    return this.options.parse(raw, teamName);
  }

  async archive(teamName: string): Promise<void> {
    await archiveFileWithGenerations(this.options.getFilePath(teamName));
  }
}

/**
 * Renames a legacy file to its *.pre-sqlite archive (never deletes). Repeated
 * migrations get numbered suffixes so every generation stays recoverable.
 * A missing file is a no-op.
 */
export async function archiveFileWithGenerations(filePath: string): Promise<void> {
  const archivePath = await pickFreeArchivePath(filePath);
  try {
    await fs.promises.rename(filePath, archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function pickFreeArchivePath(filePath: string): Promise<string> {
  const base = `${filePath}${PRE_SQLITE_ARCHIVE_SUFFIX}`;
  for (let attempt = 0; attempt < MAX_ARCHIVE_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`No free archive slot for ${base} after ${MAX_ARCHIVE_ATTEMPTS} attempts`);
}
