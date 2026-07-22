import { access, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type InternalStorageBackendSelector,
  InternalStorageJsonReplica,
  KeyedMutex,
  type MemberWorkSyncStorageGateway,
} from '@features/internal-storage/main';
import { atomicWriteAsync, syncDirectoryDurably } from '@main/utils/atomicWrite';

import {
  isMemberWorkSyncStoreSnapshot,
  type JsonMemberWorkSyncStore,
  type MemberWorkSyncStoreSnapshot,
} from './JsonMemberWorkSyncStore';
import { mergeMemberWorkSyncSnapshots } from './memberWorkSyncSnapshotMerge';
import {
  areSnapshotRecordSetsEquivalent,
  normalizeMemberWorkSyncStoreSnapshotTeamIdentity,
  recordsToSnapshot,
  snapshotToRecords,
} from './memberWorkSyncSqliteMappers';

import type {
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxCountDeliveredForAgendaInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportIntentStatus,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';
import type {
  MemberWorkSyncOutboxStorePort,
  MemberWorkSyncReportStorePort,
  MemberWorkSyncStatusStorePort,
} from '../../core/application/ports';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { SqliteMemberWorkSyncStore } from './SqliteMemberWorkSyncStore';

type FullStore = Required<MemberWorkSyncStatusStorePort> &
  Required<MemberWorkSyncReportStorePort> &
  Required<MemberWorkSyncOutboxStorePort>;

function emptySnapshot(): MemberWorkSyncStoreSnapshot {
  return {
    statuses: [],
    reportIntents: [],
    outboxItems: [],
    metricEvents: [],
    filesToArchive: [],
  };
}

export interface BackendSelectingMemberWorkSyncStoreOptions {
  gateway: MemberWorkSyncStorageGateway;
  paths: MemberWorkSyncStorePaths;
  fallbackRequiresReplica: boolean;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

/**
 * Routes member-work-sync persistence through the internal-storage session
 * backend decision: SQLite when the worker pinged successfully, the legacy
 * JSON store otherwise. The decision is made once per session, so delivery
 * state never splits between backends.
 */
export class BackendSelectingMemberWorkSyncStore
  implements
    MemberWorkSyncStatusStorePort,
    MemberWorkSyncReportStorePort,
    MemberWorkSyncOutboxStorePort
{
  private readonly replica: InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot> | null;
  private readonly replicaMutex = new KeyedMutex();
  private readonly sqlitePreparedTeams = new Set<string>();
  private readonly jsonHydratedTeams = new Set<string>();

  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqliteStore: SqliteMemberWorkSyncStore,
    private readonly jsonStore: JsonMemberWorkSyncStore,
    private readonly options?: BackendSelectingMemberWorkSyncStoreOptions
  ) {
    this.replica = options
      ? new InternalStorageJsonReplica(
          (teamName) => options.paths.getSqliteFallbackReplicaPath(teamName),
          isMemberWorkSyncStoreSnapshot
        )
      : null;
  }

  async purgeTeam(teamName: string): Promise<void> {
    if (!this.options) return;
    const backend = await this.selector.select<'sqlite' | 'json'>('sqlite', 'json');
    await this.replicaMutex.run(teamName, async () => {
      if (backend === 'sqlite') {
        const snapshot = emptySnapshot();
        await this.options!.gateway.importTeam(teamName, snapshotToRecords(teamName, snapshot));
        await this.replica?.writeClean(teamName, snapshot);
        await this.removePendingPrimaryPurge(teamName);
      } else {
        await this.writePendingPrimaryPurge(teamName);
      }
      this.sqlitePreparedTeams.delete(teamName);
      this.jsonHydratedTeams.delete(teamName);
    });
  }

  private async run<T>(
    teamName: string,
    mutation: boolean,
    sqliteAction: (store: FullStore) => Promise<T>,
    jsonAction: (store: FullStore) => Promise<T>
  ): Promise<T> {
    const backend = await this.selector.select<'sqlite' | 'json'>('sqlite', 'json');
    if (!this.replica || !this.options) {
      return backend === 'sqlite'
        ? sqliteAction(this.sqliteStore as FullStore)
        : jsonAction(this.jsonStore as FullStore);
    }
    return this.replicaMutex.run(teamName, async () => {
      if (backend === 'json') {
        if (!this.jsonHydratedTeams.has(teamName)) {
          const snapshot = await this.replica!.readClean(
            teamName,
            this.options!.fallbackRequiresReplica
          );
          if (snapshot) {
            await this.jsonStore.restoreReplicaSnapshot(
              teamName,
              normalizeMemberWorkSyncStoreSnapshotTeamIdentity(teamName, snapshot)
            );
          }
          this.jsonHydratedTeams.add(teamName);
        }
        return jsonAction(this.jsonStore as FullStore);
      }

      await this.applyPendingPrimaryPurge(teamName);

      const publishReplica = mutation || !this.sqlitePreparedTeams.has(teamName);
      if (!this.sqlitePreparedTeams.has(teamName)) {
        const replicaSnapshot = await this.replica!.readForPrimary(
          teamName,
          this.selector.getBackendInfo()?.integrity !== 'recovered'
        );
        if (replicaSnapshot) {
          const canonical = await this.options!.gateway.listTeamSnapshot(teamName);
          await this.options!.gateway.importTeam(
            teamName,
            mergeMemberWorkSyncSnapshots(
              teamName,
              canonical,
              snapshotToRecords(teamName, replicaSnapshot)
            )
          );
        }
      }
      if (publishReplica) await this.replica!.markDirty(teamName);
      const result = await sqliteAction(this.sqliteStore as FullStore);
      if (publishReplica) {
        try {
          const snapshot = recordsToSnapshot(
            teamName,
            await this.options!.gateway.listTeamSnapshot(teamName)
          );
          await this.replica!.writeClean(teamName, snapshot);
          this.sqlitePreparedTeams.add(teamName);
        } catch (error) {
          this.options!.logger?.warn('member-work-sync fallback replica publication failed', {
            teamName,
            error: String(error),
          });
        }
      }
      return result;
    });
  }

  private async applyPendingPrimaryPurge(teamName: string): Promise<void> {
    if (!(await this.hasPendingPrimaryPurge(teamName))) return;
    const active = await this.jsonStore.readSnapshotForImport(teamName);
    const snapshot = normalizeMemberWorkSyncStoreSnapshotTeamIdentity(
      teamName,
      active ? { ...active, filesToArchive: [] } : emptySnapshot()
    );
    const expected = snapshotToRecords(teamName, snapshot);
    await this.options!.gateway.importTeam(teamName, expected);
    const roundTrip = await this.options!.gateway.listTeamSnapshot(teamName);
    if (!areSnapshotRecordSetsEquivalent(roundTrip, expected)) {
      throw new Error(
        `member-work-sync pending primary purge verification failed for "${teamName}"`
      );
    }
    await this.replica!.writeClean(teamName, recordsToSnapshot(teamName, roundTrip));
    await this.removePendingPrimaryPurge(teamName);
    this.sqlitePreparedTeams.delete(teamName);
    this.jsonHydratedTeams.delete(teamName);
  }

  private async writePendingPrimaryPurge(teamName: string): Promise<void> {
    const markerPath = this.options!.paths.getPendingPrimaryPurgePath(teamName);
    const markerDirectory = dirname(markerPath);
    const firstCreatedDirectory = await mkdir(markerDirectory, { recursive: true });
    if (firstCreatedDirectory) {
      await syncDirectoryDurably(dirname(firstCreatedDirectory));
    }
    await atomicWriteAsync(
      markerPath,
      `${JSON.stringify({ schemaVersion: 1, teamName: teamName.trim() }, null, 2)}\n`,
      { durability: 'strict', syncDirectory: true }
    );
  }

  private async hasPendingPrimaryPurge(teamName: string): Promise<boolean> {
    try {
      await access(this.options!.paths.getPendingPrimaryPurgePath(teamName));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async removePendingPrimaryPurge(teamName: string): Promise<void> {
    if (!(await this.hasPendingPrimaryPurge(teamName))) return;
    const markerPath = this.options!.paths.getPendingPrimaryPurgePath(teamName);
    await rm(markerPath, { force: true });
    await syncDirectoryDurably(dirname(markerPath));
  }

  async read(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncStatus | null> {
    return this.run(
      input.teamName,
      false,
      (store) => store.read(input),
      (store) => store.read(input)
    );
  }

  async write(status: MemberWorkSyncStatus): Promise<void> {
    await this.run(
      status.teamName,
      true,
      (store) => store.write(status),
      (store) => store.write(status)
    );
  }

  async readTeamMetrics(teamName: string): Promise<MemberWorkSyncTeamMetrics> {
    return this.run(
      teamName,
      false,
      (store) => store.readTeamMetrics(teamName),
      (store) => store.readTeamMetrics(teamName)
    );
  }

  async appendPendingReport(request: MemberWorkSyncReportRequest, reason: string): Promise<void> {
    await this.run(
      request.teamName,
      true,
      (store) => store.appendPendingReport(request, reason),
      (store) => store.appendPendingReport(request, reason)
    );
  }

  async listPendingReports(teamName: string): Promise<MemberWorkSyncReportIntent[]> {
    return this.run(
      teamName,
      false,
      (store) => store.listPendingReports(teamName),
      (store) => store.listPendingReports(teamName)
    );
  }

  async markPendingReportProcessed(
    teamName: string,
    id: string,
    result: { status: MemberWorkSyncReportIntentStatus; resultCode: string; processedAt: string }
  ): Promise<void> {
    await this.run(
      teamName,
      true,
      (store) => store.markPendingReportProcessed(teamName, id, result),
      (store) => store.markPendingReportProcessed(teamName, id, result)
    );
  }

  async ensurePending(
    input: MemberWorkSyncOutboxEnsureInput
  ): Promise<MemberWorkSyncOutboxEnsureResult> {
    return this.run(
      input.teamName,
      true,
      (store) => store.ensurePending(input),
      (store) => store.ensurePending(input)
    );
  }

  async claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]> {
    return this.run(
      input.teamName,
      true,
      (store) => store.claimDue(input),
      (store) => store.claimDue(input)
    );
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    await this.run(
      input.teamName,
      true,
      (store) => store.markDelivered(input),
      (store) => store.markDelivered(input)
    );
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    await this.run(
      input.teamName,
      true,
      (store) => store.markSuperseded(input),
      (store) => store.markSuperseded(input)
    );
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    await this.run(
      input.teamName,
      true,
      (store) => store.markFailed(input),
      (store) => store.markFailed(input)
    );
  }

  async countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<number> {
    return this.run(
      input.teamName,
      false,
      (store) => store.countRecentDelivered(input),
      (store) => store.countRecentDelivered(input)
    );
  }

  async countDeliveredForAgenda(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number> {
    return this.run(
      input.teamName,
      false,
      (store) => store.countDeliveredForAgenda(input),
      (store) => store.countDeliveredForAgenda(input)
    );
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    return this.run(
      input.teamName,
      false,
      (store) => store.findDeliveredReviewPickupRequestEventIds(input),
      (store) => store.findDeliveredReviewPickupRequestEventIds(input)
    );
  }

  async findRecentRecoveryByIntent(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<{
    id: string;
    status: MemberWorkSyncOutboxItem['status'];
    deliveredMessageId?: string;
    payloadHash: string;
    updatedAt: string;
  } | null> {
    return this.run(
      input.teamName,
      false,
      (store) => store.findRecentRecoveryByIntent(input),
      (store) => store.findRecentRecoveryByIntent(input)
    );
  }
}
