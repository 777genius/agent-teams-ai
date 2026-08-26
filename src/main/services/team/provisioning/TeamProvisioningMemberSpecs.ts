import { resolveEffectiveMemberRuntimeIdentity } from '@shared/utils/effectiveMemberRuntimeIdentity';
import {
  getDefaultProviderBackendId,
  migrateProviderBackendId,
} from '@shared/utils/providerBackend';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamCreateRequest, TeamProviderBackendId, TeamProviderId } from '@shared/types';

export function getExplicitLaunchModelSelection(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || isDefaultProviderModelSelection(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export type TeamMemberInput = TeamCreateRequest['members'][number];
export type LeadRuntimeSelectionRequest = Pick<
  TeamCreateRequest,
  | 'providerId'
  | 'providerBackendId'
  | 'model'
  | 'effort'
  | 'fastMode'
  | 'limitContext'
  | 'leadRuntimeSelectionProvenance'
>;

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
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
  }
): TeamMemberInput {
  const memberProviderId = normalizeTeamMemberProviderId(member.providerId);
  const defaultProviderId = normalizeTeamMemberProviderId(defaults.providerId) ?? 'anthropic';
  const effectiveProviderId = memberProviderId ?? defaultProviderId;
  const explicitMemberBackendId = member.providerBackendId
    ? migrateProviderBackendId(effectiveProviderId, member.providerBackendId, 'explicit-selection')
    : undefined;
  const resolved = resolveEffectiveMemberRuntimeIdentity({
    lead: {
      providerId: defaultProviderId,
      providerBackendId: migrateProviderBackendId(
        defaultProviderId,
        defaults.providerBackendId ?? getDefaultProviderBackendId(defaultProviderId),
        'explicit-selection'
      ),
      model: getExplicitLaunchModelSelection(defaults.model),
      effort: defaults.effort,
    },
    member: {
      providerId: effectiveProviderId,
      providerBackendId: explicitMemberBackendId,
      model: getExplicitLaunchModelSelection(member.model),
      effort: member.effort,
      runtimeSelectionProvenance: member.runtimeSelectionProvenance,
    },
    missingProvenance: 'conservative-legacy',
  });
  if (!resolved) {
    throw new Error(
      `Member "${member.name}" has unresolved legacy runtime selection provenance; choose provider, model, and effort before launching`
    );
  }
  const identity = resolved;
  const providerBackendId =
    identity.providerBackendId ??
    migrateProviderBackendId(
      identity.providerId,
      getDefaultProviderBackendId(identity.providerId),
      'explicit-selection'
    );

  return {
    ...member,
    providerId: identity.providerId,
    ...(providerBackendId ? { providerBackendId } : {}),
    model: identity.model ?? undefined,
    effort: identity.effort ?? undefined,
    runtimeSelectionProvenance: identity.provenance,
  };
}

export function buildEffectiveTeamMemberSpecs(
  members: TeamCreateRequest['members'],
  defaults: {
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
  }
): TeamCreateRequest['members'] {
  return members.map((member) => buildEffectiveTeamMemberSpec(member, defaults));
}
