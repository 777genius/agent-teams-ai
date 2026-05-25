import { useEffect } from 'react';

import { useStore } from '@renderer/store';
import { isTeamProvisioningActive, selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

const TEAM_AGENT_RUNTIME_REFRESH_MS = 5_000;

interface TeamAgentRuntimeWatcherOptions {
  teamName: string;
  enabled: boolean;
  isTeamProvisioning?: boolean;
  isTeamAlive?: boolean;
}

export function useTeamAgentRuntimeWatcher({
  teamName,
  enabled,
  isTeamProvisioning,
  isTeamAlive,
}: TeamAgentRuntimeWatcherOptions): void {
  const { leadActivity, storeIsTeamAlive, storeIsTeamProvisioning, fetchTeamAgentRuntime } =
    useStore(
      useShallow((s) => ({
        leadActivity: s.leadActivityByTeam[teamName],
        storeIsTeamAlive: selectTeamDataForName(s, teamName)?.isAlive,
        storeIsTeamProvisioning: isTeamProvisioningActive(s, teamName),
        fetchTeamAgentRuntime: s.fetchTeamAgentRuntime,
      }))
    );

  const effectiveIsTeamAlive = isTeamAlive ?? storeIsTeamAlive;
  const effectiveIsTeamProvisioning = isTeamProvisioning ?? storeIsTeamProvisioning;

  useEffect(() => {
    if (!enabled) return;
    const shouldWatch =
      effectiveIsTeamProvisioning ||
      effectiveIsTeamAlive === true ||
      leadActivity === 'active' ||
      leadActivity === 'idle';
    if (!shouldWatch) return;

    void fetchTeamAgentRuntime(teamName);
    const timer = window.setInterval(() => {
      void fetchTeamAgentRuntime(teamName);
    }, TEAM_AGENT_RUNTIME_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [
    effectiveIsTeamAlive,
    effectiveIsTeamProvisioning,
    enabled,
    fetchTeamAgentRuntime,
    leadActivity,
    teamName,
  ]);
}
