import type { TeamMemberSettingsApi } from '../../contracts';

interface LegacyTeamMemberSettingsApi {
  readonly teams: TeamMemberSettingsApi;
}

export function createTeamMemberSettingsRendererApi(
  legacyApi: LegacyTeamMemberSettingsApi
): TeamMemberSettingsApi {
  return {
    updateMemberSettings: (request) => legacyApi.teams.updateMemberSettings(request),
  };
}
