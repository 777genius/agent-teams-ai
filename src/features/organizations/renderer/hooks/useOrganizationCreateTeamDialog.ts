import { useCallback, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { hasUnfinishedCreateTeamDraft } from '@renderer/hooks/useCreateTeamDraftAvailability';
import { resetCreateTeamDraft } from '@renderer/services/resetCreateTeamDraft';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { OrganizationPlacementSelection } from '../../contracts';
import type { TeamCreateRequest } from '@shared/types';

interface ActiveTeamRef {
  teamName: string;
  displayName: string;
  projectPath: string;
}

interface UseOrganizationCreateTeamDialogResult {
  canCreate: boolean;
  existingTeamNames: string[];
  provisioningTeamNames: string[];
  provisioningErrorsByTeam: Record<string, string | null>;
  activeTeams: ActiveTeamRef[];
  clearProvisioningError: (teamName?: string) => void;
  createTeam: (
    request: TeamCreateRequest,
    placement?: OrganizationPlacementSelection
  ) => Promise<void>;
  openTeam: (teamName: string, projectPath?: string) => void;
  openCreationPage: (placement: OrganizationPlacementSelection) => Promise<void>;
}

export function useOrganizationCreateTeamDialog(): UseOrganizationCreateTeamDialogResult {
  const electronMode = isElectronMode();
  const { t } = useAppTranslation('team');
  const {
    teams,
    connectionMode,
    createTeam,
    openTeamTab,
    openTeamsCreationPage,
    provisioningErrorByTeam,
    clearProvisioningError,
    provisioningRuns,
    currentProvisioningRunIdByTeam,
  } = useStore(
    useShallow((state) => ({
      teams: state.teams,
      connectionMode: state.connectionMode,
      createTeam: state.createTeam,
      openTeamTab: state.openTeamTab,
      openTeamsCreationPage: state.openTeamsCreationPage,
      provisioningErrorByTeam: state.provisioningErrorByTeam,
      clearProvisioningError: state.clearProvisioningError,
      provisioningRuns: state.provisioningRuns,
      currentProvisioningRunIdByTeam: state.currentProvisioningRunIdByTeam,
    }))
  );
  const canCreate = electronMode && connectionMode === 'local';
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
  const activeTeams = useMemo<ActiveTeamRef[]>(
    () =>
      teams
        .filter((team) => team.projectPath)
        .map((team) => ({
          teamName: team.teamName,
          displayName: team.displayName,
          projectPath: team.projectPath!,
        })),
    [teams]
  );
  const createTeamWithPlacement = useCallback(
    async (
      request: TeamCreateRequest,
      placement?: OrganizationPlacementSelection
    ): Promise<void> => {
      await createTeam(request);
      if (!placement) {
        return;
      }
      try {
        await api.organizations.assignTeamToUnit({
          ...placement,
          teamName: request.teamName,
          label: request.displayName || request.teamName,
        });
      } catch (error) {
        console.warn('[Organizations] Failed to place created team in organization', error);
      }
    },
    [createTeam]
  );

  const openCreationPage = useCallback(async (placement: OrganizationPlacementSelection) => {
    const hasSavedDraft = await hasUnfinishedCreateTeamDraft();
    const hasOpenEditor = useStore
      .getState()
      .getAllPaneTabs()
      .some((tab) => tab.type === 'teams' && tab.teamsCreationPage);
    if (hasOpenEditor || hasSavedDraft) {
      const accepted = await confirm({
        title: t('create.title.create'),
        message: t('create.draft.replaceConfirmation', {
          defaultValue: 'Creating this team will replace your unfinished draft. Continue?',
        }),
        confirmLabel: t('create.draft.replace', { defaultValue: 'Replace draft' }),
        variant: 'danger',
      });
      if (!accepted) return;
    }
    const originTabId = useStore.getState().getActiveTab()?.id;
    await resetCreateTeamDraft();
    openTeamsCreationPage({ placement, originTabId }, true);
  }, [openTeamsCreationPage, t]);

  return {
    canCreate,
    existingTeamNames: teams.map((team) => team.teamName),
    provisioningTeamNames,
    provisioningErrorsByTeam: provisioningErrorByTeam,
    activeTeams,
    clearProvisioningError,
    createTeam: createTeamWithPlacement,
    openTeam: openTeamTab,
    openCreationPage,
  };
}
