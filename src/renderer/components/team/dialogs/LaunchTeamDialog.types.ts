import type { ActiveTeamRef } from './CreateTeamDialog';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type {
  ResolvedTeamMember,
  Schedule,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';

interface LaunchDialogBase {
  retainedLegacyLaunch?: import('@features/agent-backend/renderer').RetainedLegacyLaunchChoice;
  runtimeRunId?: string | null;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  validateMemberSettings?: () => Promise<void>;
  open: boolean;
  teamName: string;
  /** Verified owned runtime alias; null means no readable project policy (manual approval). */
  projectPermissionTeamName?: string | null;
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
    >[0]['rosterMetadata'],
    onMembersSaved?: () => void
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
  /** A team with separate history per project: the schedule carries its own project. */
  projectScope?: { projectPath?: string };
}

export type LaunchTeamDialogProps = (
  | LaunchDialogLaunchMode
  | LaunchDialogRelaunchMode
  | LaunchDialogScheduleMode
) & {
  /** Project runtimes may adjust provider/permissions, but not the shared roster. */
  rosterReadOnly?: boolean;
};
