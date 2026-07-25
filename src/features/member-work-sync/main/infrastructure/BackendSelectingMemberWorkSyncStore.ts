import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MEMBER_WORK_SYNC_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import {
  type InternalStorageBackendSelector,
  InternalStorageJsonReplica,
  KeyedMutex,
  type MemberWorkSyncStorageGateway,
} from '@features/internal-storage/main';
import {
  atomicWriteAsync,
  type DurablePathIdentity,
  getDurablePathIdentity,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';

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

interface PendingPrimaryPurgeMarker {
  schemaVersion: 2;
  teamName: string;
  deletionIdentityId: string | null;
  teamRootIdentity: DurablePathIdentity | null;
  activeJsonStateCleared: boolean;
  recoverySafe: boolean;
}

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

  async purgeTeam(teamName: string, deletionIdentityId?: string): Promise<void> {
    if (!this.options) return;
    const backend = await this.selector.select<'sqlite' | 'json'>('sqlite', 'json');
    await this.replicaMutex.run(teamName, async () => {
      const marker = await this.getOrCreatePendingPrimaryPurge(
        teamName,
        deletionIdentityId?.trim() || null
      );
      if (backend === 'sqlite') {
        await this.writePendingPrimaryPurge(marker, false);
        await this.applyPendingPrimaryPurge(teamName);
      } else {
        await this.jsonStore.purgeActiveState(teamName, {
          establishPendingPrimaryPurge: () => this.writePendingPrimaryPurge(marker, false),
          isPurgeGenerationCurrent: () => this.isPendingPrimaryPurgeGenerationCurrent(marker),
          confirmActiveStateCleared: () => this.writePendingPrimaryPurge(marker, true),
        });
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
        const hasPendingPrimaryPurge = await this.completePendingJsonStatePurge(teamName);
        if (!this.jsonHydratedTeams.has(teamName)) {
          if (!hasPendingPrimaryPurge) {
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
    if (!(await this.completePendingJsonStatePurge(teamName))) return;
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
    await this.options!.gateway.recordStoreImport(
      MEMBER_WORK_SYNC_STORE_ID,
      teamName,
      expected.statuses.length + expected.reportIntents.length + expected.outboxItems.length
    );
    await this.replica!.writeClean(teamName, recordsToSnapshot(teamName, roundTrip));
    await this.removePendingPrimaryPurge(teamName);
    this.sqlitePreparedTeams.delete(teamName);
    this.jsonHydratedTeams.delete(teamName);
  }

  private async completePendingJsonStatePurge(teamName: string): Promise<boolean> {
    const marker = await this.readPendingPrimaryPurge(teamName);
    if (!marker) return false;
    if (!marker.activeJsonStateCleared) {
      if (await this.isPendingPrimaryPurgeGenerationCurrent(marker)) {
        await this.jsonStore.purgeActiveState(teamName, {
          establishPendingPrimaryPurge: () => Promise.resolve(),
          isPurgeGenerationCurrent: () => this.isPendingPrimaryPurgeGenerationCurrent(marker),
          confirmActiveStateCleared: () => this.writePendingPrimaryPurge(marker, true),
        });
      } else {
        await this.removePendingPrimaryPurge(teamName);
      }
    }
    return true;
  }

  private async getOrCreatePendingPrimaryPurge(
    teamName: string,
    deletionIdentityId: string | null
  ): Promise<PendingPrimaryPurgeMarker> {
    const existing = await this.readPendingPrimaryPurge(teamName);
    if (existing) {
      if (!deletionIdentityId || existing.deletionIdentityId === deletionIdentityId) {
        return existing;
      }
      if (await this.isPendingPrimaryPurgeGenerationCurrent(existing)) {
        throw new Error(
          `member-work-sync purge already belongs to another deletion generation for "${teamName}"`
        );
      }
      await this.removePendingPrimaryPurge(teamName);
    }
    let teamRootIdentity: DurablePathIdentity | null = null;
    try {
      teamRootIdentity = getDurablePathIdentity(
        await lstat(this.options!.paths.getTeamRootDir(teamName))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      schemaVersion: 2,
      teamName: teamName.trim(),
      deletionIdentityId,
      teamRootIdentity,
      activeJsonStateCleared: false,
      recoverySafe: true,
    };
  }

  private async writePendingPrimaryPurge(
    marker: PendingPrimaryPurgeMarker,
    activeJsonStateCleared: boolean
  ): Promise<void> {
    const teamName = marker.teamName;
    const markerPath = this.options!.paths.getPendingPrimaryPurgePath(teamName);
    const markerDirectory = dirname(markerPath);
    const firstCreatedDirectory = await mkdir(markerDirectory, { recursive: true });
    if (firstCreatedDirectory) {
      await syncDirectoryDurably(dirname(firstCreatedDirectory));
    }
    await atomicWriteAsync(
      markerPath,
      `${JSON.stringify(
        {
          schemaVersion: marker.schemaVersion,
          teamName,
          deletionIdentityId: marker.deletionIdentityId,
          teamRootIdentity: marker.teamRootIdentity,
          activeJsonStateCleared,
        },
        null,
        2
      )}\n`,
      { durability: 'strict', syncDirectory: true }
    );
  }

  private async readPendingPrimaryPurge(
    teamName: string
  ): Promise<PendingPrimaryPurgeMarker | null> {
    let raw: string;
    try {
      raw = await readFile(this.options!.paths.getPendingPrimaryPurgePath(teamName), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const deletionIdentityId =
        typeof parsed.deletionIdentityId === 'string' && parsed.deletionIdentityId.trim()
          ? parsed.deletionIdentityId.trim()
          : null;
      const teamRootIdentity = this.parseDurablePathIdentity(parsed.teamRootIdentity);
      const recoverySafe =
        parsed.schemaVersion === 2 &&
        typeof parsed.teamName === 'string' &&
        parsed.teamName.trim().toLowerCase() === teamName.trim().toLowerCase() &&
        (deletionIdentityId !== null || teamRootIdentity !== null);
      return {
        schemaVersion: 2,
        teamName: teamName.trim(),
        deletionIdentityId,
        teamRootIdentity,
        activeJsonStateCleared: parsed.activeJsonStateCleared === true,
        recoverySafe,
      };
    } catch {
      return {
        schemaVersion: 2,
        teamName: teamName.trim(),
        deletionIdentityId: null,
        teamRootIdentity: null,
        activeJsonStateCleared: false,
        recoverySafe: false,
      };
    }
  }

  private parseDurablePathIdentity(value: unknown): DurablePathIdentity | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const identity = value as Partial<DurablePathIdentity>;
    return typeof identity.dev === 'number' &&
      Number.isFinite(identity.dev) &&
      typeof identity.ino === 'number' &&
      Number.isFinite(identity.ino) &&
      typeof identity.birthtimeMs === 'number' &&
      Number.isFinite(identity.birthtimeMs)
      ? {
          dev: identity.dev,
          ino: identity.ino,
          birthtimeMs: identity.birthtimeMs,
        }
      : null;
  }

  private async isPendingPrimaryPurgeGenerationCurrent(
    marker: PendingPrimaryPurgeMarker
  ): Promise<boolean> {
    if (!marker.recoverySafe) return false;
    const teamRootPath = this.options!.paths.getTeamRootDir(marker.teamName);
    let currentRootIdentity: DurablePathIdentity | null = null;
    try {
      currentRootIdentity = getDurablePathIdentity(await lstat(teamRootPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (!currentRootIdentity) return marker.deletionIdentityId !== null;

    if (marker.deletionIdentityId) {
      try {
        const parsed = JSON.parse(
          await readFile(join(teamRootPath, 'config.json'), 'utf8')
        ) as Record<string, unknown>;
        return parsed._backupIdentityId === marker.deletionIdentityId;
      } catch {
        return false;
      }
    }
    return (
      marker.teamRootIdentity !== null &&
      currentRootIdentity.dev === marker.teamRootIdentity.dev &&
      currentRootIdentity.ino === marker.teamRootIdentity.ino &&
      currentRootIdentity.birthtimeMs === marker.teamRootIdentity.birthtimeMs
    );
  }

  private async removePendingPrimaryPurge(teamName: string): Promise<void> {
    if (!(await this.readPendingPrimaryPurge(teamName))) return;
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
