import { buildEffectiveTeamMemberSpec } from '@shared/utils/teamMemberRuntimeSelection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export {
  buildEffectiveTeamMemberSpec,
  getExplicitLaunchModelSelection,
} from '@shared/utils/teamMemberRuntimeSelection';

export type TeamMemberInput = TeamCreateRequest['members'][number];

export function normalizeTeamMemberProviderId(providerId: unknown): TeamProviderId | undefined {
  return normalizeOptionalTeamProviderId(providerId);
}

export function normalizeTeamProviderLike(providerId: unknown): TeamProviderId | undefined {
  return normalizeOptionalTeamProviderId(
    typeof providerId === 'string' ? providerId.trim().toLowerCase() : providerId
  );
}

export function teamRequestIncludesCodexMember(
  request: Pick<TeamCreateRequest, 'providerId'> & Partial<Pick<TeamCreateRequest, 'members'>>
): boolean {
  const defaultProviderId = normalizeTeamMemberProviderId(request.providerId) ?? 'anthropic';
  const members = Array.isArray(request.members) ? request.members : [];
  return members.some((member) => {
    const memberProviderId =
      normalizeTeamMemberProviderId(member.providerId) ??
      normalizeTeamMemberProviderId((member as { provider?: unknown }).provider) ??
      defaultProviderId;
    return memberProviderId === 'codex';
  });
}

export function buildEffectiveTeamMemberSpecs(
  members: TeamCreateRequest['members'],
  defaults: {
    providerId?: TeamProviderId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
    syncModelsWithLead?: boolean;
  }
): TeamCreateRequest['members'] {
  return members.map((member) => buildEffectiveTeamMemberSpec(member, defaults));
}
