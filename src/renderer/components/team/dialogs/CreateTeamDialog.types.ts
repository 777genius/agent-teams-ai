import type { OrganizationPlacementSelection } from '@features/organizations/contracts';
import type { TeamCreateRequest } from '@shared/types';

export interface TeamCopyData extends Pick<
  TeamCreateRequest,
  | 'runtimeSelectionVersion'
  | 'description'
  | 'color'
  | 'prompt'
  | 'providerId'
  | 'model'
  | 'effort'
  | 'fastMode'
  | 'syncModelsWithLead'
  | 'limitContext'
  | 'skipPermissions'
  | 'members'
> {
  teamName: string;
  cwd?: string;
}

export interface ActiveTeamRef {
  teamName: string;
  displayName: string;
  projectPath: string;
}

export interface CreateTeamDialogProps {
  open: boolean;
  canCreate: boolean;
  provisioningErrorsByTeam: Record<string, string | null>;
  clearProvisioningError?: (teamName?: string) => void;
  existingTeamNames: string[];
  /** Team names currently in active provisioning (launching) — used to prevent name conflicts. */
  provisioningTeamNames?: string[];
  activeTeams?: ActiveTeamRef[];
  initialData?: TeamCopyData;
  initialOrganizationPlacement?: OrganizationPlacementSelection | null;
  defaultProjectPath?: string | null;
  forceDefaultProjectSelection?: boolean;
  onClose: () => void;
  onCreate: (
    request: TeamCreateRequest,
    placement?: OrganizationPlacementSelection
  ) => Promise<void>;
  onOpenTeam: (teamName: string, projectPath?: string) => void;
}
