import { useCallback } from 'react';

import {
  type DashboardRecentProject,
  type DashboardRecentProjectOpenTarget,
} from '@features/recent-projects/contracts';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { getWorktreeNavigationState } from '@renderer/store/utils/stateResetHelpers';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';
import { createLogger } from '@shared/utils/logger';
import { useShallow } from 'zustand/react/shallow';

import type { OpenResult } from '../ui/recentProjectsModel';
import {
  buildSyntheticRepositoryGroup,
  encodeProjectPathForNavigation,
  findMatchingWorktree,
  type WorktreeMatch,
} from '../utils/navigation';
import { recordRecentProjectOpenPaths } from '../utils/recentProjectOpenHistory';

const STALE: OpenResult = { kind: 'stale_target' };
const FAILED: OpenResult = { kind: 'failed', message: 'Could not open the project. Try again.' };
const logger = createLogger('Feature:RecentProjects:open');

function logOpenFailure(operation: 'project' | 'reveal' | 'picker', error: unknown): void {
  logger.error('Recent project action failed', {
    operation,
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

export function useOpenRecentProject(): {
  openRecentProject: (project: DashboardRecentProject) => Promise<OpenResult>;
  openProjectPath: (projectPath: string) => Promise<OpenResult>;
  selectProjectFolder: () => Promise<OpenResult>;
} {
  const { repositoryGroups, fetchRepositoryGroups, openTeamsTab } = useStore(
    useShallow((state) => ({
      repositoryGroups: state.repositoryGroups,
      fetchRepositoryGroups: state.fetchRepositoryGroups,
      openTeamsTab: state.openTeamsTab,
    }))
  );

  const captureContext = useCallback(() => {
    const contextId = useStore.getState().activeContextId;
    const epoch = captureContextScopedRequestEpoch();
    return () =>
      useStore.getState().activeContextId === contextId &&
      isContextScopedRequestEpochCurrent(epoch);
  }, []);

  const navigateToMatch = useCallback(
    (match: WorktreeMatch, projectPath: string): void => {
      useStore.setState(getWorktreeNavigationState(match.repoId, match.worktreeId));
      void useStore.getState().fetchSessionsInitial(match.worktreeId);
      openTeamsTab(projectPath);
    },
    [openTeamsTab]
  );

  const openSyntheticPath = useCallback(
    async (path: string, associatedPaths: readonly string[]): Promise<OpenResult> => {
      const isCurrent = captureContext();
      const candidatePaths = associatedPaths.length > 0 ? associatedPaths : [path];
      const selectableCandidatePaths = candidatePaths.filter(
        (candidatePath) => !isEphemeralProjectPath(candidatePath)
      );
      if (selectableCandidatePaths.length === 0 || isEphemeralProjectPath(path)) {
        return { kind: 'unavailable', reason: 'Project path is unavailable.' };
      }

      const initialMatch = findMatchingWorktree(repositoryGroups, selectableCandidatePaths);
      if (initialMatch) {
        if (!isCurrent()) return STALE;
        navigateToMatch(initialMatch, path);
        return { kind: 'opened' };
      }

      await fetchRepositoryGroups();
      if (!isCurrent()) return STALE;
      const refreshedGroups = useStore.getState().repositoryGroups;
      const refreshedMatch = findMatchingWorktree(refreshedGroups, selectableCandidatePaths);
      if (refreshedMatch) {
        navigateToMatch(refreshedMatch, path);
        return { kind: 'opened' };
      }

      await api.config.addCustomProjectPath(path);
      if (!isCurrent()) return STALE;
      useStore.setState((state) => ({
        repositoryGroups: [buildSyntheticRepositoryGroup(path), ...state.repositoryGroups],
      }));
      const encodedId = encodeProjectPathForNavigation(path);
      navigateToMatch({ repoId: encodedId, worktreeId: encodedId }, path);
      return { kind: 'opened' };
    },
    [captureContext, fetchRepositoryGroups, navigateToMatch, repositoryGroups]
  );

  const openTarget = useCallback(
    async (
      target: DashboardRecentProjectOpenTarget,
      associatedPaths: readonly string[],
      primaryPath: string
    ): Promise<OpenResult> => {
      if (target.type === 'existing-worktree') {
        navigateToMatch(
          { repoId: target.repositoryId, worktreeId: target.worktreeId },
          primaryPath
        );
        return { kind: 'opened' };
      }
      return openSyntheticPath(target.path, associatedPaths);
    },
    [navigateToMatch, openSyntheticPath]
  );

  const openRecentProject = useCallback(
    async (project: DashboardRecentProject): Promise<OpenResult> => {
      if (project.filesystemState === 'deleted') {
        return { kind: 'unavailable', reason: 'Project folder is missing.' };
      }
      const isCurrent = captureContext();
      if (!isCurrent()) return STALE;
      try {
        const outcome = await openTarget(
          project.openTarget,
          project.associatedPaths,
          project.primaryPath
        );
        if (outcome.kind !== 'opened') return outcome;
        if (!isCurrent()) return STALE;
        recordRecentProjectOpenPaths([project.primaryPath, ...project.associatedPaths]);
        return outcome;
      } catch (error) {
        if (isCurrent()) logOpenFailure('project', error);
        return isCurrent() ? FAILED : STALE;
      }
    },
    [captureContext, openTarget]
  );

  const openProjectPath = useCallback(
    async (projectPath: string): Promise<OpenResult> => {
      const isCurrent = captureContext();
      if (!isCurrent()) return STALE;
      try {
        await api.openPath(projectPath, projectPath);
        return isCurrent() ? { kind: 'opened' } : STALE;
      } catch (error) {
        if (isCurrent()) logOpenFailure('reveal', error);
        return isCurrent() ? FAILED : STALE;
      }
    },
    [captureContext]
  );

  const selectProjectFolder = useCallback(async (): Promise<OpenResult> => {
    const isCurrent = captureContext();
    try {
      const selectedPaths = await api.config.selectFolders();
      if (!isCurrent()) return STALE;
      const selectedPath = selectedPaths[0];
      if (!selectedPath) return { kind: 'cancelled' };
      const outcome = await openSyntheticPath(selectedPath, [selectedPath]);
      if (outcome.kind !== 'opened') return outcome;
      if (!isCurrent()) return STALE;
      recordRecentProjectOpenPaths([selectedPath]);
      return outcome;
    } catch (error) {
      if (isCurrent()) logOpenFailure('picker', error);
      return isCurrent() ? FAILED : STALE;
    }
  }, [captureContext, openSyntheticPath]);

  return { openRecentProject, openProjectPath, selectProjectFolder };
}
