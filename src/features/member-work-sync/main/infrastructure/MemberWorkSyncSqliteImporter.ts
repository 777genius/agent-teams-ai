import { MEMBER_WORK_SYNC_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import { archiveFileWithGenerations } from '@features/internal-storage/main';

import { areSnapshotRecordSetsEquivalent, snapshotToRecords } from './memberWorkSyncSqliteMappers';

import type { JsonMemberWorkSyncStore } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';

export interface MemberWorkSyncSqliteImporterDeps {
  gateway: MemberWorkSyncStorageGateway;
  /** Owns all legacy file-format knowledge (v1, v2 per-member, indexes). */
  jsonStore: Pick<JsonMemberWorkSyncStore, 'readSnapshotForImport'>;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

/**
 * One-time, idempotent JSON -> SQLite import for a team's member-work-sync
 * state. This is message-delivery state, so the sequence is strict:
 *
 *   1. read the full legacy snapshot (absent -> done)
 *   2. replace every team row in one transaction
 *   3. read back and verify the complete content
 *   4. only then archive the legacy files (*.pre-sqlite, never deleted)
 *
 * File presence is the trigger: a crash before archiving or a downgrade that
 * recreated the files leads to a safe re-import where the JSON wins.
 */
export class MemberWorkSyncSqliteImporter {
  private readonly importedTeams = new Set<string>();

  constructor(private readonly deps: MemberWorkSyncSqliteImporterDeps) {}

  /** Must run under the same per-team mutex as the store methods. */
  async ensureImported(teamName: string): Promise<void> {
    if (this.importedTeams.has(teamName)) {
      return;
    }

    const snapshot = await this.deps.jsonStore.readSnapshotForImport(teamName);
    if (snapshot === null) {
      this.importedTeams.add(teamName);
      return;
    }

    const records = snapshotToRecords(snapshot);
    await this.deps.gateway.importTeam(teamName, records);

    const roundTrip = await this.deps.gateway.listTeamSnapshot(teamName);
    if (!areSnapshotRecordSetsEquivalent(roundTrip, records)) {
      throw new Error(
        `member-work-sync import verification failed for team "${teamName}"; ` +
          'keeping the JSON files as the source of truth'
      );
    }

    await this.deps.gateway.recordStoreImport(
      MEMBER_WORK_SYNC_STORE_ID,
      teamName,
      records.statuses.length + records.reportIntents.length + records.outboxItems.length
    );
    for (const filePath of snapshot.filesToArchive) {
      await archiveFileWithGenerations(filePath);
    }
    this.deps.logger?.warn('member-work-sync legacy JSON imported into sqlite', {
      teamName,
      statuses: records.statuses.length,
      reportIntents: records.reportIntents.length,
      outboxItems: records.outboxItems.length,
      metricEvents: records.metricEvents.length,
      archivedFiles: snapshot.filesToArchive.length,
    });
    this.importedTeams.add(teamName);
  }
}
