export type { BackupFileDescriptor } from '@agent-teams/legacy-agent-host/lifecycle';
export {
  collectRecursiveFiles,
  collectRecursiveFilesSync,
} from '@agent-teams/legacy-agent-host/lifecycle';

import { TEAM_PROFILE_OWNER_MARKER_FILE } from './provisioning/TeamProvisioningProfileOwnership';
import { TEAM_LAUNCH_STOPPED_MARKER_FILE } from './TeamLaunchStateStore';

export const TEAM_ROOT_FILES = [
  'config.json',
  // Only teams carrying this profile's marker are backed up; a restored team keeps it.
  TEAM_PROFILE_OWNER_MARKER_FILE,
  'team.meta.json',
  'launch-state.json',
  'launch-summary.json',
  TEAM_LAUNCH_STOPPED_MARKER_FILE,
  'kanban-state.json',
  'sentMessages.json',
  'sent-cross-team.json',
  'members.meta.json',
  'comment-notification-journal.json',
];

// Subdirs under ~/.claude/teams/{teamName}/
export const TEAM_SUBDIRS = ['inboxes', 'review-decisions'];
export const TEAM_RECURSIVE_SUBDIRS = ['.opencode-runtime', 'members', '.member-work-sync'];
// Subdirs under getAppDataPath() (our own storage, not in ~/.claude/)
export const APP_DATA_SUBDIRS = ['attachments'];
export const APP_DATA_DEEP_SUBDIRS = ['task-attachments'];
