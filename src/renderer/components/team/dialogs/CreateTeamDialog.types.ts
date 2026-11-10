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
  /** Creation-only surface; launching and relaunching keep their separate dialogs. */
  presentation?: 'dialog' | 'page';
  /** Hidden Teams pages keep their form, but suspend portaled provider settings. */
  active?: boolean;
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
  /** Page Back can return to the originating organization tab; success uses onClose. */
  onBack?: () => void;
  onCreate: (
    request: TeamCreateRequest,
    placement?: OrganizationPlacementSelection
  ) => Promise<string | void>;
  onOpenTeam: (teamName: string, projectPath?: string) => void;
}
