import type { TeamMemberSettingsApi } from './api';

function desktopOnly(): Promise<never> {
  return Promise.reject(new Error('Team member settings require the desktop app'));
}

/** Browser mode: member settings are read and changed only in the desktop app. */
export const DESKTOP_ONLY_TEAM_MEMBER_SETTINGS_API: TeamMemberSettingsApi = {
  updateMemberSettings: desktopOnly,
  getMemberSettingsTarget: desktopOnly,
};
