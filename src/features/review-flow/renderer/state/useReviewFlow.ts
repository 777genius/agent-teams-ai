import { useEffect, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { resolveReviewFlowPolicy } from '../../core/domain/reviewFlowPolicy';
import { isReviewFlowTeamUnavailable } from '../view-model/reviewFlowViewModel';

import { createReviewFlowStore } from './createReviewFlowStore';

import type { ReviewFlowPolicy, ReviewFlowSettings } from '../../contracts/types';
import type { TeamIdentity } from '../view-model/reviewFlowViewModel';
import type { ReviewFlowLoadStatus, ReviewFlowStoreState } from './createReviewFlowStore';

/** Open team data is refreshed only for teams the app already holds, never fetched just for this. */
function refreshOpenTeam(teamName: string): void {
  const app = useStore.getState();
  if (app.selectedTeamName !== teamName && !app.teamDataCacheByName[teamName]) return;
  void app.refreshTeamData(teamName).catch(() => undefined);
}

export const useReviewFlowStore = createReviewFlowStore({
  getApi: () => api.reviewFlow,
  onTeamOverrideChanged: refreshOpenTeam,
});

/** Shared review-flow data. Loads lazily on first use; `revalidate` also refreshes when already loaded. */
export function useReviewFlowOverview(
  options: { revalidate?: boolean } = {}
): ReviewFlowStoreState {
  const state = useReviewFlowStore(
    useShallow((s) => ({
      status: s.status,
      error: s.error,
      defaults: s.defaults,
      defaultsError: s.defaultsError,
      overrides: s.overrides,
      unreadableTeams: s.unreadableTeams,
      unavailable: s.unavailable,
      load: s.load,
      saveDefaults: s.saveDefaults,
      saveTeamOverride: s.saveTeamOverride,
    }))
  );
  const { load } = state;
  const revalidate = options.revalidate === true;
  useEffect(() => {
    void load({ force: revalidate });
  }, [load, revalidate]);
  return state;
}

export interface TeamReviewFlow {
  status: ReviewFlowLoadStatus;
  error: string | null;
  defaults: ReviewFlowSettings;
  /** Set while the saved default for all teams cannot be read. */
  defaultsError: string | null;
  /** This team's saved settings are unreadable, so it must be repaired rather than shown as following. */
  needsRepair: boolean;
  /** Effective settings of this team: its own override, else the default. */
  policy: ReviewFlowPolicy;
  reload: () => Promise<void>;
  save: (settings: ReviewFlowSettings | null) => Promise<void>;
}

export function useTeamReviewFlow(teamName: string): TeamReviewFlow {
  const {
    status,
    error,
    defaults,
    defaultsError,
    overrides,
    unreadableTeams,
    unavailable = [],
    load,
    saveTeamOverride,
  } = useReviewFlowOverview();
  const { t } = useAppTranslation('team');
  const team = useStore((state) => state.teams.find((entry) => entry.teamName === teamName));
  const unavailableHere = isReviewFlowTeamUnavailable(team ?? { teamName }, unavailable);
  const override = overrides[teamName];
  const policy = useMemo(() => resolveReviewFlowPolicy(defaults, override), [defaults, override]);
  return {
    status: unavailableHere ? 'error' : status,
    error: unavailableHere ? t('reviewFlow.unavailable', { count: 1 }) : error,
    defaults,
    defaultsError,
    needsRepair: unreadableTeams.includes(teamName),
    policy,
    reload: () => load({ force: true }),
    save: (settings) => saveTeamOverride(teamName, settings),
  };
}

/** Teams the app already knows, loaded on demand when the list is still empty. */
export function useKnownTeams(): readonly TeamIdentity[] {
  const teams = useStore((state) => state.teams);
  const fetchTeams = useStore((state) => state.fetchTeams);
  useEffect(() => {
    if (teams.length === 0) void fetchTeams();
  }, [teams.length, fetchTeams]);
  return teams;
}
