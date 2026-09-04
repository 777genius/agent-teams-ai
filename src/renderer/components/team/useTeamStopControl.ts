import { useCallback, useRef, useState } from 'react';

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

export function useTeamStopControl(): TeamStopControl {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const inFlightRef = useRef(new Set<string>());
  const [stoppingTeams, setStoppingTeams] = useState<ReadonlySet<string>>(new Set());

  const stopTeam = useCallback(
    async (teamName: string, options: StopTeamOptions): Promise<TeamStopActionOutcome | null> => {
      if (inFlightRef.current.has(teamName)) return null;
      inFlightRef.current.add(teamName);
      let actionError: unknown;
      try {
        const outcome = await runTeamStopAction({
          teamName,
          stop: (name) => api.teams.stop(name),
          processAlive: (name) => api.teams.processAlive(name),
          refresh: options.refresh,
          setBusy: (busy) =>
            setStoppingTeams((current) => {
              const next = new Set(current);
              if (busy) next.add(teamName);
              else next.delete(teamName);
              return next;
            }),
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
            console.error('Team stopped, but its status refresh failed:', error),
        });
        options.onOutcome(outcome, actionError);
        return outcome;
      } finally {
        inFlightRef.current.delete(teamName);
      }
    },
    [t, tCommon]
  );

  return {
    isStopping: (teamName) => stoppingTeams.has(teamName),
    stopTeam,
  };
}
