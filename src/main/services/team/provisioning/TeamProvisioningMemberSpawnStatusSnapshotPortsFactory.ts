import {
  deriveTeamLaunchAggregateState,
  snapshotFromRuntimeMemberStatuses,
  snapshotToMemberSpawnStatuses,
} from '../TeamLaunchStateEvaluator';

import {
  type MemberSpawnStatusesSnapshotPorts,
  type MemberSpawnStatusRun,
} from './TeamProvisioningMemberSpawnSnapshots';

import type { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

type TeamProvisioningMemberSpawnStatusesMetaMembers = Awaited<
  ReturnType<TeamMembersMetaStore['getMembers']>
>;

const DEFAULT_LIVE_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS = 500;
const DEFAULT_PERSISTED_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS = 5_000;

export interface TeamProvisioningMemberSpawnStatusesSnapshotPortsFactoryDeps<
  TRun extends MemberSpawnStatusRun,
> {
  getRun: MemberSpawnStatusesSnapshotPorts<TRun>['getRun'];
  cache: Omit<MemberSpawnStatusesSnapshotPorts<TRun>['cache'], 'nowMs'> & {
    nowMs(): number;
  };
  persisted: MemberSpawnStatusesSnapshotPorts<TRun>['persisted'];
  live: Omit<
    MemberSpawnStatusesSnapshotPorts<TRun>['live'],
    | 'buildSnapshotFromRuntimeMemberStatuses'
    | 'snapshotToMemberSpawnStatuses'
    | 'deriveTeamLaunchAggregateState'
  >;
  nowIso: MemberSpawnStatusesSnapshotPorts<TRun>['nowIso'];
}

export interface TeamProvisioningMemberSpawnStatusesSnapshotPortsHost<
  TRun extends MemberSpawnStatusRun,
> {
  runs: {
    get(runId: string): TRun | undefined;
  };
  cache: Pick<MemberSpawnStatusesSnapshotPorts<TRun>['cache'], 'snapshotCache' | 'inFlightByTeam'>;
  getCacheGeneration: MemberSpawnStatusesSnapshotPorts<TRun>['cache']['getCacheGeneration'];
  runTracking: {
    getTrackedRunId(teamName: string): string | null;
  };
  ttl?: Partial<
    Pick<MemberSpawnStatusesSnapshotPorts<TRun>['cache'], 'liveCacheTtlMs' | 'persistedCacheTtlMs'>
  >;
  readTaskActivityRepairLaunchSnapshot: MemberSpawnStatusesSnapshotPorts<TRun>['persisted']['readTaskActivityRepairLaunchSnapshot'];
  repairStaleTaskActivityIntervalsOnce: MemberSpawnStatusesSnapshotPorts<TRun>['persisted']['repairStaleTaskActivityIntervalsOnce'];
  reconcilePersistedLaunchState: MemberSpawnStatusesSnapshotPorts<TRun>['persisted']['reconcilePersistedLaunchState'];
  attachLiveRuntimeMetadataToStatuses: MemberSpawnStatusesSnapshotPorts<TRun>['persisted']['attachLiveRuntimeMetadataToStatuses'];
  getOpenCodeSecondaryBootstrapPendingMemberNames: MemberSpawnStatusesSnapshotPorts<TRun>['persisted']['getOpenCodeSecondaryBootstrapPendingMemberNames'];
  taskActivityIntervalService: {
    resumeActiveIntervalsForMembers(
      teamName: string,
      memberNames: readonly string[],
      observedAt: string
    ): void;
  };
  refreshMemberSpawnStatusesFromLeadInbox: MemberSpawnStatusesSnapshotPorts<TRun>['live']['refreshMemberSpawnStatusesFromLeadInbox'];
  maybeAuditMemberSpawnStatuses: MemberSpawnStatusesSnapshotPorts<TRun>['live']['maybeAuditMemberSpawnStatuses'];
  persistLaunchStateSnapshot: MemberSpawnStatusesSnapshotPorts<TRun>['live']['persistLaunchStateSnapshot'];
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  };
  syncRunMemberSpawnStatusesFromSnapshot: MemberSpawnStatusesSnapshotPorts<TRun>['live']['syncRunMemberSpawnStatusesFromSnapshot'];
  buildLiveLaunchSnapshotForRun: MemberSpawnStatusesSnapshotPorts<TRun>['live']['buildLiveLaunchSnapshotForRun'];
  buildRuntimeSpawnStatusRecord: MemberSpawnStatusesSnapshotPorts<TRun>['live']['buildRuntimeSpawnStatusRecord'];
  membersMetaStore: Pick<TeamMembersMetaStore, 'getMembers'>;
  filterRemovedMembersFromLaunchSnapshot(
    snapshot: PersistedTeamLaunchSnapshot,
    metaMembers: TeamProvisioningMemberSpawnStatusesMetaMembers
  ): PersistedTeamLaunchSnapshot | null;
  getPersistedLaunchMemberNames(
    snapshot: PersistedTeamLaunchSnapshot
  ): ReturnType<MemberSpawnStatusesSnapshotPorts<TRun>['live']['getPersistedLaunchMemberNames']>;
  nowMs(): number;
  nowIso: MemberSpawnStatusesSnapshotPorts<TRun>['nowIso'];
}

export function createTeamProvisioningMemberSpawnStatusesSnapshotPorts<
  TRun extends MemberSpawnStatusRun,
>(
  deps: TeamProvisioningMemberSpawnStatusesSnapshotPortsFactoryDeps<TRun>
): MemberSpawnStatusesSnapshotPorts<TRun> {
  return {
    getRun: (runId) => deps.getRun(runId),
    cache: {
      snapshotCache: deps.cache.snapshotCache,
      inFlightByTeam: deps.cache.inFlightByTeam,
      getCacheGeneration: (teamName) => deps.cache.getCacheGeneration(teamName),
      getTrackedRunId: (teamName) => deps.cache.getTrackedRunId(teamName),
      nowMs: () => deps.cache.nowMs(),
      liveCacheTtlMs: deps.cache.liveCacheTtlMs,
      persistedCacheTtlMs: deps.cache.persistedCacheTtlMs,
    },
    persisted: {
      readTaskActivityRepairLaunchSnapshot: (teamName) =>
        deps.persisted.readTaskActivityRepairLaunchSnapshot(teamName),
      repairStaleTaskActivityIntervalsOnce: (teamName, launchSnapshot) =>
        deps.persisted.repairStaleTaskActivityIntervalsOnce(teamName, launchSnapshot),
      reconcilePersistedLaunchState: (teamName) =>
        deps.persisted.reconcilePersistedLaunchState(teamName),
      attachLiveRuntimeMetadataToStatuses: (teamName, statuses, options) =>
        deps.persisted.attachLiveRuntimeMetadataToStatuses(teamName, statuses, options),
      getOpenCodeSecondaryBootstrapPendingMemberNames: (snapshot) =>
        deps.persisted.getOpenCodeSecondaryBootstrapPendingMemberNames(snapshot),
      resumeActiveTaskActivityForMembers: (teamName, memberNames, observedAt) =>
        deps.persisted.resumeActiveTaskActivityForMembers(teamName, memberNames, observedAt),
    },
    live: {
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        deps.live.refreshMemberSpawnStatusesFromLeadInbox(run),
      maybeAuditMemberSpawnStatuses: (run) => deps.live.maybeAuditMemberSpawnStatuses(run),
      persistLaunchStateSnapshot: (run, phase) => deps.live.persistLaunchStateSnapshot(run, phase),
      readLaunchState: (teamName) => deps.live.readLaunchState(teamName),
      syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
        deps.live.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
      buildLiveLaunchSnapshotForRun: (run, phase) =>
        deps.live.buildLiveLaunchSnapshotForRun(run, phase),
      buildSnapshotFromRuntimeMemberStatuses: (input) => snapshotFromRuntimeMemberStatuses(input),
      buildRuntimeSpawnStatusRecord: (run) => deps.live.buildRuntimeSpawnStatusRecord(run),
      getMembersMeta: (teamName) => deps.live.getMembersMeta(teamName),
      filterRemovedMembersFromLaunchSnapshot: (snapshot, metaMembers) =>
        deps.live.filterRemovedMembersFromLaunchSnapshot(snapshot, metaMembers),
      snapshotToMemberSpawnStatuses,
      getPersistedLaunchMemberNames: (snapshot) =>
        deps.live.getPersistedLaunchMemberNames(snapshot),
      deriveTeamLaunchAggregateState,
    },
    nowIso: deps.nowIso,
  };
}

export function createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary<
  TRun extends MemberSpawnStatusRun,
>(
  host: TeamProvisioningMemberSpawnStatusesSnapshotPortsHost<TRun>
): MemberSpawnStatusesSnapshotPorts<TRun> {
  return createTeamProvisioningMemberSpawnStatusesSnapshotPorts<TRun>({
    getRun: (runId) => host.runs.get(runId),
    cache: {
      snapshotCache: host.cache.snapshotCache,
      inFlightByTeam: host.cache.inFlightByTeam,
      getCacheGeneration: (teamName) => host.getCacheGeneration(teamName),
      getTrackedRunId: (teamName) => host.runTracking.getTrackedRunId(teamName),
      nowMs: () => host.nowMs(),
      liveCacheTtlMs:
        host.ttl?.liveCacheTtlMs ?? DEFAULT_LIVE_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
      persistedCacheTtlMs:
        host.ttl?.persistedCacheTtlMs ??
        DEFAULT_PERSISTED_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
    },
    persisted: {
      readTaskActivityRepairLaunchSnapshot: (teamName) =>
        host.readTaskActivityRepairLaunchSnapshot(teamName),
      repairStaleTaskActivityIntervalsOnce: (teamName, launchSnapshot) =>
        host.repairStaleTaskActivityIntervalsOnce(teamName, launchSnapshot),
      reconcilePersistedLaunchState: (teamName) => host.reconcilePersistedLaunchState(teamName),
      attachLiveRuntimeMetadataToStatuses: (teamName, statuses, options) =>
        host.attachLiveRuntimeMetadataToStatuses(teamName, statuses, options),
      getOpenCodeSecondaryBootstrapPendingMemberNames: (snapshot) =>
        host.getOpenCodeSecondaryBootstrapPendingMemberNames(snapshot),
      resumeActiveTaskActivityForMembers: (teamName, memberNames, observedAt) =>
        host.taskActivityIntervalService.resumeActiveIntervalsForMembers(
          teamName,
          memberNames,
          observedAt
        ),
    },
    live: {
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        host.refreshMemberSpawnStatusesFromLeadInbox(run),
      maybeAuditMemberSpawnStatuses: (run) => host.maybeAuditMemberSpawnStatuses(run),
      persistLaunchStateSnapshot: (run, phase) => host.persistLaunchStateSnapshot(run, phase),
      readLaunchState: (teamName) => host.launchStateStore.read(teamName),
      syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
        host.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
      buildLiveLaunchSnapshotForRun: (run, phase) => host.buildLiveLaunchSnapshotForRun(run, phase),
      buildRuntimeSpawnStatusRecord: (run) => host.buildRuntimeSpawnStatusRecord(run),
      getMembersMeta: (teamName) => host.membersMetaStore.getMembers(teamName),
      filterRemovedMembersFromLaunchSnapshot: (snapshot, metaMembers) =>
        snapshot
          ? host.filterRemovedMembersFromLaunchSnapshot(
              snapshot,
              metaMembers as TeamProvisioningMemberSpawnStatusesMetaMembers
            )
          : null,
      getPersistedLaunchMemberNames: (snapshot) =>
        snapshot ? host.getPersistedLaunchMemberNames(snapshot) : [],
    },
    nowIso: host.nowIso,
  });
}
