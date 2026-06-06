import { useEffect } from 'react';

import { useStore } from '@renderer/store';
import { isTeamProvisioningActive, selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

const TEAM_AGENT_RUNTIME_REFRESH_MS = 10_000;
const ACTIVE_TEAM_AGENT_RUNTIME_REFRESH_MS = 5_000;

interface TeamAgentRuntimeWatchEntry {
  refCount: number;
  timer: number;
  inFlight: boolean;
}

const teamAgentRuntimeWatchEntries = new Map<string, TeamAgentRuntimeWatchEntry>();

export function shouldWatchTeamAgentRuntime(input: {
  enabled: boolean;
  isTeamProvisioning: boolean | undefined;
  isTeamAlive: boolean | undefined;
  leadActivity: 'active' | 'idle' | 'offline' | undefined;
}): boolean {
  if (!input.enabled) return false;
  if (input.isTeamProvisioning) return true;
  if (input.isTeamAlive === true) return true;
  if (input.isTeamAlive === false) return false;
  return input.leadActivity === 'active' || input.leadActivity === 'idle';
}

export function __resetTeamAgentRuntimeWatcherForTests(): void {
  for (const entry of teamAgentRuntimeWatchEntries.values()) {
    window.clearInterval(entry.timer);
  }
  teamAgentRuntimeWatchEntries.clear();
}

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
    const shouldWatch = shouldWatchTeamAgentRuntime({
      enabled,
      isTeamProvisioning: effectiveIsTeamProvisioning,
      isTeamAlive: effectiveIsTeamAlive,
      leadActivity,
    });
    if (!shouldWatch) return;

    const existingEntry = teamAgentRuntimeWatchEntries.get(teamName);
    if (existingEntry) {
      existingEntry.refCount += 1;
      return () => {
        existingEntry.refCount -= 1;
        if (existingEntry.refCount <= 0) {
          window.clearInterval(existingEntry.timer);
          teamAgentRuntimeWatchEntries.delete(teamName);
        }
      };
    }

    const refreshIntervalMs =
      leadActivity === 'active'
        ? ACTIVE_TEAM_AGENT_RUNTIME_REFRESH_MS
        : TEAM_AGENT_RUNTIME_REFRESH_MS;
    const entry: TeamAgentRuntimeWatchEntry = {
      refCount: 1,
      timer: window.setInterval(() => {
        refreshTeamAgentRuntime(teamName, fetchTeamAgentRuntime);
      }, refreshIntervalMs),
      inFlight: false,
    };
    teamAgentRuntimeWatchEntries.set(teamName, entry);
    refreshTeamAgentRuntime(teamName, fetchTeamAgentRuntime);

    return () => {
      entry.refCount -= 1;
      if (entry.refCount <= 0) {
        window.clearInterval(entry.timer);
        teamAgentRuntimeWatchEntries.delete(teamName);
      }
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

function refreshTeamAgentRuntime(
  teamName: string,
  fetchTeamAgentRuntime: (teamName: string) => Promise<void>
): void {
  const entry = teamAgentRuntimeWatchEntries.get(teamName);
  if (!entry || entry.inFlight) return;

  entry.inFlight = true;
  void fetchTeamAgentRuntime(teamName)
    .catch(() => undefined)
    .finally(() => {
      const latestEntry = teamAgentRuntimeWatchEntries.get(teamName);
      if (latestEntry === entry) {
        latestEntry.inFlight = false;
      }
    });
}
