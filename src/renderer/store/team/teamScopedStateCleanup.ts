import { addIgnoredTeamRun, pruneProvisioningRuns } from './teamProvisioningRunIdentity';

import type { IgnoredTeamRunOwners } from './teamProvisioningRunIdentity';

interface TeamMessagesLoadingEntry {
  loadingHead: boolean;
  loadingOlder: boolean;
}

interface TeamScopedVisibleLoadingResetState<TTeamMessagesEntry extends TeamMessagesLoadingEntry> {
  teamMessagesByName: Record<string, TTeamMessagesEntry>;
  selectedTeamName: string | null;
  selectedTeamLoading: boolean;
  selectedTeamError: string | null;
}

interface TeamScopedProvisioningRun {
  teamName: string;
}

type TeamScopedRecord = Record<string, unknown>;

interface TeamScopedStateRemovalState<
  TProvisioningRun extends TeamScopedProvisioningRun = TeamScopedProvisioningRun,
> {
  provisioningRuns: Record<string, TProvisioningRun>;
  teamDataCacheByName: TeamScopedRecord;
  teamAgentRuntimeByTeam: TeamScopedRecord;
  teamMessagesByName: TeamScopedRecord;
  memberActivityMetaByTeam: TeamScopedRecord;
  provisioningSnapshotByTeam: TeamScopedRecord;
  currentProvisioningRunIdByTeam: Record<string, string | null | undefined>;
  currentRuntimeRunIdByTeam: TeamScopedRecord;
  provisioningStartedAtFloorByTeam: TeamScopedRecord;
  leadActivityByTeam: TeamScopedRecord;
  leadContextByTeam: TeamScopedRecord;
  activeTaskLogActivityByTeam: TeamScopedRecord;
  activeToolsByTeam: TeamScopedRecord;
  finishedVisibleByTeam: TeamScopedRecord;
  toolHistoryByTeam: TeamScopedRecord;
  memberSpawnStatusesByTeam: TeamScopedRecord;
  memberSpawnSnapshotsByTeam: TeamScopedRecord;
  provisioningErrorByTeam: TeamScopedRecord;
}

type TeamScopedStateRemovalKey = keyof TeamScopedStateRemovalState;

interface TeamScopedProgressTombstoneState {
  currentProvisioningRunIdByTeam: Record<string, string | null | undefined>;
  currentRuntimeRunIdByTeam: Record<string, string | null | undefined>;
  ignoredProvisioningRunIds: IgnoredTeamRunOwners;
  ignoredRuntimeRunIds: IgnoredTeamRunOwners;
  provisioningStartedAtFloorByTeam: Record<string, string>;
}

interface FailedProvisioningAttemptState {
  provisioningRuns: Record<string, TeamScopedProvisioningRun>;
  currentProvisioningRunIdByTeam: Record<string, string | null | undefined>;
  currentRuntimeRunIdByTeam: Record<string, string | null | undefined>;
  provisioningStartedAtFloorByTeam: Record<string, string>;
  provisioningSnapshotByTeam: TeamScopedRecord;
  ignoredProvisioningRunIds: IgnoredTeamRunOwners;
  ignoredRuntimeRunIds: IgnoredTeamRunOwners;
  memberSpawnStatusesByTeam: TeamScopedRecord;
  memberSpawnSnapshotsByTeam: TeamScopedRecord;
  teamAgentRuntimeByTeam: TeamScopedRecord;
  activeToolsByTeam: TeamScopedRecord;
  finishedVisibleByTeam: TeamScopedRecord;
  toolHistoryByTeam: TeamScopedRecord;
}

type FailedProvisioningAttemptCleanupKey = keyof FailedProvisioningAttemptState;

interface StartedProvisioningAttemptState extends FailedProvisioningAttemptState {
  provisioningErrorByTeam: TeamScopedRecord;
}

const currentProvisioningAttemptIdByTeam = new Map<string, string>();

export const teamProvisioningAttemptTracker = {
  begin(teamName: string): string {
    const attemptId = crypto.randomUUID();
    currentProvisioningAttemptIdByTeam.set(teamName, attemptId);
    return attemptId;
  },
  finish(teamName: string, attemptId: string): boolean {
    if (currentProvisioningAttemptIdByTeam.get(teamName) !== attemptId) return false;
    currentProvisioningAttemptIdByTeam.delete(teamName);
    return true;
  },
  clear(teamName: string): void {
    currentProvisioningAttemptIdByTeam.delete(teamName);
  },
  resetForTests(): void {
    currentProvisioningAttemptIdByTeam.clear();
  },
};

export function collectTeamScopedVisibleLoadingResets<
  TTeamMessagesEntry extends TeamMessagesLoadingEntry,
>(
  state: TeamScopedVisibleLoadingResetState<TTeamMessagesEntry>,
  teamName: string
): Partial<TeamScopedVisibleLoadingResetState<TTeamMessagesEntry>> {
  const nextTeamMessagesEntry = state.teamMessagesByName[teamName];
  const nextTeamMessagesByName =
    nextTeamMessagesEntry &&
    (nextTeamMessagesEntry.loadingHead || nextTeamMessagesEntry.loadingOlder)
      ? {
          ...state.teamMessagesByName,
          [teamName]: {
            ...nextTeamMessagesEntry,
            loadingHead: false,
            loadingOlder: false,
          } as TTeamMessagesEntry,
        }
      : null;

  const shouldResetSelectedSurface =
    state.selectedTeamName === teamName &&
    (state.selectedTeamLoading || state.selectedTeamError != null);

  return {
    ...(nextTeamMessagesByName ? { teamMessagesByName: nextTeamMessagesByName } : {}),
    ...(shouldResetSelectedSurface
      ? {
          selectedTeamLoading: false,
          selectedTeamError: null,
        }
      : {}),
  };
}

function omitTeamKey<TRecord extends Record<string, unknown>>(
  record: TRecord,
  teamName: string
): TRecord | null {
  if (!(teamName in record)) {
    return null;
  }
  const next = { ...record };
  delete next[teamName];
  return next;
}

/** Retire only this owner's attempt; another alias may still display the same native run. */
export function collectStartedProvisioningAttemptCleanup<
  TState extends StartedProvisioningAttemptState,
>(
  state: TState,
  teamName: string
): Partial<Pick<TState, keyof StartedProvisioningAttemptState>> {
  const currentProvisioningRunIdByTeam = { ...state.currentProvisioningRunIdByTeam };
  delete currentProvisioningRunIdByTeam[teamName];
  const currentRuntimeRunIdByTeam = { ...state.currentRuntimeRunIdByTeam };
  const previousRuntimeRunId = currentRuntimeRunIdByTeam[teamName];
  delete currentRuntimeRunIdByTeam[teamName];
  return {
    provisioningRuns: pruneProvisioningRuns(
      state.provisioningRuns,
      currentProvisioningRunIdByTeam,
      { teamName }
    ),
    currentProvisioningRunIdByTeam,
    currentRuntimeRunIdByTeam,
    provisioningErrorByTeam:
      omitTeamKey(state.provisioningErrorByTeam, teamName) ?? state.provisioningErrorByTeam,
    memberSpawnStatusesByTeam:
      omitTeamKey(state.memberSpawnStatusesByTeam, teamName) ?? state.memberSpawnStatusesByTeam,
    memberSpawnSnapshotsByTeam:
      omitTeamKey(state.memberSpawnSnapshotsByTeam, teamName) ?? state.memberSpawnSnapshotsByTeam,
    teamAgentRuntimeByTeam:
      omitTeamKey(state.teamAgentRuntimeByTeam, teamName) ?? state.teamAgentRuntimeByTeam,
    activeToolsByTeam: omitTeamKey(state.activeToolsByTeam, teamName) ?? state.activeToolsByTeam,
    finishedVisibleByTeam:
      omitTeamKey(state.finishedVisibleByTeam, teamName) ?? state.finishedVisibleByTeam,
    toolHistoryByTeam: omitTeamKey(state.toolHistoryByTeam, teamName) ?? state.toolHistoryByTeam,
    ignoredRuntimeRunIds: previousRuntimeRunId
      ? addIgnoredTeamRun(state.ignoredRuntimeRunIds, previousRuntimeRunId, teamName)
      : state.ignoredRuntimeRunIds,
  };
}

export function collectTeamScopedStateRemovals<TState extends TeamScopedStateRemovalState>(
  state: TState,
  teamName: string
): Partial<Pick<TState, TeamScopedStateRemovalKey>> {
  const nextCurrentProvisioningRunId = omitTeamKey(state.currentProvisioningRunIdByTeam, teamName);
  const nextProvisioningRuns = pruneProvisioningRuns(
    state.provisioningRuns,
    nextCurrentProvisioningRunId ?? state.currentProvisioningRunIdByTeam,
    { teamName }
  ) as TState['provisioningRuns'];
  const nextTeamDataCache = omitTeamKey(state.teamDataCacheByName, teamName);
  const nextTeamAgentRuntime = omitTeamKey(state.teamAgentRuntimeByTeam, teamName);
  const nextTeamMessages = omitTeamKey(state.teamMessagesByName, teamName);
  const nextMemberActivityMeta = omitTeamKey(state.memberActivityMetaByTeam, teamName);
  const nextProvisioningSnapshot = omitTeamKey(state.provisioningSnapshotByTeam, teamName);
  const nextCurrentRuntimeRunId = omitTeamKey(state.currentRuntimeRunIdByTeam, teamName);
  const nextProvisioningStartedAtFloor = omitTeamKey(
    state.provisioningStartedAtFloorByTeam,
    teamName
  );
  const nextLeadActivity = omitTeamKey(state.leadActivityByTeam, teamName);
  const nextLeadContext = omitTeamKey(state.leadContextByTeam, teamName);
  const nextActiveTaskLogActivity = omitTeamKey(state.activeTaskLogActivityByTeam, teamName);
  const nextActiveTools = omitTeamKey(state.activeToolsByTeam, teamName);
  const nextFinishedVisible = omitTeamKey(state.finishedVisibleByTeam, teamName);
  const nextToolHistory = omitTeamKey(state.toolHistoryByTeam, teamName);
  const nextMemberSpawnStatuses = omitTeamKey(state.memberSpawnStatusesByTeam, teamName);
  const nextMemberSpawnSnapshots = omitTeamKey(state.memberSpawnSnapshotsByTeam, teamName);
  const nextProvisioningErrors = omitTeamKey(state.provisioningErrorByTeam, teamName);

  return {
    ...(Object.keys(nextProvisioningRuns).length !== Object.keys(state.provisioningRuns).length
      ? { provisioningRuns: nextProvisioningRuns }
      : {}),
    ...(nextTeamDataCache ? { teamDataCacheByName: nextTeamDataCache } : {}),
    ...(nextTeamAgentRuntime ? { teamAgentRuntimeByTeam: nextTeamAgentRuntime } : {}),
    ...(nextTeamMessages ? { teamMessagesByName: nextTeamMessages } : {}),
    ...(nextMemberActivityMeta ? { memberActivityMetaByTeam: nextMemberActivityMeta } : {}),
    ...(nextProvisioningSnapshot ? { provisioningSnapshotByTeam: nextProvisioningSnapshot } : {}),
    ...(nextCurrentProvisioningRunId
      ? { currentProvisioningRunIdByTeam: nextCurrentProvisioningRunId }
      : {}),
    ...(nextCurrentRuntimeRunId ? { currentRuntimeRunIdByTeam: nextCurrentRuntimeRunId } : {}),
    ...(nextProvisioningStartedAtFloor
      ? { provisioningStartedAtFloorByTeam: nextProvisioningStartedAtFloor }
      : {}),
    ...(nextLeadActivity ? { leadActivityByTeam: nextLeadActivity } : {}),
    ...(nextLeadContext ? { leadContextByTeam: nextLeadContext } : {}),
    ...(nextActiveTaskLogActivity
      ? { activeTaskLogActivityByTeam: nextActiveTaskLogActivity }
      : {}),
    ...(nextActiveTools ? { activeToolsByTeam: nextActiveTools } : {}),
    ...(nextFinishedVisible ? { finishedVisibleByTeam: nextFinishedVisible } : {}),
    ...(nextToolHistory ? { toolHistoryByTeam: nextToolHistory } : {}),
    ...(nextMemberSpawnStatuses ? { memberSpawnStatusesByTeam: nextMemberSpawnStatuses } : {}),
    ...(nextMemberSpawnSnapshots ? { memberSpawnSnapshotsByTeam: nextMemberSpawnSnapshots } : {}),
    ...(nextProvisioningErrors ? { provisioningErrorByTeam: nextProvisioningErrors } : {}),
  };
}

export function buildTeamScopedProgressTombstones<TState extends TeamScopedProgressTombstoneState>(
  state: TState,
  teamName: string,
  floor: string
): Pick<
  TState,
  'ignoredProvisioningRunIds' | 'ignoredRuntimeRunIds' | 'provisioningStartedAtFloorByTeam'
> {
  let nextIgnoredProvisioningRunIds = state.ignoredProvisioningRunIds;
  let nextIgnoredRuntimeRunIds = state.ignoredRuntimeRunIds;

  const currentProvisioningRunId = state.currentProvisioningRunIdByTeam[teamName];
  const currentRuntimeRunId = state.currentRuntimeRunIdByTeam[teamName];
  if (currentProvisioningRunId) {
    nextIgnoredProvisioningRunIds = addIgnoredTeamRun(
      nextIgnoredProvisioningRunIds,
      currentProvisioningRunId,
      teamName
    );
  }
  if (currentRuntimeRunId) {
    nextIgnoredRuntimeRunIds = addIgnoredTeamRun(
      nextIgnoredRuntimeRunIds,
      currentRuntimeRunId,
      teamName
    );
  }

  return {
    ignoredProvisioningRunIds: nextIgnoredProvisioningRunIds,
    ignoredRuntimeRunIds: nextIgnoredRuntimeRunIds,
    provisioningStartedAtFloorByTeam: {
      ...state.provisioningStartedAtFloorByTeam,
      [teamName]: floor,
    },
  } as Pick<
    TState,
    'ignoredProvisioningRunIds' | 'ignoredRuntimeRunIds' | 'provisioningStartedAtFloorByTeam'
  >;
}

export function collectFailedProvisioningAttemptCleanup<
  TState extends FailedProvisioningAttemptState,
>(
  state: TState,
  teamName: string,
  pendingRunId: string,
  startedAtFloor: string,
  isCurrentAttempt: boolean
): Partial<Pick<TState, FailedProvisioningAttemptCleanupKey>> {
  if (!isCurrentAttempt) return {};

  const currentProvisioningRunId = state.currentProvisioningRunIdByTeam[teamName];
  const currentRuntimeRunId = state.currentRuntimeRunIdByTeam[teamName];
  const failedRunIds = new Set([pendingRunId]);
  for (const runId of [currentProvisioningRunId, currentRuntimeRunId]) {
    if (typeof runId === 'string') {
      failedRunIds.add(runId);
    }
  }

  const provisioningRuns = { ...state.provisioningRuns };
  const otherOwnerRunIds = new Set(
    Object.entries(state.currentProvisioningRunIdByTeam)
      .filter(([owner]) => owner !== teamName)
      .map(([, runId]) => runId)
  );
  let ignoredProvisioningRunIds = state.ignoredProvisioningRunIds;
  for (const runId of failedRunIds) {
    if (!otherOwnerRunIds.has(runId)) delete provisioningRuns[runId];
    ignoredProvisioningRunIds = addIgnoredTeamRun(ignoredProvisioningRunIds, runId, teamName);
  }

  const clearsProvisioning =
    typeof currentProvisioningRunId === 'string' && failedRunIds.has(currentProvisioningRunId);
  const clearsRuntime =
    typeof currentRuntimeRunId === 'string' && failedRunIds.has(currentRuntimeRunId);
  let ignoredRuntimeRunIds = state.ignoredRuntimeRunIds;
  if (clearsRuntime && currentRuntimeRunId) {
    ignoredRuntimeRunIds = addIgnoredTeamRun(ignoredRuntimeRunIds, currentRuntimeRunId, teamName);
  }

  const memberSpawnStatusesByTeam = omitTeamKey(state.memberSpawnStatusesByTeam, teamName);
  const memberSpawnSnapshotsByTeam = omitTeamKey(state.memberSpawnSnapshotsByTeam, teamName);
  const teamAgentRuntimeByTeam = omitTeamKey(state.teamAgentRuntimeByTeam, teamName);
  const activeToolsByTeam = omitTeamKey(state.activeToolsByTeam, teamName);
  const finishedVisibleByTeam = omitTeamKey(state.finishedVisibleByTeam, teamName);
  const toolHistoryByTeam = omitTeamKey(state.toolHistoryByTeam, teamName);
  const provisioningSnapshotByTeam = omitTeamKey(state.provisioningSnapshotByTeam, teamName);
  const clearsCurrentAttempt = clearsProvisioning || clearsRuntime;
  const closedStartedAtFloor = new Date(
    Math.max(Date.now(), Date.parse(startedAtFloor)) + 1
  ).toISOString();

  return {
    provisioningRuns,
    ignoredProvisioningRunIds,
    provisioningStartedAtFloorByTeam: {
      ...state.provisioningStartedAtFloorByTeam,
      [teamName]: closedStartedAtFloor,
    },
    ...(clearsProvisioning
      ? {
          currentProvisioningRunIdByTeam: omitTeamKey(
            state.currentProvisioningRunIdByTeam,
            teamName
          )!,
        }
      : {}),
    ...(clearsRuntime
      ? {
          currentRuntimeRunIdByTeam: omitTeamKey(state.currentRuntimeRunIdByTeam, teamName)!,
          ignoredRuntimeRunIds,
        }
      : {}),
    ...(clearsCurrentAttempt && memberSpawnStatusesByTeam ? { memberSpawnStatusesByTeam } : {}),
    ...(clearsCurrentAttempt && memberSpawnSnapshotsByTeam ? { memberSpawnSnapshotsByTeam } : {}),
    ...(clearsCurrentAttempt && teamAgentRuntimeByTeam ? { teamAgentRuntimeByTeam } : {}),
    ...(clearsCurrentAttempt && activeToolsByTeam ? { activeToolsByTeam } : {}),
    ...(clearsCurrentAttempt && finishedVisibleByTeam ? { finishedVisibleByTeam } : {}),
    ...(clearsCurrentAttempt && toolHistoryByTeam ? { toolHistoryByTeam } : {}),
    ...(clearsCurrentAttempt && provisioningSnapshotByTeam ? { provisioningSnapshotByTeam } : {}),
  };
}
