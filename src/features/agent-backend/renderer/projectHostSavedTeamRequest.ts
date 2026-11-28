import type { BackendRosterConfiguration } from '../contracts/roster';
import type { TeamCreateRequest } from '@shared/types/team';

/** Original dialog vocabulary, using configured choices rather than effective native values. */
export function projectHostSavedTeamRequest(
  selection: string,
  configuration: BackendRosterConfiguration
): TeamCreateRequest | null {
  if (configuration.savedSettings === undefined) return null;
  if (configuration.members.filter((member) => member.role === 'lead').length !== 1)
    throw new Error('Saved team lead unavailable');
  return {
    ...structuredClone(configuration.savedSettings),
    teamName: selection,
    savedSettingsFingerprint: configuration.revision,
    members: configuration.members
      .filter((member) => member.role !== 'lead')
      .map((member) => ({
        ...structuredClone(member.settings),
        name: member.name,
      })),
  };
}
