import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export function getExplicitLaunchModelSelection(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || isDefaultProviderModelSelection(trimmed)) {
    return undefined;
  }
  return trimmed;
}

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

export function buildEffectiveTeamMemberSpec(
  member: TeamMemberInput,
  defaults: {
    providerId?: TeamProviderId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
  }
): TeamMemberInput {
  const memberProviderId = normalizeTeamMemberProviderId(member.providerId);
  const defaultProviderId = normalizeTeamMemberProviderId(defaults.providerId);
  const effectiveProviderId = memberProviderId ?? defaultProviderId ?? 'anthropic';
  const explicitMemberModel = getExplicitLaunchModelSelection(member.model);
  const inheritsDefaultRuntime = memberProviderId == null || memberProviderId === defaultProviderId;
  const model =
    explicitMemberModel ||
    (inheritsDefaultRuntime ? getExplicitLaunchModelSelection(defaults.model) : undefined) ||
    undefined;
  const effort =
    member.effort ?? (inheritsDefaultRuntime && !explicitMemberModel ? defaults.effort : undefined);

  return {
    ...member,
    providerId: effectiveProviderId,
    model,
    effort,
  };
}

export function buildEffectiveTeamMemberSpecs(
  members: TeamCreateRequest['members'],
  defaults: {
    providerId?: TeamProviderId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
  }
): TeamCreateRequest['members'] {
  return members.map((member) => buildEffectiveTeamMemberSpec(member, defaults));
}
