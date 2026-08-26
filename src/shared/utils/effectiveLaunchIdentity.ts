import type { EffortLevel, TeamProviderBackendId, TeamProviderId } from '@shared/types';

export interface EffectiveLaunchIdentitySelection {
  providerId?: TeamProviderId | null;
  providerBackendId?: TeamProviderBackendId | null;
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface EffectiveLaunchIdentity {
  providerId: TeamProviderId;
  providerBackendId: TeamProviderBackendId | null;
  model: string | null;
  effort: EffortLevel | null;
}

function normalizeModel(model: string | null | undefined): string | null {
  return model?.trim() || null;
}

/**
 * Resolves one launch identity against the lead route. Runtime fields inherit
 * independently only while the member stays on the lead provider.
 */
export function normalizeEffectiveLaunchIdentity(input: {
  lead: EffectiveLaunchIdentitySelection & { providerId: TeamProviderId };
  member?: EffectiveLaunchIdentitySelection;
}): EffectiveLaunchIdentity {
  const lead: EffectiveLaunchIdentity = {
    providerId: input.lead.providerId,
    providerBackendId: input.lead.providerBackendId ?? null,
    model: normalizeModel(input.lead.model),
    effort: input.lead.effort ?? null,
  };
  if (!input.member) return lead;

  const providerId = input.member.providerId ?? lead.providerId;
  const inheritsLeadProvider = providerId === lead.providerId;
  return {
    providerId,
    providerBackendId:
      input.member.providerBackendId ?? (inheritsLeadProvider ? lead.providerBackendId : null),
    model: normalizeModel(input.member.model) ?? (inheritsLeadProvider ? lead.model : null),
    effort: input.member.effort ?? (inheritsLeadProvider ? lead.effort : null),
  };
}
