import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MEMBER_WORK_SYNC_STORE_ID } from '@features/internal-storage/contracts/internalStorageContracts';
import {
  type InternalStorageBackendSelector,
  InternalStorageJsonReplica,
  InternalStorageOperationInterruptedError,
  KeyedMutex,
  type MemberWorkSyncStorageGateway,
} from '@features/internal-storage/main';
import {
  atomicWriteAsync,
  type DurablePathIdentity,
  getDurablePathIdentity,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';

import { decodeMemberWorkSyncStoredStatus as decodePreparedStatusValue } from './decodeMemberWorkSyncStoredStatus';
import {
  isMemberWorkSyncStoreSnapshot,
  JsonMemberWorkSyncStore,
  type MemberWorkSyncStoreSnapshot,
  normalizeTeamKey,
} from './JsonMemberWorkSyncStore';
import {
  assertMemberWorkSyncDirtyContinuity,
  validateMemberWorkSyncAuthoritySnapshot,
  validateMemberWorkSyncPrimaryRecords,
} from './memberWorkSyncAuthorityPreparation';
import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import {
  createJsonPreparedStatusBackend,
  createSqlitePreparedStatusBackend,
} from './memberWorkSyncPreparedStatusBackend';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { mergeMemberWorkSyncSnapshots } from './memberWorkSyncSnapshotMerge';
import {
  areSnapshotRecordSetsEquivalent,
  emptyMemberWorkSyncStoreSnapshot as emptySnapshot,
  normalizeMemberWorkSyncStoreSnapshotTeamIdentity,
  recordsToSnapshot,
  snapshotToRecords,
} from './memberWorkSyncSqliteMappers';
import { preflightMemberWorkSyncStatusSources } from './memberWorkSyncStatusPreflight';
import {
  type MemberWorkSyncBackupCandidate,
  mergeMemberWorkSyncBackupHistory,
} from './mergeMemberWorkSyncBackupHistory';

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
  MemberWorkSyncOutboxRecentDeliveredSummary,
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
import type { MemberWorkSyncPreparedStatusBackend } from './MemberWorkSyncStatusAuthority';
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

export interface BackendSelectingMemberWorkSyncStoreOptions {
  gateway: MemberWorkSyncStorageGateway;
  paths: MemberWorkSyncStorePaths;
  fallbackRequiresReplica: boolean;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

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
  private readonly authorityPreparationFailures = new Map<
    string,
    { incarnation: string; at: number; error: unknown }
  >();

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
    // A failed RPC may still own a live SQLite mutation. Deletion cannot
    // clear state or permit same-name recreation until that writer exits.
    await this.options.gateway.waitForSettling?.();
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
      this.authorityPreparationFailures.delete(normalizeTeamKey(teamName));
    });
  }

  /** Privileged restore calls this under its lifecycle fence after quiesce/drain. */
  async invalidatePreparedTeam(teamName: string): Promise<void> {
    await this.replicaMutex.run(teamName, async () => {
      this.authorityPreparationFailures.delete(normalizeTeamKey(teamName));
      this.sqlitePreparedTeams.delete(teamName);
      this.jsonHydratedTeams.delete(teamName);
      await this.sqliteStore.invalidateCanonicalStatusPreparation(teamName);
    });
  }
  async preflightValidatedBackup(backup: MemberWorkSyncBackupCandidate): Promise<void> {
    await this.withPreparedBackend(
      { ...backup.identity, mutation: false },
      async () => undefined,
      backup,
      true
    );
  }
  async restoreValidatedBackup(backup: MemberWorkSyncBackupCandidate): Promise<void> {
    await this.invalidatePreparedTeam(backup.identity.teamName);
    await this.withPreparedBackend(
      { ...backup.identity, mutation: true },
      async () => undefined,
      backup
    );
    await this.invalidatePreparedTeam(backup.identity.teamName);
  }
  /** Called only inside the authority lifecycle fence; callback must not re-enter public run. */
  async withPreparedBackend<T>(
    identity: { teamName: string; incarnation: string; mutation: boolean },
    operation: (backend: MemberWorkSyncPreparedStatusBackend) => Promise<T>,
    backup?: MemberWorkSyncBackupCandidate,
    preflightOnly = false
  ): Promise<T> {
    const { teamName, incarnation } = identity;
    if (!this.options || !this.replica || !incarnation.trim())
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
    const { gateway, paths, fallbackRequiresReplica } = this.options;
    const replica = this.replica;
    const backend = await this.selector.select<'sqlite' | 'json'>('sqlite', 'json');
    return this.replicaMutex.run(teamName, async () => {
      const previousFailure = this.authorityPreparationFailures.get(normalizeTeamKey(teamName));
      const age = previousFailure ? Date.now() - previousFailure.at : 0;
      if (
        !preflightOnly &&
        previousFailure?.incarnation === incarnation &&
        age >= 0 &&
        age < 60_000
      )
        throw previousFailure.error;
      if (!preflightOnly) this.authorityPreparationFailures.delete(normalizeTeamKey(teamName));
      let prepared = false;
      try {
        if (await this.readPendingPrimaryPurge(teamName))
          throw new MemberWorkSyncSafetyJsonReadError('unavailable');
        const source = await replica.readForAuthorityPreparation(teamName, incarnation);
        const candidate =
          source.state === 'clean'
            ? source.snapshot
            : source.state === 'dirty'
              ? source.candidate
              : null;
        if (candidate) validateMemberWorkSyncAuthoritySnapshot(identity, candidate);
        const primary = backend === 'sqlite' ? await gateway.listTeamSnapshot(teamName) : null;
        if (primary) validateMemberWorkSyncPrimaryRecords(identity, primary);
        const canonical = primary ? recordsToSnapshot(teamName, primary) : emptySnapshot();
        validateMemberWorkSyncAuthoritySnapshot(identity, canonical);
        await preflightMemberWorkSyncStatusSources({
          paths,
          identity,
          ...(primary ? { primaryStatuses: primary.statuses } : {}),
        });
        const reader = backup
          ? new JsonMemberWorkSyncStore(paths, { strictIndexReads: true })
          : this.jsonStore;
        const active = await reader.readSnapshotForImport(teamName);
        const archived = await reader.readArchivedSnapshotForImport(teamName);
        for (const snapshot of [active, archived])
          if (snapshot) validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
        let history = mergeDomainSnapshots(archived ?? emptySnapshot(), active);
        if (backup)
          history = mergeMemberWorkSyncBackupHistory({
            identity,
            backend,
            recovered: this.selector.getBackendInfo()?.integrity === 'recovered',
            canonical,
            history,
            backup,
          });
        if (backend === 'json') {
          if (source.state === 'dirty' || (fallbackRequiresReplica && source.state === 'absent'))
            throw new MemberWorkSyncSafetyJsonReadError('unavailable');
          const merged = mergeDomainSnapshots(candidate ?? emptySnapshot(), history);
          if (preflightOnly)
            return await operation(createJsonPreparedStatusBackend(teamName, this.jsonStore));
          if (backup || candidate || active || archived)
            await this.jsonStore.restoreReplicaSnapshot(teamName, merged);
          for (const status of merged.statuses) {
            const stored = await this.jsonStore.readCanonicalStatusSnapshot({
              teamName,
              memberName: status.memberName,
            });
            if (stored.state !== 'present')
              throw new MemberWorkSyncSafetyJsonReadError('unavailable');
            decodePreparedStatusValue(stored.payload, {
              ...identity,
              memberName: status.memberName,
            });
          }
          if (backup) {
            const actual = await this.jsonStore.readSnapshotForImport(teamName);
            if (
              !areSnapshotRecordSetsEquivalent(
                snapshotToRecords(teamName, actual ?? emptySnapshot()),
                snapshotToRecords(teamName, merged)
              )
            )
              throw new MemberWorkSyncSafetyJsonReadError('unavailable');
          }
          prepared = true;
          return await operation(createJsonPreparedStatusBackend(teamName, this.jsonStore));
        }
        if (source.state === 'dirty') {
          if (this.selector.getBackendInfo()?.integrity === 'recovered')
            throw new MemberWorkSyncSafetyJsonReadError('unavailable');
          assertMemberWorkSyncDirtyContinuity(identity, canonical, candidate);
        }
        const merged = mergeDomainSnapshots(mergeDomainSnapshots(canonical, candidate), history);
        const expected = mergeMemberWorkSyncSnapshots(
          teamName,
          primary!,
          snapshotToRecords(teamName, merged)
        );
        validateMemberWorkSyncPrimaryRecords(identity, expected);
        validateMemberWorkSyncAuthoritySnapshot(identity, recordsToSnapshot(teamName, expected));
        if (preflightOnly)
          return await operation(createSqlitePreparedStatusBackend(teamName, this.sqliteStore));
        const importRequired = !areSnapshotRecordSetsEquivalent(primary!, expected);
        const filesToArchive = active?.filesToArchive ?? [];
        const finalizeRequired = importRequired || filesToArchive.length > 0;
        const mutationRequired = identity.mutation || finalizeRequired;
        if (mutationRequired) {
          await replica.markDirtyWithRecoveryCandidate(
            teamName,
            incarnation,
            recordsToSnapshot(teamName, expected)
          );
        }
        if (importRequired) await gateway.importTeam(teamName, expected);
        if (finalizeRequired) {
          await this.sqliteStore.prepareCanonicalStatus(teamName, incarnation, {
            records: expected,
            filesToArchive,
          });
          const prepared = await gateway.listTeamSnapshot(teamName);
          validateMemberWorkSyncPrimaryRecords(identity, prepared);
          if (!areSnapshotRecordSetsEquivalent(prepared, expected))
            throw new MemberWorkSyncSafetyJsonReadError('unavailable');
        }
        prepared = true;
        const result = await operation(
          createSqlitePreparedStatusBackend(teamName, this.sqliteStore)
        );
        const publicationRequired =
          mutationRequired ||
          source.state !== 'clean' ||
          !areSnapshotRecordSetsEquivalent(snapshotToRecords(teamName, source.snapshot), expected);
        if (publicationRequired) {
          const committed = await gateway.listTeamSnapshot(teamName);
          validateMemberWorkSyncPrimaryRecords(identity, committed);
          const snapshot = recordsToSnapshot(teamName, committed);
          validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
          await replica.writeClean(teamName, snapshot, incarnation);
        }
        return result;
      } catch (error) {
        if (
          !preflightOnly &&
          !prepared &&
          !(error instanceof InternalStorageOperationInterruptedError)
        ) {
          if (this.authorityPreparationFailures.size >= 128) {
            const oldest = this.authorityPreparationFailures.keys().next().value;
            if (oldest !== undefined) this.authorityPreparationFailures.delete(oldest);
          }
          this.authorityPreparationFailures.set(normalizeTeamKey(teamName), {
            incarnation,
            at: Date.now(),
            error,
          });
        }
        throw error;
      }
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
  ): Promise<MemberWorkSyncOutboxRecentDeliveredSummary> {
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
  }) {
    return this.run(
      input.teamName,
      false,
      (store) => store.findRecentRecoveryByIntent(input),
      (store) => store.findRecentRecoveryByIntent(input)
    );
  }

  async readItem(input: { teamName: string; memberName: string; id: string }) {
    return this.run(
      input.teamName,
      false,
      (store) => store.readItem(input),
      (store) => store.readItem(input)
    );
  }

  async listLiveStatusMemberNames(teamName: string): Promise<string[]> {
    return this.run(
      teamName,
      false,
      () => this.sqliteStore.listStatusMemberNames(teamName),
      async () =>
        (await this.jsonStore.readSnapshotForImport(teamName))?.statuses.map((s) => s.memberName) ??
        []
    );
  }
  runReplicaFenced<T>(
    teamName: string,
    mutation: boolean,
    sqliteAction: () => Promise<T>,
    jsonAction: () => Promise<T>
  ): Promise<T> {
    return this.run(teamName, mutation, sqliteAction, jsonAction);
  }
}
