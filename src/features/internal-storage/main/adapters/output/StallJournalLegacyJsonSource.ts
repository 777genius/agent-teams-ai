import * as fs from 'node:fs';

import { getStallMonitorJournalPath } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { sanitizeTaskStallJournalEntries } from '@main/services/team/stallMonitor/TaskStallJournalStore';

import { stallJournalEntryToRecord } from './stallJournalEntryRecordMapper';

import type { StallJournalEntryRecord } from '../../../contracts/internalStorageContracts';
import type { LegacyJsonStoreSource } from '../../../core/application/ports';

export const PRE_SQLITE_ARCHIVE_SUFFIX = '.pre-sqlite';
const MAX_ARCHIVE_ATTEMPTS = 100;

/**
 * Reads the legacy per-team stall journal JSON and archives it after a
 * verified import. Archives are never overwritten or deleted: repeated
 * migrations (e.g. after a downgrade recreated the JSON file) get numbered
 * suffixes so every generation stays recoverable.
 */
export class StallJournalLegacyJsonSource implements LegacyJsonStoreSource<StallJournalEntryRecord> {
  async read(teamName: string): Promise<StallJournalEntryRecord[] | null> {
    const filePath = getStallMonitorJournalPath(teamName);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Same policy as the legacy reader: a corrupt journal file is treated
      // as empty, but it still gets archived so nothing is lost silently.
      parsed = [];
    }

    return sanitizeTaskStallJournalEntries(parsed).map(stallJournalEntryToRecord);
  }

  async archive(teamName: string): Promise<void> {
    const filePath = getStallMonitorJournalPath(teamName);
    const archivePath = await this.pickFreeArchivePath(filePath);
    try {
      await fs.promises.rename(filePath, archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  private async pickFreeArchivePath(filePath: string): Promise<string> {
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
}
