import type { ActiveTeamRef } from './CreateTeamDialog';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type {
  ResolvedTeamMember,
  Schedule,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';

interface LaunchDialogBase {
  runtimeRunId?: string | null;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  validateMemberSettings?: () => Promise<void>;
  open: boolean;
  teamName: string;
  onClose: () => void;
}

export type TeamLaunchDialogMode = 'launch' | 'relaunch';

interface LaunchDialogLaunchMode extends LaunchDialogBase {
  mode: 'launch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onLaunch: (request: TeamLaunchRequest) => Promise<unknown>;
}

interface LaunchDialogRelaunchMode extends LaunchDialogBase {
  mode: 'relaunch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onRelaunch: (
    request: TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    intent?: import('@shared/types').ReplaceMembersRequest['memberSettingsRelaunch'],
    rosterMetadata?: Parameters<
      typeof import('./teamRelaunchFlow').executeTeamRelaunch
    >[0]['rosterMetadata']
  ) => Promise<void>;
}

interface LaunchDialogScheduleMode {
  mode: 'schedule';
  open: boolean;
  /** Team name — optional when creating from standalone schedules page */
  teamName?: string;
  onClose: () => void;
  /** When provided → edit mode; null/undefined → create mode */
  schedule?: Schedule | null;
}

export type LaunchTeamDialogProps =
  | LaunchDialogLaunchMode
  | LaunchDialogRelaunchMode
  | LaunchDialogScheduleMode;
