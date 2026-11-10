import { isDefaultProviderModelSelection } from './providerModelSelection';
import { normalizeOptionalTeamProviderId } from './teamProvider';

import type { TeamCreateRequest, TeamProviderId, TeamProvisioningMemberInput } from '../types/team';

export function getExplicitLaunchModelSelection(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return !trimmed || isDefaultProviderModelSelection(trimmed) ? undefined : trimmed;
}

/** One inheritance rule for existing launch preparation and dialog model choices. */
export function buildEffectiveTeamMemberSpec(
  member: TeamProvisioningMemberInput,
  defaults: {
    providerId?: TeamProviderId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
    syncModelsWithLead?: boolean;
  }
): TeamProvisioningMemberInput {
  const memberProviderId = normalizeOptionalTeamProviderId(member.providerId);
  const defaultProviderId = normalizeOptionalTeamProviderId(defaults.providerId) ?? 'anthropic';
  const explicitMemberModel = getExplicitLaunchModelSelection(member.model);
  const inheritsLeadModel =
    defaults.syncModelsWithLead !== false &&
    (memberProviderId == null || memberProviderId === defaultProviderId);
  return {
    ...member,
    providerId: memberProviderId ?? defaultProviderId,
    model:
      explicitMemberModel ||
      (inheritsLeadModel ? getExplicitLaunchModelSelection(defaults.model) : undefined) ||
      undefined,
    effort:
      member.effort ?? (inheritsLeadModel && !explicitMemberModel ? defaults.effort : undefined),
  };
}
