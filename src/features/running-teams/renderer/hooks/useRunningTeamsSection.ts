import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
} from '@renderer/store/slices/teamSlice';
import { buildTaskCountsByTeam } from '@renderer/utils/pathNormalize';
import { resolveTeamStatus } from '@renderer/utils/teamListStatus';
import { useShallow } from 'zustand/react/shallow';

import { buildRunningTeamsDashboard } from '../../core/domain/policies/buildRunningTeamsDashboard';
import { adaptRunningTeamsSection } from '../adapters/RunningTeamsSectionAdapter';

import type {
  RunningTeamCandidate,
  RunningTeamsCandidateStatus,
} from '../../core/domain/policies/buildRunningTeamsDashboard';
import type { RunningTeamRowModel } from '../adapters/RunningTeamsSectionAdapter';
import type { LeadActivityState, TeamProvisioningProgress, TeamSummary } from '@shared/types';

interface RunningTeamsSectionState {
  rows: RunningTeamRowModel[];
  hidden: boolean;
  openRunningTeam: (row: RunningTeamRowModel) => void;
}

function toCandidate(input: {
  team: TeamSummary;
  aliveTeams: string[];
  provisioningState: {
    currentProvisioningRunIdByTeam: Record<string, string | null>;
    provisioningRuns: Record<string, TeamProvisioningProgress>;
  };
  leadActivityByTeam: Record<string, LeadActivityState>;
  taskCountsByTeam: ReturnType<typeof buildTaskCountsByTeam>;
  nowMs: number;
}): RunningTeamCandidate {
  const status = resolveTeamStatus(
    input.team,
    input.team.teamName,
    input.aliveTeams,
    getCurrentProvisioningProgressForTeam(input.provisioningState, input.team.teamName),
    input.leadActivityByTeam,
    input.nowMs
  ) as RunningTeamsCandidateStatus;

  return {
    teamName: input.team.teamName,
    displayName: input.team.displayName,
    color: input.team.color,
    projectPath: input.team.projectPath,
    lastActivity: input.team.lastActivity,
    status,
    taskCounts: input.taskCountsByTeam.get(input.team.teamName),
  };
}

export function useRunningTeamsSection(searchQuery: string): RunningTeamsSectionState {
  const { t } = useAppTranslation('team');
  const {
    teams,
    globalTasks,
    globalTasksInitialized,
    globalTasksLoading,
    fetchAllTasks,
    openTeamTab,
    provisioningRuns,
    currentProvisioningRunIdByTeam,
    provisioningSnapshotByTeam,
    leadActivityByTeam,
  } = useStore(
    useShallow((state) => ({
      teams: state.teams,
      globalTasks: state.globalTasks,
      globalTasksInitialized: state.globalTasksInitialized,
      globalTasksLoading: state.globalTasksLoading,
      fetchAllTasks: state.fetchAllTasks,
      openTeamTab: state.openTeamTab,
      provisioningRuns: state.provisioningRuns,
      currentProvisioningRunIdByTeam: state.currentProvisioningRunIdByTeam,
      provisioningSnapshotByTeam: state.provisioningSnapshotByTeam,
      leadActivityByTeam: state.leadActivityByTeam,
    }))
  );
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const searchActive = searchQuery.trim().length > 0;
  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );
  const provisioningTeamNames = useMemo(
    () =>
      Object.keys(currentProvisioningRunIdByTeam).filter((teamName) =>
        isTeamProvisioningActive(provisioningState, teamName)
      ),
    [currentProvisioningRunIdByTeam, provisioningState]
  );
  const provisioningTeamNamesKey = useMemo(
    () =>
      [...provisioningTeamNames].sort((left, right) => left.localeCompare(right)).join('\u0000'),
    [provisioningTeamNames]
  );

  useEffect(() => {
    if (searchActive) {
      return;
    }

    let cancelled = false;
    void api.teams
      .aliveList()
      .then((teamNames) => {
        if (!cancelled) {
          setAliveTeams(teamNames);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAliveTeams([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [provisioningTeamNamesKey, searchActive, teams]);

  useEffect(() => {
    if (
      searchActive ||
      globalTasksInitialized ||
      globalTasksLoading ||
      (teams.length === 0 && provisioningTeamNames.length === 0)
    ) {
      return;
    }

    void fetchAllTasks();
  }, [
    fetchAllTasks,
    globalTasksInitialized,
    globalTasksLoading,
    provisioningTeamNames.length,
    searchActive,
    teams.length,
  ]);

  const rows = useMemo(() => {
    if (searchActive) {
      return [];
    }

    const taskCountsByTeam = buildTaskCountsByTeam(globalTasks);
    const existingTeamNames = new Set(teams.map((team) => team.teamName));
    const syntheticProvisioningTeams = provisioningTeamNames
      .filter((teamName) => !existingTeamNames.has(teamName))
      .map((teamName) => provisioningSnapshotByTeam[teamName])
      .filter((team): team is TeamSummary => Boolean(team));
    const nowMs = Date.now();
    const candidateInput = {
      aliveTeams,
      provisioningState,
      leadActivityByTeam,
      taskCountsByTeam,
      nowMs,
    };
    const runningTeams = buildRunningTeamsDashboard({
      teams: teams.map((team) => toCandidate({ ...candidateInput, team })),
      provisioningTeams: syntheticProvisioningTeams.map((team) =>
        toCandidate({ ...candidateInput, team })
      ),
    });

    return adaptRunningTeamsSection(runningTeams, {
      status: {
        active: t('runningTeams.status.active'),
        provisioning: t('runningTeams.status.provisioning'),
        idle: t('runningTeams.status.idle'),
      },
      noProject: t('runningTeams.noProject'),
    });
  }, [
    aliveTeams,
    globalTasks,
    leadActivityByTeam,
    provisioningSnapshotByTeam,
    provisioningState,
    provisioningTeamNames,
    searchActive,
    teams,
    t,
  ]);

  const openRunningTeam = useCallback(
    (row: RunningTeamRowModel): void => {
      openTeamTab(row.teamName, row.projectPath);
    },
    [openTeamTab]
  );

  return {
    rows,
    hidden: searchActive || rows.length === 0,
    openRunningTeam,
  };
}
