import { useEffect, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { findProjectCopyOwner, projectCopyLabel } from '@features/team-project-context/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { resolveReviewFlowPolicy } from '../../core/domain/reviewFlowPolicy';
import {
  foldProjectTeamBoards,
  projectCopyNames,
  type ProjectTeamReviewFlowStatus,
  reviewFlowTeamOf,
  type TeamLevelReviewFlow,
} from '../view-model/projectTeamReviewFlow';
import { isReviewFlowTeamUnavailable, reviewFlowBoardsOf } from '../view-model/reviewFlowViewModel';

import { createReviewFlowStore } from './createReviewFlowStore';

import type {
  ReviewFlowOverview,
  ReviewFlowPolicy,
  ReviewFlowSettings,
} from '../../contracts/types';
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

/** The folder of a project copy as the team list names it, told apart from the team's other projects. */
function projectLabelIn(
  projectTeams: ReviewFlowOverview['projectTeams'],
  teamName: string,
  executionTeamName: string
): string | null {
  const catalog = [
    {
      teamName,
      projectContextMode: 'per_project' as const,
      projectHistoryContexts: projectTeams[teamName]?.projects ?? [],
    },
  ];
  return findProjectCopyOwner(catalog, executionTeamName)?.projectLabel ?? null;
}

/** The shared data with one entry per team (see `foldProjectTeamBoards`). */
export type TeamLevelReviewFlowState = Omit<ReviewFlowStoreState, keyof TeamLevelReviewFlow> &
  TeamLevelReviewFlow;

/** Shared review-flow data. Loads lazily on first use; `revalidate` also refreshes when already loaded. */
export function useReviewFlowOverview(
  options: { revalidate?: boolean } = {}
): TeamLevelReviewFlowState {
  const state = useReviewFlowStore(
    useShallow((s) => ({
      status: s.status,
      error: s.error,
      defaults: s.defaults,
      defaultsError: s.defaultsError,
      overrides: s.overrides,
      unreadableTeams: s.unreadableTeams,
      unavailable: s.unavailable,
      projectTeams: s.projectTeams,
      load: s.load,
      saveDefaults: s.saveDefaults,
      saveTeamOverride: s.saveTeamOverride,
    }))
  );
  const { load, overrides, unreadableTeams, projectTeams } = state;
  const folded = useMemo(
    () =>
      foldProjectTeamBoards({ overrides, unreadableTeams, projectTeams }, (teamName, copy) =>
        projectLabelIn(projectTeams, teamName, copy)
      ),
    [overrides, unreadableTeams, projectTeams]
  );
  const revalidate = options.revalidate === true;
  useEffect(() => {
    void load({ force: revalidate });
  }, [load, revalidate]);
  return { ...state, ...folded };
}

export interface TeamReviewFlow {
  /** The team whose setting this is: a project copy edits its team's. */
  teamName: string;
  status: ReviewFlowLoadStatus;
  error: string | null;
  defaults: ReviewFlowSettings;
  /** Set while the saved default for all teams cannot be read. */
  defaultsError: string | null;
  /** This team's saved settings are unreadable, so it must be repaired rather than shown as following. */
  needsRepair: boolean;
  /** Effective settings of this team: its own override, else the default. */
  policy: ReviewFlowPolicy;
  /** A team with separate history per project: how its project boards relate to its setting. */
  projects: ProjectTeamReviewFlowStatus | null;
  reload: () => Promise<void>;
  save: (settings: ReviewFlowSettings | null) => Promise<void>;
}

/**
 * The review flow shown on a board: its team's (for a project copy, the team it belongs to). Read
 * again when it is shown: the boards of a team's projects also change when a project is launched.
 */
export function useTeamReviewFlow(boardName: string): TeamReviewFlow {
  const overview = useReviewFlowOverview({ revalidate: true });
  const rawProjectTeams = useReviewFlowStore((state) => state.projectTeams);
  const teamName = reviewFlowTeamOf(rawProjectTeams, boardName);
  const { defaults, overrides, unreadableTeams, projectTeams, load, saveTeamOverride } = overview;
  const { t } = useAppTranslation('team');
  const team = useStore((state) => state.teams.find((entry) => entry.teamName === teamName));
  const unavailableHere = isReviewFlowTeamUnavailable(team ?? { teamName }, overview.unavailable);
  const override = overrides[teamName];
  const policy = useMemo(() => resolveReviewFlowPolicy(defaults, override), [defaults, override]);
  return {
    teamName,
    status: unavailableHere ? 'error' : overview.status,
    error: unavailableHere ? t('reviewFlow.unavailable', { count: 1 }) : overview.error,
    defaults,
    defaultsError: overview.defaultsError,
    needsRepair: unreadableTeams.includes(teamName),
    policy,
    projects: projectTeams[teamName] ?? null,
    reload: () => load({ force: true }),
    save: (settings) => saveTeamOverride(teamName, settings),
  };
}

/** The teams a review flow can be set for, as the app knows them (loaded on demand when empty). */
export function useKnownTeams(): readonly TeamIdentity[] {
  const teams = useStore((state) => state.teams);
  const fetchTeams = useStore((state) => state.fetchTeams);
  const projectTeams = useReviewFlowStore((state) => state.projectTeams);
  useEffect(() => {
    if (teams.length === 0) void fetchTeams();
  }, [teams.length, fetchTeams]);
  return useMemo(
    () =>
      reviewFlowBoardsOf(
        teams,
        (name) => projectCopyLabel(teams, name),
        projectCopyNames(projectTeams)
      ),
    [teams, projectTeams]
  );
}
