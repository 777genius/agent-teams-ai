import { normalizeEffectiveLaunchIdentity } from './effectiveLaunchIdentity';
import {
  isResolvedLeadRuntimeSelectionProvenance,
  isResolvedMemberRuntimeSelectionProvenance,
  normalizeTeamLeadRuntimeSelectionProvenance,
  resolveLeadRuntimeSelectionProvenance,
  resolveMemberRuntimeSelectionProvenance,
} from './teamMemberRuntimeSelectionProvenance';

import type {
  EffortLevel,
  TeamLeadRuntimeSelectionProvenance,
  TeamMemberRuntimeSelectionProvenance,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface MemberRuntimeIdentitySelection {
  providerId?: TeamProviderId | null;
  providerBackendId?: TeamProviderBackendId | null;
  model?: string | null;
  effort?: EffortLevel | null;
  runtimeSelectionProvenance?: unknown;
}

export interface EffectiveMemberRuntimeIdentity {
  providerId: TeamProviderId;
  providerBackendId: TeamProviderBackendId | null;
  model: string | null;
  effort: EffortLevel | null;
  provenance: TeamMemberRuntimeSelectionProvenance;
}

export type MissingRuntimeSelectionProvenancePolicy = 'conservative-legacy' | 'reject';

/**
 * Resolves a member runtime identity one axis at a time from explicit provenance.
 * Concrete values carried on inherited axes are snapshots, not selections.
 */
export function resolveEffectiveMemberRuntimeIdentity(input: {
  lead: MemberRuntimeIdentitySelection & { providerId: TeamProviderId };
  member: MemberRuntimeIdentitySelection;
  /** Current defaults for a member on a provider other than the lead provider. */
  providerDefaults?: MemberRuntimeIdentitySelection;
  missingProvenance: MissingRuntimeSelectionProvenancePolicy;
}): EffectiveMemberRuntimeIdentity | null {
  const providerId = input.member.providerId ?? input.lead.providerId;
  const provenance =
    input.missingProvenance === 'conservative-legacy'
      ? resolveMemberRuntimeSelectionProvenance({
          ...input.member,
          providerId,
          fallbackProviderId: input.lead.providerId,
        })
      : resolveMemberRuntimeSelectionProvenance({
          ...input.member,
          providerId,
          fallbackProviderId: input.lead.providerId,
          runtimeSelectionProvenance:
            input.member.runtimeSelectionProvenance === undefined
              ? { version: 0 }
              : input.member.runtimeSelectionProvenance,
        });
  if (!isResolvedMemberRuntimeSelectionProvenance(provenance)) return null;
  const inheritsLead = providerId === input.lead.providerId;
  const inheritedDefaults = inheritsLead ? input.lead : input.providerDefaults;
  const inheritedBackend = inheritedDefaults
    ? (inheritedDefaults.providerBackendId ?? null)
    : input.member.providerBackendId;
  const inheritedModel = inheritedDefaults ? (inheritedDefaults.model ?? null) : input.member.model;
  const inheritedEffort = inheritedDefaults
    ? (inheritedDefaults.effort ?? null)
    : input.member.effort;
  const selectedBackend =
    provenance.providerBackendId === 'explicit' ? input.member.providerBackendId : inheritedBackend;
  const selectedModel = provenance.model === 'explicit' ? input.member.model : inheritedModel;
  const selectedEffort = provenance.effort === 'explicit' ? input.member.effort : inheritedEffort;

  if (
    (provenance.providerBackendId === 'explicit' && input.member.providerBackendId == null) ||
    (provenance.model === 'explicit' && !input.member.model?.trim()) ||
    (provenance.effort === 'explicit' && input.member.effort == null)
  ) {
    return null;
  }

  const identity = normalizeEffectiveLaunchIdentity({
    lead: {
      providerId,
      providerBackendId: selectedBackend,
      model: selectedModel,
      effort: selectedEffort,
    },
  });
  return { ...identity, provenance };
}

export function buildEffectiveRuntimeRosterRevision(input: {
  lead: MemberRuntimeIdentitySelection & { providerId: TeamProviderId };
  leadRuntimeSelectionProvenance?: TeamLeadRuntimeSelectionProvenance;
  members: readonly (MemberRuntimeIdentitySelection & {
    name: string;
    removedAt?: number | string | null;
  })[];
  missingProvenance: MissingRuntimeSelectionProvenancePolicy;
}): string | null {
  const lead = normalizeEffectiveLaunchIdentity({ lead: input.lead });
  const leadProvenance = input.leadRuntimeSelectionProvenance
    ? normalizeTeamLeadRuntimeSelectionProvenance(input.leadRuntimeSelectionProvenance)
    : resolveLeadRuntimeSelectionProvenance(input.lead);
  if (!isResolvedLeadRuntimeSelectionProvenance(leadProvenance)) return null;
  const members: Array<Record<string, unknown>> = [];
  for (const member of input.members) {
    if (member.removedAt != null) continue;
    const resolved = resolveEffectiveMemberRuntimeIdentity({
      lead,
      member,
      missingProvenance: input.missingProvenance,
    });
    if (!resolved) return null;
    members.push({
      name: member.name.trim().toLowerCase(),
      providerId: resolved.providerId,
      providerBackendId: resolved.providerBackendId,
      model: resolved.model,
      effort: resolved.effort,
      provenance: resolved.provenance,
    });
  }
  members.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return JSON.stringify({
    version: 1,
    lead: {
      providerId: lead.providerId,
      providerBackendId: lead.providerBackendId,
      model: lead.model,
      effort: lead.effort,
      provenance: leadProvenance,
    },
    members,
  });
}
