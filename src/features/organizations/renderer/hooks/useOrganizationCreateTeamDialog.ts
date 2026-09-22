import { useCallback, useMemo } from 'react';

import { api, isElectronMode } from '@renderer/api';
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
}

export function useOrganizationCreateTeamDialog(): UseOrganizationCreateTeamDialogResult {
  const electronMode = isElectronMode();
  const {
    teams,
    connectionMode,
    createTeam,
    openTeamTab,
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

  return {
    canCreate,
    existingTeamNames: teams.map((team) => team.teamName),
    provisioningTeamNames,
    provisioningErrorsByTeam: provisioningErrorByTeam,
    activeTeams,
    clearProvisioningError,
    createTeam: createTeamWithPlacement,
    openTeam: openTeamTab,
  };
}
