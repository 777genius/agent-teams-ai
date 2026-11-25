import { getOwnedUnixProcessGroup } from '@main/utils/cliProcessCustody';

import {
  snapshotFromRuntimeMemberStatuses,
  snapshotToMemberSpawnStatuses,
} from '../TeamLaunchStateEvaluator';

import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';
import type { ChildProcess } from 'node:child_process';

export interface OwnedSoloLaunchSnapshotRun {
  runId: string;
  teamName: string;
  detectedSessionId?: string | null;
  provisioningComplete: boolean;
  expectedMembers?: readonly string[];
  allEffectiveMembers?: readonly unknown[];
  mixedSecondaryLanes?: readonly unknown[];
  request?: { providerId?: string; members: readonly unknown[] };
  child?: ChildProcess | null;
  cancelRequested?: boolean;
  processKilled?: boolean;
  processClosed?: boolean;
}

/** Existing spawn custody identifies the solo owner; a config or session alone cannot. */
export function captureOwnedSoloLaunchSnapshotRun(
  run: OwnedSoloLaunchSnapshotRun
): (() => boolean) | null {
  const { teamName, runId, detectedSessionId, child } = run;
  if (process.platform === 'win32' || !child) return null;
  const group = getOwnedUnixProcessGroup(child);
  const rootStartIdentity = group?.rootStartIdentity;
  const pid = child.pid;
  const exactIdentity = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !value.includes('\0');
  if (
    !exactIdentity(runId) ||
    !exactIdentity(detectedSessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(teamName) ||
    !pid ||
    !rootStartIdentity ||
    group?.processGroupId !== pid ||
    group.rootProcessGroupId !== pid
  )
    return null;
  const current = (): boolean => {
    const owned = getOwnedUnixProcessGroup(child);
    return (
      run.teamName === teamName &&
      run.runId === runId &&
      run.child === child &&
      run.detectedSessionId === detectedSessionId &&
      child.pid === pid &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.killed !== true &&
      run.provisioningComplete === true &&
      run.cancelRequested === false &&
      run.processKilled === false &&
      run.processClosed === false &&
      Array.isArray(run.expectedMembers) &&
      run.expectedMembers.length === 0 &&
      Array.isArray(run.allEffectiveMembers) &&
      run.allEffectiveMembers.length === 0 &&
      Array.isArray(run.mixedSecondaryLanes) &&
      run.mixedSecondaryLanes.length === 0 &&
      Array.isArray(run.request?.members) &&
      run.request.members.length === 0 &&
      (run.request.providerId === undefined || run.request.providerId === 'anthropic') &&
      owned?.rootStartIdentity === rootStartIdentity &&
      owned.processGroupId === pid &&
      owned.rootProcessGroupId === pid
    );
  };
  return current() ? current : null;
}

export interface TeamProvisioningLiveLaunchSnapshotRun extends OwnedSoloLaunchSnapshotRun {
  expectedMembers: string[];
  isLaunch: boolean;
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: { has(memberName: string): boolean };
}

export interface TeamProvisioningLiveLaunchSnapshotBoundaryDeps<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
> {
  getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[];
  pauseMemberTaskActivityForRuntimeLoss(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  buildMixedPersistedLaunchSnapshotForRun(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null;
  buildRuntimeSpawnStatusRecord(run: TRun): Record<string, MemberSpawnStatusEntry>;
  invalidateMemberSpawnStatusesCache(teamName: string): void;
  emitTeamChange(event: {
    type: 'member-spawn';
    teamName: string;
    runId: string;
    detail: string;
  }): void;
  getRun(runId: string): TRun | undefined;
  maybeFireTeamLaunchedNotificationWhenAllMembersJoined(run: TRun): Promise<void>;
}

export interface TeamProvisioningLiveLaunchSnapshotBoundary<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
> {
  syncRunMemberSpawnStatusesFromSnapshot(run: TRun, snapshot: PersistedTeamLaunchSnapshot): void;
  buildLiveLaunchSnapshotForRun(
    run: TRun,
    launchPhase?: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null;
  emitMemberSpawnChange(run: Pick<TRun, 'teamName' | 'runId'>, memberName: string): void;
}

export interface TeamProvisioningLiveLaunchSnapshotRuntimeCachePort {
  invalidateMemberSpawnStatusesCache(teamName: string): void;
}

export interface TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
> {
  runs: ReadonlyMap<string, TRun>;
  pauseMemberTaskActivityForRuntimeLoss: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>['pauseMemberTaskActivityForRuntimeLoss'];
  buildMixedPersistedLaunchSnapshotForRun: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>['buildMixedPersistedLaunchSnapshotForRun'];
  runtimeSnapshotCacheBoundary: TeamProvisioningLiveLaunchSnapshotRuntimeCachePort;
  teamChangeEmitter?: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>['emitTeamChange'] | null;
  maybeFireTeamLaunchedNotificationWhenAllMembersJoined: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>['maybeFireTeamLaunchedNotificationWhenAllMembersJoined'];
}

export interface TeamProvisioningLiveLaunchSnapshotBoundaryServiceHostOptions<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
> {
  getPersistedLaunchMemberNames: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>['getPersistedLaunchMemberNames'];
  buildRuntimeSpawnStatusRecord: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>['buildRuntimeSpawnStatusRecord'];
}

export function createTeamProvisioningLiveLaunchSnapshotBoundaryDepsFromService<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
>(
  service: TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost<TRun>,
  options: TeamProvisioningLiveLaunchSnapshotBoundaryServiceHostOptions<TRun>
): TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun> {
  return {
    getPersistedLaunchMemberNames: options.getPersistedLaunchMemberNames,
    pauseMemberTaskActivityForRuntimeLoss: (run, memberName, previous, observedAt) =>
      service.pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, observedAt),
    buildMixedPersistedLaunchSnapshotForRun: (run, launchPhase) =>
      service.buildMixedPersistedLaunchSnapshotForRun(run, launchPhase),
    buildRuntimeSpawnStatusRecord: (run) => options.buildRuntimeSpawnStatusRecord(run),
    invalidateMemberSpawnStatusesCache: (teamName) =>
      service.runtimeSnapshotCacheBoundary.invalidateMemberSpawnStatusesCache(teamName),
    emitTeamChange: (event) => {
      service.teamChangeEmitter?.(event);
    },
    getRun: (runId) => service.runs.get(runId),
    maybeFireTeamLaunchedNotificationWhenAllMembersJoined: (run) =>
      service.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(run),
  };
}

export function createTeamProvisioningLiveLaunchSnapshotBoundaryFromService<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
>(
  service: TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost<TRun>,
  options: TeamProvisioningLiveLaunchSnapshotBoundaryServiceHostOptions<TRun>
): TeamProvisioningLiveLaunchSnapshotBoundary<TRun> {
  return createTeamProvisioningLiveLaunchSnapshotBoundary(
    createTeamProvisioningLiveLaunchSnapshotBoundaryDepsFromService(service, options)
  );
}

export function createTeamProvisioningLiveLaunchSnapshotBoundary<
  TRun extends TeamProvisioningLiveLaunchSnapshotRun,
>(
  deps: TeamProvisioningLiveLaunchSnapshotBoundaryDeps<TRun>
): TeamProvisioningLiveLaunchSnapshotBoundary<TRun> {
  return {
    syncRunMemberSpawnStatusesFromSnapshot(run, snapshot) {
      const memberNames = deps.getPersistedLaunchMemberNames(snapshot);
      const snapshotStatuses = snapshotToMemberSpawnStatuses(snapshot);
      run.expectedMembers = memberNames;
      for (const memberName of memberNames) {
        if (run.pendingMemberRestarts?.has(memberName) === true) {
          continue;
        }
        const entry = snapshotStatuses[memberName];
        if (entry) {
          const previous =
            run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
          if (previous.runtimeAlive === true && entry.runtimeAlive !== true) {
            deps.pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, entry.updatedAt);
          }
          run.memberSpawnStatuses.set(memberName, entry);
        }
      }
    },

    buildLiveLaunchSnapshotForRun(
      run,
      launchPhase = run.provisioningComplete ? 'finished' : 'active'
    ) {
      const mixedSnapshot = deps.buildMixedPersistedLaunchSnapshotForRun(run, launchPhase);
      if (mixedSnapshot) {
        return mixedSnapshot;
      }

      const ownedSolo = launchPhase === 'finished' && captureOwnedSoloLaunchSnapshotRun(run);
      if (
        !ownedSolo &&
        (!run.isLaunch || !run.expectedMembers || run.expectedMembers.length === 0)
      ) {
        return null;
      }

      return snapshotFromRuntimeMemberStatuses({
        teamName: run.teamName,
        expectedMembers: run.expectedMembers,
        leadSessionId: run.detectedSessionId ?? undefined,
        launchPhase,
        statuses: deps.buildRuntimeSpawnStatusRecord(run),
      });
    },

    emitMemberSpawnChange(run, memberName) {
      deps.invalidateMemberSpawnStatusesCache(run.teamName);
      deps.emitTeamChange({
        type: 'member-spawn',
        teamName: run.teamName,
        runId: run.runId,
        detail: memberName,
      });
      const trackedRun = deps.getRun(run.runId);
      if (trackedRun?.teamName === run.teamName) {
        void deps.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(trackedRun);
      }
    },
  };
}
