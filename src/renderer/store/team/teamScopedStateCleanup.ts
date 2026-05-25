interface TeamMessagesLoadingEntry {
  loadingHead: boolean;
  loadingOlder: boolean;
}

interface TeamScopedVisibleLoadingResetState<
  TTeamMessagesEntry extends TeamMessagesLoadingEntry,
> {
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
  currentProvisioningRunIdByTeam: TeamScopedRecord;
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
  ignoredProvisioningRunIds: Record<string, string>;
  ignoredRuntimeRunIds: Record<string, string>;
  provisioningStartedAtFloorByTeam: Record<string, string>;
}

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

export function collectTeamScopedStateRemovals<TState extends TeamScopedStateRemovalState>(
  state: TState,
  teamName: string
): Partial<Pick<TState, TeamScopedStateRemovalKey>> {
  const nextProvisioningRuns = Object.fromEntries(
    Object.entries(state.provisioningRuns).filter(([, run]) => run.teamName !== teamName)
  ) as TState['provisioningRuns'];
  const nextTeamDataCache = omitTeamKey(state.teamDataCacheByName, teamName);
  const nextTeamAgentRuntime = omitTeamKey(state.teamAgentRuntimeByTeam, teamName);
  const nextTeamMessages = omitTeamKey(state.teamMessagesByName, teamName);
  const nextMemberActivityMeta = omitTeamKey(state.memberActivityMetaByTeam, teamName);
  const nextProvisioningSnapshot = omitTeamKey(state.provisioningSnapshotByTeam, teamName);
  const nextCurrentProvisioningRunId = omitTeamKey(state.currentProvisioningRunIdByTeam, teamName);
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
  const nextIgnoredProvisioningRunIds = { ...state.ignoredProvisioningRunIds };
  const nextIgnoredRuntimeRunIds = { ...state.ignoredRuntimeRunIds };

  const currentProvisioningRunId = state.currentProvisioningRunIdByTeam[teamName];
  const currentRuntimeRunId = state.currentRuntimeRunIdByTeam[teamName];
  if (currentProvisioningRunId) {
    nextIgnoredProvisioningRunIds[currentProvisioningRunId] = teamName;
  }
  if (currentRuntimeRunId) {
    nextIgnoredRuntimeRunIds[currentRuntimeRunId] = teamName;
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
