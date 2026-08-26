import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { normalizeEffectiveLaunchIdentity } from '@shared/utils/effectiveLaunchIdentity';
import {
  buildEffectiveRuntimeRosterRevision,
  resolveEffectiveMemberRuntimeIdentity,
} from '@shared/utils/effectiveMemberRuntimeIdentity';
import {
  getDefaultProviderBackendId,
  migrateProviderBackendId,
} from '@shared/utils/providerBackend';
import {
  isResolvedLeadRuntimeSelectionProvenance,
  normalizeTeamLeadRuntimeSelectionProvenance,
} from '@shared/utils/teamMemberRuntimeSelectionProvenance';

import type {
  CliProviderStatus,
  EffortLevel,
  TeamCreateRequest,
  TeamLeadRuntimeSelectionProvenance,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
} from '@shared/types';

type ProviderStatus = Pick<
  CliProviderStatus,
  'providerId' | 'modelCatalog' | 'resolvedBackendId' | 'selectedBackendId' | 'backend'
>;
interface AuthoritativeMemberDraft {
  name?: string;
  providerId?: string | null;
  providerBackendId?: TeamProviderBackendId | null;
  model?: string | null;
  effort?: EffortLevel;
  runtimeSelectionProvenance?: unknown;
  removedAt?: string | number | null;
}

export interface AuthoritativeModelChecks extends Map<
  TeamProviderId,
  TeamProvisioningModelCheckRequest[]
> {
  runtimeRosterRevision: string | null;
  leadRuntimeSelectionProvenance: TeamLeadRuntimeSelectionProvenance;
}

export function createLeadRuntimeSelectionProvenance(input: {
  backendIsExplicit?: boolean;
  selectedModel?: string | null;
  selectedEffort?: EffortLevel | null;
}): TeamLeadRuntimeSelectionProvenance {
  return {
    version: 1,
    providerBackendId: input.backendIsExplicit ? 'explicit' : 'default',
    model: input.selectedModel?.trim() ? 'explicit' : 'default',
    effort: input.selectedEffort ? 'explicit' : 'default',
  };
}

export function resolveConcreteLaunchModel(input: {
  providerId: TeamProviderId;
  selectedModel?: string | null;
  limitContext?: boolean;
  providerStatus?: ProviderStatus | null;
}): string | null {
  const selectedModel = input.selectedModel?.trim() ?? '';
  const catalog =
    input.providerStatus?.providerId === input.providerId
      ? (input.providerStatus.modelCatalog ?? null)
      : null;
  const catalogLaunchModels = (catalog?.models ?? []).flatMap((model) => {
    const launchModel = model.launchModel?.trim() || model.id?.trim();
    return launchModel ? [launchModel] : [];
  });
  if (input.providerId === 'anthropic') {
    return (
      resolveAnthropicLaunchModel({
        selectedModel,
        limitContext: input.limitContext === true,
        availableLaunchModels: catalogLaunchModels,
        defaultLaunchModel: catalog?.defaultLaunchModel ?? null,
      }) ?? getAnthropicDefaultTeamModel(input.limitContext === true)
    );
  }
  if (selectedModel) return selectedModel;
  return (
    catalog?.defaultLaunchModel?.trim() ||
    catalog?.models.find((model) => model.isDefault)?.launchModel?.trim() ||
    catalog?.models.find((model) => model.isDefault)?.id?.trim() ||
    catalog?.defaultModelId?.trim() ||
    null
  );
}

export function resolveConcreteProviderBackend(input: {
  providerId: TeamProviderId;
  providerStatus?: ProviderStatus | null;
  selectedBackendId?: TeamProviderBackendId | null;
}): TeamProviderBackendId | null {
  if (input.providerId === 'anthropic') return null;
  if (input.selectedBackendId === 'auto') {
    for (const candidate of [
      input.providerStatus?.resolvedBackendId,
      input.providerStatus?.backend?.kind,
    ]) {
      const concrete = migrateProviderBackendId(input.providerId, candidate, 'explicit-selection');
      if (concrete && concrete !== 'auto') return concrete;
    }
    return null;
  }
  const resolved = migrateProviderBackendId(
    input.providerId,
    input.selectedBackendId ??
      input.providerStatus?.resolvedBackendId ??
      input.providerStatus?.selectedBackendId ??
      input.providerStatus?.backend?.kind ??
      getDefaultProviderBackendId(input.providerId),
    'explicit-selection'
  );
  return resolved && resolved !== 'auto' ? resolved : null;
}

export function buildAuthoritativeModelChecks(input: {
  leadProviderId: TeamProviderId;
  leadModel?: string | null;
  leadEffort?: EffortLevel;
  leadBackendId?: TeamProviderBackendId | null;
  leadRuntimeSelectionProvenance?: TeamLeadRuntimeSelectionProvenance;
  leadModelIsDefault?: boolean;
  leadBackendIsDefault?: boolean;
  limitContext?: boolean;
  providerStatusById: ReadonlyMap<TeamProviderId, ProviderStatus | null | undefined>;
  members: readonly AuthoritativeMemberDraft[];
  resolveMember(member: AuthoritativeMemberDraft): {
    providerId: TeamProviderId;
    model?: string | null;
  };
}): AuthoritativeModelChecks {
  const checks = new Map<
    TeamProviderId,
    TeamProvisioningModelCheckRequest[]
  >() as AuthoritativeModelChecks;
  checks.runtimeRosterRevision = null;
  const leadRuntimeSelectionProvenance =
    normalizeTeamLeadRuntimeSelectionProvenance(input.leadRuntimeSelectionProvenance) ??
    createLeadRuntimeSelectionProvenance({
      backendIsExplicit: input.leadBackendId != null && !input.leadBackendIsDefault,
      selectedModel: input.leadModelIsDefault ? null : input.leadModel,
      selectedEffort: input.leadEffort,
    });
  checks.leadRuntimeSelectionProvenance = leadRuntimeSelectionProvenance;
  if (!isResolvedLeadRuntimeSelectionProvenance(leadRuntimeSelectionProvenance)) return checks;
  const leadIdentity = normalizeEffectiveLaunchIdentity({
    lead: {
      providerId: input.leadProviderId,
      providerBackendId: input.leadBackendId,
      model: input.leadModel,
      effort: input.leadEffort,
    },
  });
  const add = (identity: typeof leadIdentity): typeof leadIdentity | null => {
    const { providerId, effort } = identity;
    const model = resolveConcreteLaunchModel({
      providerId,
      selectedModel: identity.model,
      limitContext: input.limitContext,
      providerStatus: input.providerStatusById.get(providerId),
    });
    const providerBackendId = resolveConcreteProviderBackend({
      providerId,
      providerStatus: input.providerStatusById.get(providerId),
      selectedBackendId: identity.providerBackendId,
    });
    if (!model || (providerId !== 'anthropic' && !providerBackendId)) return null;
    const existing = checks.get(providerId) ?? [];
    const check = { providerId, providerBackendId, model, ...(effort ? { effort } : {}) };
    if (!existing.some((entry) => JSON.stringify(entry) === JSON.stringify(check))) {
      checks.set(providerId, [...existing, check]);
    }
    return { providerId, providerBackendId, model, effort };
  };
  const concreteLead = add(leadIdentity);
  const revisionMembers: Array<{
    name: string;
    providerId: TeamProviderId;
    providerBackendId: TeamProviderBackendId | null;
    model: string;
    effort?: EffortLevel;
    runtimeSelectionProvenance: unknown;
  }> = [];
  for (const [memberIndex, member] of input.members.entries()) {
    if (member.removedAt) continue;
    const resolved = input.resolveMember(member);
    const identity = resolveEffectiveMemberRuntimeIdentity({
      lead: leadIdentity,
      member: {
        providerId: resolved.providerId,
        providerBackendId: member.providerBackendId,
        model: member.model,
        effort: member.effort,
        runtimeSelectionProvenance: member.runtimeSelectionProvenance,
      },
      providerDefaults: {
        providerId: resolved.providerId,
        providerBackendId: resolveConcreteProviderBackend({
          providerId: resolved.providerId,
          providerStatus: input.providerStatusById.get(resolved.providerId),
        }),
        model: resolved.model,
      },
      missingProvenance: 'conservative-legacy',
    });
    const concrete = identity ? add(identity) : null;
    if (identity && concrete) {
      revisionMembers.push({
        name: member.name?.trim() || `#${memberIndex}`,
        providerId: concrete.providerId,
        providerBackendId: concrete.providerBackendId,
        model: concrete.model!,
        effort: concrete.effort ?? undefined,
        runtimeSelectionProvenance: identity.provenance,
      });
    }
  }
  checks.runtimeRosterRevision = concreteLead
    ? buildEffectiveRuntimeRosterRevision({
        lead: concreteLead,
        leadRuntimeSelectionProvenance,
        members: revisionMembers,
        missingProvenance: 'reject',
      })
    : null;
  return checks;
}

export function materializeConcreteLaunchRoster(input: {
  members: TeamCreateRequest['members'];
  leadProviderId: TeamProviderId;
  leadModel: string | null | undefined;
  leadEffort?: EffortLevel;
  leadBackendId: TeamProviderBackendId | null | undefined;
  limitContext?: boolean;
  providerStatusById: ReadonlyMap<TeamProviderId, ProviderStatus | null | undefined>;
}): TeamCreateRequest['members'] | null {
  const materialized: TeamCreateRequest['members'] = [];
  for (const member of input.members) {
    const providerId = member.providerId ?? input.leadProviderId;
    const inheritsLead = providerId === input.leadProviderId;
    const resolvedProviderBackend = resolveConcreteProviderBackend({
      providerId,
      providerStatus: input.providerStatusById.get(providerId),
      selectedBackendId: inheritsLead ? input.leadBackendId : undefined,
    });
    const providerDefaultModel = resolveConcreteLaunchModel({
      providerId,
      selectedModel: inheritsLead ? input.leadModel : undefined,
      limitContext: input.limitContext,
      providerStatus: input.providerStatusById.get(providerId),
    });
    const effectiveIdentity = resolveEffectiveMemberRuntimeIdentity({
      lead: {
        providerId: input.leadProviderId,
        providerBackendId: input.leadBackendId,
        model: input.leadModel,
        effort: input.leadEffort,
      },
      member: {
        providerId: member.providerId,
        providerBackendId: member.providerBackendId,
        model: member.model,
        effort: member.effort,
        runtimeSelectionProvenance: member.runtimeSelectionProvenance,
      },
      providerDefaults: {
        providerId,
        providerBackendId: resolvedProviderBackend,
        model: providerDefaultModel,
      },
      missingProvenance: 'conservative-legacy',
    });
    if (!effectiveIdentity) return null;
    const model = resolveConcreteLaunchModel({
      providerId,
      selectedModel: effectiveIdentity.model,
      limitContext: input.limitContext,
      providerStatus: input.providerStatusById.get(providerId),
    });
    const providerBackendId =
      resolveConcreteProviderBackend({
        providerId,
        providerStatus: input.providerStatusById.get(providerId),
        selectedBackendId: effectiveIdentity.providerBackendId,
      }) ?? resolvedProviderBackend;
    if (!model || (providerId !== 'anthropic' && !providerBackendId)) return null;
    const materializedMember: TeamCreateRequest['members'][number] = {
      ...member,
      model,
      runtimeSelectionProvenance: effectiveIdentity.provenance,
    };
    if (providerBackendId) {
      materializedMember.providerBackendId = providerBackendId;
    } else {
      delete materializedMember.providerBackendId;
    }
    if (effectiveIdentity.effort) {
      materializedMember.effort = effectiveIdentity.effort;
    } else {
      delete materializedMember.effort;
    }
    materialized.push(materializedMember);
  }
  return materialized;
}

export function buildMaterializedRuntimeRosterRevision(input: {
  members: TeamCreateRequest['members'];
  leadProviderId: TeamProviderId;
  leadModel: string | null | undefined;
  leadEffort?: EffortLevel;
  leadBackendId: TeamProviderBackendId | null | undefined;
  leadRuntimeSelectionProvenance: TeamLeadRuntimeSelectionProvenance;
}): string | null {
  return buildEffectiveRuntimeRosterRevision({
    lead: {
      providerId: input.leadProviderId,
      providerBackendId: input.leadBackendId,
      model: input.leadModel,
      effort: input.leadEffort,
    },
    leadRuntimeSelectionProvenance: input.leadRuntimeSelectionProvenance,
    members: input.members.map((member) => ({ ...member, removedAt: null })),
    missingProvenance: 'reject',
  });
}
