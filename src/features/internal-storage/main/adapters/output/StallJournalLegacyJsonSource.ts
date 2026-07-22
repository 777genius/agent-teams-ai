import { getStallMonitorJournalPath } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { sanitizeTaskStallJournalEntries } from '@main/services/team/stallMonitor/TaskStallJournalStore';

import { stallJournalEntryToRecord } from './stallJournalEntryRecordMapper';
import { TeamScopedLegacyJsonSource } from './TeamScopedLegacyJsonSource';

import type { StallJournalEntryRecord } from '../../../contracts/internalStorageContracts';

export { PRE_SQLITE_ARCHIVE_SUFFIX } from './TeamScopedLegacyJsonSource';

/**
 * Legacy per-team stall journal JSON. A corrupt file is treated as empty
 * (matching the legacy reader) but still gets archived so nothing is lost
 * silently.
 */
export class StallJournalLegacyJsonSource extends TeamScopedLegacyJsonSource<StallJournalEntryRecord> {
  constructor() {
    super({
      getFilePath: getStallMonitorJournalPath,
      parse: (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = [];
        }
        return sanitizeTaskStallJournalEntries(parsed).map(stallJournalEntryToRecord);
      },
    });
  }
}
