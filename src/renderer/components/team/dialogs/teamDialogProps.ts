import type { ActiveTeamRef, TeamCopyData } from './createTeamDialogPolicy';
import type { OrganizationPlacementSelection } from '@features/organizations/contracts';
import type {
  ResolvedTeamMember,
  Schedule,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';

export interface CreateTeamDialogProps {
  open: boolean;
  canCreate: boolean;
  provisioningErrorsByTeam: Record<string, string | null>;
  clearProvisioningError?: (teamName?: string) => void;
  existingTeamNames: string[];
  provisioningTeamNames?: string[];
  activeTeams?: ActiveTeamRef[];
  initialData?: TeamCopyData;
  initialOrganizationPlacement?: OrganizationPlacementSelection | null;
  defaultProjectPath?: string | null;
  forceDefaultProjectSelection?: boolean;
  onClose: () => void;
  onCreate(request: TeamCreateRequest, placement?: OrganizationPlacementSelection): Promise<void>;
  onOpenTeam(teamName: string, projectPath?: string): void;
}

interface LaunchDialogBase {
  open: boolean;
  teamName: string;
  onClose(): void;
}

export type TeamLaunchDialogMode = 'launch' | 'relaunch';

interface LaunchDialogLaunchMode extends LaunchDialogBase {
  mode: 'launch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onLaunch(request: TeamLaunchRequest): Promise<void>;
}

interface LaunchDialogRelaunchMode extends LaunchDialogBase {
  mode: 'relaunch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onRelaunch(
    request: TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    isCurrent: () => boolean
  ): Promise<void>;
}

interface LaunchDialogScheduleMode {
  mode: 'schedule';
  open: boolean;
  teamName?: string;
  onClose(): void;
  schedule?: Schedule | null;
}

export type LaunchTeamDialogProps =
  | LaunchDialogLaunchMode
  | LaunchDialogRelaunchMode
  | LaunchDialogScheduleMode;
