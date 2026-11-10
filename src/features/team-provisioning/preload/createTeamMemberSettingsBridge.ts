import {
  TEAM_UPDATE_MEMBER_SETTINGS,
  type TeamMemberSettingsApi,
  type UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts';

export type InvokeIpcWithResult = <T>(channel: string, ...args: unknown[]) => Promise<T>;

export function createTeamMemberSettingsBridge(invoke: InvokeIpcWithResult): TeamMemberSettingsApi {
  return {
    updateMemberSettings: (request) =>
      invoke<UpdateMemberSettingsResult>(TEAM_UPDATE_MEMBER_SETTINGS, request),
  };
}
