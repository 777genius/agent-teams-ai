import { useCallback } from 'react';

import {
  type DashboardRecentProject,
  type DashboardRecentProjectOpenTarget,
} from '@features/recent-projects/contracts';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { getWorktreeNavigationState } from '@renderer/store/utils/stateResetHelpers';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';
import { createLogger } from '@shared/utils/logger';
import { useShallow } from 'zustand/react/shallow';

import {
  buildSyntheticRepositoryGroup,
  encodeProjectPathForNavigation,
  findMatchingWorktree,
  type WorktreeMatch,
} from '../utils/navigation';
import { recordRecentProjectOpenPaths } from '../utils/recentProjectOpenHistory';

const logger = createLogger('Feature:RecentProjects:open');

export function useOpenRecentProject(): {
  openRecentProject: (project: DashboardRecentProject) => Promise<void>;
  openProjectPath: (projectPath: string) => Promise<void>;
  selectProjectFolder: () => Promise<void>;
} {
  const { repositoryGroups, fetchRepositoryGroups, openTeamsTab } = useStore(
    useShallow((state) => ({
      repositoryGroups: state.repositoryGroups,
      fetchRepositoryGroups: state.fetchRepositoryGroups,
      openTeamsTab: state.openTeamsTab,
    }))
  );

  const navigateToMatch = useCallback(
    (match: WorktreeMatch): void => {
      useStore.setState(getWorktreeNavigationState(match.repoId, match.worktreeId));
      void useStore.getState().fetchSessionsInitial(match.worktreeId);
      openTeamsTab();
    },
    [openTeamsTab]
  );

  const openSyntheticPath = useCallback(
    async (path: string, associatedPaths: readonly string[]): Promise<void> => {
      const candidatePaths = associatedPaths.length > 0 ? associatedPaths : [path];
      const selectableCandidatePaths = candidatePaths.filter(
        (candidatePath) => !isEphemeralProjectPath(candidatePath)
      );

      if (selectableCandidatePaths.length === 0) {
        logger.warn('Skipped ephemeral recent project path', { path });
        return;
      }

      const initialMatch = findMatchingWorktree(repositoryGroups, selectableCandidatePaths);
      if (initialMatch) {
        navigateToMatch(initialMatch);
        return;
      }

      await fetchRepositoryGroups();
      const refreshedGroups = useStore.getState().repositoryGroups;
      const refreshedMatch = findMatchingWorktree(refreshedGroups, selectableCandidatePaths);
      if (refreshedMatch) {
        navigateToMatch(refreshedMatch);
        return;
      }

      if (isEphemeralProjectPath(path)) {
        logger.warn('Skipped adding ephemeral recent project path', { path });
        return;
      }

      await api.config.addCustomProjectPath(path);

      useStore.setState((state) => ({
        repositoryGroups: [buildSyntheticRepositoryGroup(path), ...state.repositoryGroups],
      }));

      const encodedId = encodeProjectPathForNavigation(path);
      navigateToMatch({ repoId: encodedId, worktreeId: encodedId });
    },
    [fetchRepositoryGroups, navigateToMatch, repositoryGroups]
  );

  const openTarget = useCallback(
    async (
      target: DashboardRecentProjectOpenTarget,
      associatedPaths: readonly string[]
    ): Promise<void> => {
      if (target.type === 'existing-worktree') {
        navigateToMatch({
          repoId: target.repositoryId,
          worktreeId: target.worktreeId,
        });
        return;
      }

      await openSyntheticPath(target.path, associatedPaths);
    },
    [navigateToMatch, openSyntheticPath]
  );

  const openRecentProject = useCallback(
    async (project: DashboardRecentProject): Promise<void> => {
      try {
        await openTarget(project.openTarget, project.associatedPaths);
        recordRecentProjectOpenPaths([project.primaryPath, ...project.associatedPaths]);
      } catch (error) {
        logger.error('Failed to open recent project', error);
      }
    },
    [openTarget]
  );

  const openProjectPath = useCallback(async (projectPath: string): Promise<void> => {
    try {
      await api.openPath(projectPath, projectPath);
    } catch (error) {
      logger.error('Failed to open project path', error);
    }
  }, []);

  const selectProjectFolder = useCallback(async (): Promise<void> => {
    try {
      const selectedPaths = await api.config.selectFolders();
      const selectedPath = selectedPaths[0];
      if (!selectedPath) {
        return;
      }

      await openSyntheticPath(selectedPath, [selectedPath]);
      recordRecentProjectOpenPaths([selectedPath]);
    } catch (error) {
      logger.error('Failed to select project folder', error);
    }
  }, [openSyntheticPath]);

  return { openRecentProject, openProjectPath, selectProjectFolder };
}
