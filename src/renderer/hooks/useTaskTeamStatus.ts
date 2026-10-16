import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { selectSidebarTeamsDerived } from '@renderer/components/sidebar/sidebarTeamSelectors';
import { selectLeadOfflineTeamNames } from '@renderer/components/sidebar/teamActivitySelectors';
import { useStore } from '@renderer/store';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { isTeamListStatusRunning, resolveTeamStatus } from '@renderer/utils/teamListStatus';
import { useShallow } from 'zustand/react/shallow';

import type { GlobalTask, TeamSummary } from '@shared/types';

function buildTaskTeamSummary(task: GlobalTask): TeamSummary {
  return {
    teamName: task.teamName,
    displayName: task.teamDisplayName,
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: task.updatedAt ?? task.createdAt ?? null,
    projectPath: task.projectPath,
  };
}

/** Shared task-card liveness policy and alive-list refresh lifecycle. */
export function useTaskTeamStatus(): (teamName: string) => boolean {
  const globalTasks = useStore((s) => s.globalTasks);
  const sidebarTeams = useStore((s) => selectSidebarTeamsDerived(s.teams));
  const { provisioningRuns, currentProvisioningRunIdByTeam } = useStore(
    useShallow((s) => ({
      provisioningRuns: s.provisioningRuns,
      currentProvisioningRunIdByTeam: s.currentProvisioningRunIdByTeam,
    }))
  );
  const leadOfflineTeamNames = useStore(
    useShallow((s) => selectLeadOfflineTeamNames(s.leadActivityByTeam))
  );
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [aliveTeamsInitialized, setAliveTeamsInitialized] = useState(false);
  const electronMode = isElectronMode();

  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );

  const fetchAliveTeams = useCallback(async (): Promise<string[] | null> => {
    if (!electronMode || !api.teams?.aliveList) return null;
    try {
      return await api.teams.aliveList();
    } catch {
      return null;
    }
  }, [electronMode]);

  useEffect(() => {
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
        setAliveTeamsInitialized(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, sidebarTeams.identityKey]);

  const readyProgressRefreshKey = useMemo(() => {
    return Object.entries(currentProvisioningRunIdByTeam)
      .map(([teamName, runId]) => {
        if (!runId) return null;
        const progress = provisioningRuns[runId];
        return progress?.state === 'ready'
          ? `${teamName}:${progress.runId}:${progress.updatedAt}`
          : null;
      })
      .filter((item): item is string => Boolean(item))
      .join('|');
  }, [currentProvisioningRunIdByTeam, provisioningRuns]);

  useEffect(() => {
    if (!readyProgressRefreshKey) return;
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
        setAliveTeamsInitialized(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, readyProgressRefreshKey]);

  const offlineTeamNames = useMemo(() => {
    const result = new Set<string>();
    const leadOfflineTeams = new Set(leadOfflineTeamNames);
    if (aliveTeamsInitialized) {
      const teamSummariesByName = new Map<string, TeamSummary>();
      for (const team of sidebarTeams.statusSummaries) {
        teamSummariesByName.set(team.teamName, team);
      }
      for (const task of globalTasks) {
        if (!teamSummariesByName.has(task.teamName)) {
          teamSummariesByName.set(task.teamName, buildTaskTeamSummary(task));
        }
      }

      for (const team of teamSummariesByName.values()) {
        if (leadOfflineTeams.has(team.teamName)) {
          result.add(team.teamName);
          continue;
        }
        const status = resolveTeamStatus(
          team,
          team.teamName,
          aliveTeams,
          getCurrentProvisioningProgressForTeam(provisioningState, team.teamName),
          {}
        );
        if (!isTeamListStatusRunning(status)) {
          result.add(team.teamName);
        }
      }
    }
    for (const teamName of leadOfflineTeamNames) {
      result.add(teamName);
    }
    return result;
  }, [
    aliveTeams,
    aliveTeamsInitialized,
    globalTasks,
    leadOfflineTeamNames,
    provisioningState,
    sidebarTeams.statusSummaries,
  ]);

  const isTeamOffline = useCallback(
    (teamName: string): boolean => offlineTeamNames.has(teamName),
    [offlineTeamNames]
  );
  return isTeamOffline;
}
