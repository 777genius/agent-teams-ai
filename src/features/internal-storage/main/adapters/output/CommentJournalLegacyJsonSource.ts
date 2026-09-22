import { getCommentNotificationJournalPath } from '@main/services/team/JsonTaskCommentNotificationJournalStore';
import { sanitizeTaskCommentNotificationJournalEntries } from '@main/services/team/TaskCommentNotificationJournalStore';

import { commentJournalEntryToRecord } from './commentJournalEntryRecordMapper';
import { TeamScopedLegacyJsonSource } from './TeamScopedLegacyJsonSource';

import type { CommentJournalEntryRecord } from '../../../contracts/internalStorageContracts';

/**
 * Legacy per-team comment-notification journal JSON. A corrupt file
 * intentionally rethrows on JSON.parse (matching the legacy reader): importing
 * an emptied journal would re-notify the lead about every historical comment.
 */
export class CommentJournalLegacyJsonSource extends TeamScopedLegacyJsonSource<CommentJournalEntryRecord> {
  constructor() {
    super({
      getFilePath: getCommentNotificationJournalPath,
      parse: (raw, teamName) =>
        sanitizeTaskCommentNotificationJournalEntries(JSON.parse(raw)).map((entry) =>
          commentJournalEntryToRecord(teamName, entry)
        ),
    });
  }
}
