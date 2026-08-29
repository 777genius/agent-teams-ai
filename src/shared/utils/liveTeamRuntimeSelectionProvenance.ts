import {
  isResolvedLeadRuntimeSelectionProvenance,
  isResolvedMemberRuntimeSelectionProvenance,
  normalizeTeamLeadRuntimeSelectionProvenance,
  normalizeTeamMemberRuntimeSelectionProvenance,
} from './teamMemberRuntimeSelectionProvenance';

import type {
  TeamLeadRuntimeSelectionProvenanceCarrier,
  TeamMemberRuntimeSelectionProvenanceCarrier,
} from '@shared/types';

interface LeadSelection extends TeamLeadRuntimeSelectionProvenanceCarrier {
  providerBackendId?: unknown;
  model?: unknown;
  effort?: unknown;
}

interface MemberSelection extends TeamMemberRuntimeSelectionProvenanceCarrier {
  name?: unknown;
  providerBackendId?: unknown;
  model?: unknown;
  effort?: unknown;
}

export function assertLiveLeadRuntimeSelectionProvenance(input: LeadSelection): void {
  const provenance = normalizeTeamLeadRuntimeSelectionProvenance(
    input.leadRuntimeSelectionProvenance
  );
  if (!isResolvedLeadRuntimeSelectionProvenance(provenance)) {
    throw new Error('Lead runtime selection provenance is required and must be resolved');
  }
  if (provenance.providerBackendId === 'explicit' && input.providerBackendId == null) {
    throw new Error('Explicit lead backend provenance requires an exact backend');
  }
  if (provenance.model === 'explicit' && !String(input.model ?? '').trim()) {
    throw new Error('Explicit lead model provenance requires an exact model');
  }
  if (provenance.effort === 'explicit' && input.effort == null) {
    throw new Error('Explicit lead effort provenance requires an exact effort');
  }
}

export function assertLiveMemberRuntimeSelectionProvenance(input: MemberSelection): void {
  const provenance = normalizeTeamMemberRuntimeSelectionProvenance(
    input.runtimeSelectionProvenance
  );
  const label =
    typeof input.name === 'string' && input.name.trim() ? ` "${input.name.trim()}"` : '';
  if (!isResolvedMemberRuntimeSelectionProvenance(provenance)) {
    throw new Error(`Member${label} runtime selection provenance is required and must be resolved`);
  }
  if (provenance.providerBackendId === 'explicit' && input.providerBackendId == null) {
    throw new Error(`Explicit member${label} backend provenance requires an exact backend`);
  }
  if (provenance.model === 'explicit' && !String(input.model ?? '').trim()) {
    throw new Error(`Explicit member${label} model provenance requires an exact model`);
  }
  if (provenance.effort === 'explicit' && input.effort == null) {
    throw new Error(`Explicit member${label} effort provenance requires an exact effort`);
  }
}

export function assertLiveTeamRuntimeSelectionProvenance(
  input: LeadSelection & { members?: readonly MemberSelection[] }
): void {
  assertLiveLeadRuntimeSelectionProvenance(input);
  for (const member of input.members ?? []) assertLiveMemberRuntimeSelectionProvenance(member);
}
