import type { MemberSettingsRefusalReason } from '../../contracts/memberSettings';

/** The text that explains a refused member settings change, by the code the main process sent. */
export const MEMBER_SETTINGS_REFUSAL_KEYS = {
  project_copy: 'editTeam.errors.refusedProjectCopy',
  project_running: 'detail.tooltips.editUnavailableRunningProject',
  project_launching: 'detail.tooltips.editUnavailableProvisioning',
  project_unreconciled: 'editTeam.errors.refusedProjectUnreconciled',
  team_metadata_unreadable: 'editTeam.errors.refusedTeamUnreadable',
} as const satisfies Record<MemberSettingsRefusalReason, string>;
