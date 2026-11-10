import { useCallback, useSyncExternalStore } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';

import { runTeamStopAction } from './teamStopAction';

import type { TeamStopActionOutcome } from './teamStopAction';

interface StopTeamOptions {
  refresh(): Promise<void>;
  onOutcome(outcome: TeamStopActionOutcome, error: unknown): void;
}

export interface TeamStopControl {
  isStopping(teamName: string): boolean;
  stopTeam(teamName: string, options: StopTeamOptions): Promise<TeamStopActionOutcome | null>;
}

const stoppingTeamListeners = new Set<() => void>();
let stoppingTeamsSnapshot: ReadonlySet<string> = new Set();

function subscribeToStoppingTeams(listener: () => void): () => void {
  stoppingTeamListeners.add(listener);
  return () => stoppingTeamListeners.delete(listener);
}

function getStoppingTeamsSnapshot(): ReadonlySet<string> {
  return stoppingTeamsSnapshot;
}

function acquireTeamStop(teamName: string): boolean {
  if (stoppingTeamsSnapshot.has(teamName)) return false;
  stoppingTeamsSnapshot = new Set(stoppingTeamsSnapshot).add(teamName);
  stoppingTeamListeners.forEach((listener) => listener());
  return true;
}

function releaseTeamStop(teamName: string): void {
  if (!stoppingTeamsSnapshot.has(teamName)) return;
  const next = new Set(stoppingTeamsSnapshot);
  next.delete(teamName);
  stoppingTeamsSnapshot = next;
  stoppingTeamListeners.forEach((listener) => listener());
}

export function useTeamStopControl(): TeamStopControl {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const stoppingTeams = useSyncExternalStore(
    subscribeToStoppingTeams,
    getStoppingTeamsSnapshot,
    getStoppingTeamsSnapshot
  );

  const stopTeam = useCallback(
    async (teamName: string, options: StopTeamOptions): Promise<TeamStopActionOutcome | null> => {
      if (!acquireTeamStop(teamName)) return null;
      let actionError: unknown;
      try {
        const outcome = await runTeamStopAction({
          teamName,
          stop: (name) => api.teams.stop(name),
          processAlive: (name) => api.teams.processAlive(name),
          refresh: options.refresh,
          setBusy: () => undefined,
          reportFailure: (kind) => {
            const unknown = kind === 'status_unknown';
            void confirm({
              mode: 'info',
              title: t(unknown ? 'detail.stopUnknown.title' : 'detail.stopFailed.title'),
              message: t(unknown ? 'detail.stopUnknown.message' : 'detail.stopFailed.message'),
              confirmLabel: tCommon('actions.close'),
            });
          },
          logError: (error) => {
            actionError ??= error;
            console.error('Team stop operation failed:', error);
          },
          logRefreshError: (error) =>
            console.error('Team status refresh failed after Stop request:', error),
        });
        options.onOutcome(outcome, actionError);
        return outcome;
      } finally {
        releaseTeamStop(teamName);
      }
    },
    [t, tCommon]
  );

  return {
    isStopping: (teamName) => stoppingTeams.has(teamName),
    stopTeam,
  };
}
