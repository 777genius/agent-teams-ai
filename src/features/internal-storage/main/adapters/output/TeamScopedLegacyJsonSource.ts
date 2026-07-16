import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/utils/logger';

import type { LegacyJsonStoreSource } from '../../../core/application/ports';

export const PRE_SQLITE_ARCHIVE_SUFFIX = '.pre-sqlite';
const MAX_ARCHIVE_ATTEMPTS = 100;
const logger = createLogger('Feature:InternalStorage');

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

  async readArchives(teamName: string): Promise<TRecord[] | null> {
    const archives = await listPreSqliteArchiveGenerations(this.options.getFilePath(teamName));
    if (archives.length === 0) {
      return null;
    }

    const records: TRecord[] = [];
    for (const archive of archives) {
      try {
        const raw = await fs.promises.readFile(archive.filePath, 'utf8');
        records.push(...this.options.parse(raw, teamName));
      } catch (error) {
        logger.warn(
          `internal-storage skipped unreadable legacy archive team=${teamName} generation=${archive.generation} path=${archive.filePath}`,
          error
        );
      }
    }
    // Archives existed even when none were readable. Preserve that distinction
    // from "no archives" so the importer can record a completed empty recovery.
    return records;
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

export interface PreSqliteArchiveGeneration {
  filePath: string;
  generation: number;
}

/** Lists exact archive siblings in numeric generation order. */
export async function listPreSqliteArchiveGenerations(
  filePath: string
): Promise<PreSqliteArchiveGeneration[]> {
  const directory = path.dirname(filePath);
  const archiveName = `${path.basename(filePath)}${PRE_SQLITE_ARCHIVE_SUFFIX}`;
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const generations: PreSqliteArchiveGeneration[] = [];
  for (const name of names) {
    if (name === archiveName) {
      generations.push({ filePath: path.join(directory, name), generation: 1 });
      continue;
    }
    const prefix = `${archiveName}-`;
    if (!name.startsWith(prefix)) {
      continue;
    }
    const generationText = name.slice(prefix.length);
    if (!/^\d+$/.test(generationText)) {
      continue;
    }
    const generation = Number(generationText);
    if (Number.isSafeInteger(generation) && generation >= 2) {
      generations.push({ filePath: path.join(directory, name), generation });
    }
  }
  return generations.sort((left, right) => left.generation - right.generation);
}

async function pickFreeArchivePath(filePath: string): Promise<string> {
  const base = `${filePath}${PRE_SQLITE_ARCHIVE_SUFFIX}`;
  const existing = await listPreSqliteArchiveGenerations(filePath);
  const firstGeneration = (existing.at(-1)?.generation ?? 0) + 1;
  for (let generation = firstGeneration; generation <= MAX_ARCHIVE_ATTEMPTS; generation += 1) {
    const candidate = generation === 1 ? base : `${base}-${generation}`;
    try {
      await fs.promises.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`No free archive slot for ${base} after ${MAX_ARCHIVE_ATTEMPTS} attempts`);
}
