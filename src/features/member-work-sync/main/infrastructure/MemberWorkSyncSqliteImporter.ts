import { MEMBER_WORK_SYNC_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import { archiveFileWithGenerations } from '@features/internal-storage/main';

import { normalizeTeamKey } from './JsonMemberWorkSyncStore';
import {
  validateMemberWorkSyncAuthoritySnapshot,
  validateMemberWorkSyncPrimaryRecords,
} from './memberWorkSyncAuthorityPreparation';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { mergeMemberWorkSyncSnapshots } from './memberWorkSyncSnapshotMerge';
import {
  areSnapshotRecordSetsEquivalent,
  recordsToSnapshot,
  snapshotToRecords,
} from './memberWorkSyncSqliteMappers';

import type {
  JsonMemberWorkSyncStore,
  MemberWorkSyncStoreSnapshot,
} from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncTeamSnapshotRecords } from '@features/internal-storage/contracts/internalStorageContracts';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';

export interface MemberWorkSyncSqliteImporterDeps {
  gateway: MemberWorkSyncStorageGateway;
  /** Owns all legacy file-format knowledge (v1, v2 per-member, indexes). */
  jsonStore: Pick<
    JsonMemberWorkSyncStore,
    'readSnapshotForImport' | 'readArchivedSnapshotForImport'
  >;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

/**
 * One-time, idempotent JSON -> SQLite import for a team's member-work-sync
 * state. This is message-delivery state, so the sequence is strict:
 *
 *   1. read the currently surviving legacy snapshot; when the durable import
 *      marker was lost, also rebuild and overlay archived generations
 *   2. overlay it on the canonical SQLite rows and replace the merged team in
 *      one transaction
 *   3. read back and verify the complete content
 *   4. only then archive the legacy files (*.pre-sqlite, never deleted)
 *
 * File presence is the trigger: a crash during archiving can leave only a
 * subset of the JSON files for the retry. JSON rows win by identity, while
 * canonical rows whose identities are absent from that surviving subset stay
 * intact. This also makes a downgrade that recreated files a safe overlay.
 */
const IMPORT_FAILURE_RETRY_COOLDOWN_MS = 60_000;

export class MemberWorkSyncSqliteImporter {
  private readonly importedTeams = new Set<string>();
  private readonly recentFailures = new Map<string, { atMs: number; error: Error }>();

  constructor(private readonly deps: MemberWorkSyncSqliteImporterDeps) {}

  /** Called by the existing store mutex after lifecycle owner confirms a new incarnation. */
  invalidatePreparedTeam(teamName: string): void {
    this.importedTeams.delete(normalizeTeamKey(teamName));
    this.recentFailures.delete(normalizeTeamKey(teamName));
  }

  /** Authority already preflighted and imported this exact snapshot; do not re-read legacy inputs. */
  async finalizePreparedImport(
    teamName: string,
    records: MemberWorkSyncTeamSnapshotRecords,
    filesToArchive: readonly string[],
    incarnation?: string,
    imported = false
  ): Promise<void> {
    if ((await this.deps.gateway.readPrimaryIncarnation(teamName)) !== (incarnation ?? null))
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
    const roundTrip = await this.deps.gateway.listTeamSnapshot(teamName);
    if (!areSnapshotRecordSetsEquivalent(roundTrip, records))
      throw new Error('member-work-sync prepared import verification failed');
    if (imported || !(await this.deps.gateway.hasStoreImport(MEMBER_WORK_SYNC_STORE_ID, teamName)))
      await this.deps.gateway.recordStoreImport(
        MEMBER_WORK_SYNC_STORE_ID,
        teamName,
        records.statuses.length + records.reportIntents.length + records.outboxItems.length
      );
    for (const file of filesToArchive) await archiveFileWithGenerations(file);
    this.recentFailures.delete(normalizeTeamKey(teamName));
    this.importedTeams.add(normalizeTeamKey(teamName));
  }

  /** Must run under the same per-team mutex as the store methods. */
  async ensureImported(teamName: string): Promise<void> {
    if (this.importedTeams.has(normalizeTeamKey(teamName))) {
      return;
    }
    // A failed import stays failed for a cooldown window instead of re-running
    // the full replace transaction on every store call (claimDue polls every
    // few seconds); the JSON files remain the source of truth throughout.
    const failure = this.recentFailures.get(normalizeTeamKey(teamName));
    if (failure && Date.now() - failure.atMs < IMPORT_FAILURE_RETRY_COOLDOWN_MS) {
      throw failure.error;
    }
    try {
      await this.importTeamOnce(teamName);
      this.recentFailures.delete(normalizeTeamKey(teamName));
    } catch (error) {
      this.recentFailures.set(normalizeTeamKey(teamName), {
        atMs: Date.now(),
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  /** Read and validate every raw source before the caller fences or writes SQLite. */
  async prepareImport(
    teamName: string,
    replicaSnapshot?: MemberWorkSyncStoreSnapshot | null,
    incarnation?: string
  ) {
    const activeSnapshot = await this.deps.jsonStore.readSnapshotForImport(teamName);
    const hasRecordedImport = await this.deps.gateway.hasStoreImport(
      MEMBER_WORK_SYNC_STORE_ID,
      teamName
    );
    const archivedSnapshot = hasRecordedImport
      ? null
      : await this.deps.jsonStore.readArchivedSnapshotForImport(teamName);
    const identity = incarnation === undefined ? undefined : { teamName, incarnation };
    if (identity) {
      for (const snapshot of [replicaSnapshot, activeSnapshot, archivedSnapshot])
        if (snapshot) validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
    }
    const usedArchivedSnapshot = archivedSnapshot !== null;
    const snapshot =
      activeSnapshot || archivedSnapshot
        ? combineSnapshots(archivedSnapshot, activeSnapshot)
        : null;
    const incomingRecords = snapshot
      ? snapshotToRecords(teamName, snapshot)
      : { statuses: [], reportIntents: [], outboxItems: [], metricEvents: [] };
    const canonicalRecords = await this.deps.gateway.listTeamSnapshot(teamName);
    if (identity) validateMemberWorkSyncPrimaryRecords(identity, canonicalRecords);
    const withReplica = replicaSnapshot
      ? mergeMemberWorkSyncSnapshots(
          teamName,
          canonicalRecords,
          snapshotToRecords(teamName, replicaSnapshot)
        )
      : canonicalRecords;
    const records = mergeMemberWorkSyncSnapshots(teamName, withReplica, incomingRecords);
    if (identity) {
      validateMemberWorkSyncPrimaryRecords(identity, records);
      validateMemberWorkSyncAuthoritySnapshot(identity, recordsToSnapshot(teamName, records));
    }
    return {
      canonicalRecords,
      records,
      snapshot,
      activeSnapshot,
      usedArchivedSnapshot,
      filesToArchive: activeSnapshot?.filesToArchive ?? [],
    };
  }

  private async importTeamOnce(teamName: string): Promise<void> {
    // A bound primary can only be prepared through its replica/lifecycle fence.
    if ((await this.deps.gateway.readPrimaryIncarnation(teamName)) !== null)
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
    const { canonicalRecords, records, snapshot, activeSnapshot, usedArchivedSnapshot } =
      await this.prepareImport(teamName);
    const repairRequired = !areSnapshotRecordSetsEquivalent(canonicalRecords, records);
    if (!snapshot && !repairRequired) {
      this.importedTeams.add(normalizeTeamKey(teamName));
      return;
    }

    await this.deps.gateway.importTeam(teamName, records);

    const roundTrip = await this.deps.gateway.listTeamSnapshot(teamName);
    if (!areSnapshotRecordSetsEquivalent(roundTrip, records)) {
      throw new Error(
        `member-work-sync import verification failed for team "${teamName}"; ` +
          'keeping the JSON files as the source of truth'
      );
    }

    if (snapshot || repairRequired) {
      await this.deps.gateway.recordStoreImport(
        MEMBER_WORK_SYNC_STORE_ID,
        teamName,
        records.statuses.length + records.reportIntents.length + records.outboxItems.length
      );
    }
    if (activeSnapshot) {
      for (const filePath of snapshot?.filesToArchive ?? []) {
        await archiveFileWithGenerations(filePath);
      }
    }
    this.deps.logger?.warn('member-work-sync sqlite snapshot imported or repaired', {
      teamName,
      statuses: records.statuses.length,
      reportIntents: records.reportIntents.length,
      outboxItems: records.outboxItems.length,
      metricEvents: records.metricEvents.length,
      archivedFiles: activeSnapshot ? (snapshot?.filesToArchive.length ?? 0) : 0,
      recoveredFromArchives: usedArchivedSnapshot,
      repairedCanonicalIdentity: repairRequired,
    });
    this.importedTeams.add(normalizeTeamKey(teamName));
  }
}

function combineSnapshots(
  archived: MemberWorkSyncStoreSnapshot | null,
  active: MemberWorkSyncStoreSnapshot | null
): MemberWorkSyncStoreSnapshot {
  if (!archived && !active) {
    throw new Error('Cannot combine absent member-work-sync snapshots');
  }
  return {
    statuses: [...(archived?.statuses ?? []), ...(active?.statuses ?? [])],
    reportIntents: [...(archived?.reportIntents ?? []), ...(active?.reportIntents ?? [])],
    outboxItems: [...(archived?.outboxItems ?? []), ...(active?.outboxItems ?? [])],
    metricEvents: [...(archived?.metricEvents ?? []), ...(active?.metricEvents ?? [])],
    filesToArchive: active?.filesToArchive ?? [],
  };
}
