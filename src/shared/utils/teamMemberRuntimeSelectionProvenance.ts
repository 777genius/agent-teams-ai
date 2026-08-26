import type {
  TeamLeadRuntimeSelectionProvenance,
  TeamMemberRuntimeSelectionProvenance,
  TeamProviderId,
} from '@shared/types';

const MEMBER_SELECTION_KINDS = new Set(['explicit', 'inherited', 'unknown']);
const LEAD_SELECTION_KINDS = new Set(['default', 'explicit', 'unknown']);
const UNKNOWN_REASONS = new Set(['absent', 'invalid', 'partial']);

export function normalizeTeamMemberRuntimeSelectionProvenance(
  value: unknown
): TeamMemberRuntimeSelectionProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !MEMBER_SELECTION_KINDS.has(candidate.providerBackendId as string) ||
    !MEMBER_SELECTION_KINDS.has(candidate.model as string) ||
    !MEMBER_SELECTION_KINDS.has(candidate.effort as string)
  ) {
    return undefined;
  }
  const hasUnknown =
    candidate.providerBackendId === 'unknown' ||
    candidate.model === 'unknown' ||
    candidate.effort === 'unknown';
  const hasUnknownReason = Object.hasOwn(candidate, 'unknownReason');
  if (
    (hasUnknown &&
      (!UNKNOWN_REASONS.has(candidate.unknownReason as string) ||
        candidate.providerBackendId !== 'unknown' ||
        candidate.model !== 'unknown' ||
        candidate.effort !== 'unknown')) ||
    (!hasUnknown && hasUnknownReason)
  ) {
    return undefined;
  }
  return {
    version: 1,
    providerBackendId:
      candidate.providerBackendId as TeamMemberRuntimeSelectionProvenance['providerBackendId'],
    model: candidate.model as TeamMemberRuntimeSelectionProvenance['model'],
    effort: candidate.effort as TeamMemberRuntimeSelectionProvenance['effort'],
    ...(hasUnknown
      ? {
          unknownReason: candidate.unknownReason as NonNullable<
            TeamMemberRuntimeSelectionProvenance['unknownReason']
          >,
        }
      : {}),
  };
}

export function createUnknownMemberRuntimeSelectionProvenance(
  unknownReason: NonNullable<TeamMemberRuntimeSelectionProvenance['unknownReason']>
): TeamMemberRuntimeSelectionProvenance {
  return {
    version: 1,
    providerBackendId: 'unknown',
    model: 'unknown',
    effort: 'unknown',
    unknownReason,
  };
}

export function isResolvedMemberRuntimeSelectionProvenance(
  value: TeamMemberRuntimeSelectionProvenance | undefined
): value is TeamMemberRuntimeSelectionProvenance & {
  providerBackendId: 'explicit' | 'inherited';
  model: 'explicit' | 'inherited';
  effort: 'explicit' | 'inherited';
} {
  return Boolean(
    value &&
    value.providerBackendId !== 'unknown' &&
    value.model !== 'unknown' &&
    value.effort !== 'unknown'
  );
}

export function resolveMemberRuntimeSelectionProvenance(input: {
  providerId?: TeamProviderId | null;
  providerBackendId?: unknown;
  model?: unknown;
  effort?: unknown;
  runtimeSelectionProvenance?: unknown;
  fallbackProviderId?: TeamProviderId;
}): TeamMemberRuntimeSelectionProvenance {
  const normalized = normalizeTeamMemberRuntimeSelectionProvenance(
    input.runtimeSelectionProvenance
  );
  if (normalized) return normalized;
  if (input.runtimeSelectionProvenance !== undefined) {
    return createUnknownMemberRuntimeSelectionProvenance('invalid');
  }
  const providerId = input.providerId ?? input.fallbackProviderId;
  const hasBackend = providerId === 'anthropic' || input.providerBackendId != null;
  const hasModel = typeof input.model === 'string' && input.model.trim().length > 0;
  const hasEffort = input.effort != null;
  if (hasBackend && hasModel && hasEffort) {
    return {
      version: 1,
      providerBackendId: providerId === 'anthropic' ? 'inherited' : 'explicit',
      model: 'explicit',
      effort: 'explicit',
    };
  }
  const hasAny = input.providerBackendId != null || hasModel || hasEffort;
  return createUnknownMemberRuntimeSelectionProvenance(hasAny ? 'partial' : 'absent');
}

export function normalizeTeamLeadRuntimeSelectionProvenance(
  value: unknown
): TeamLeadRuntimeSelectionProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !LEAD_SELECTION_KINDS.has(candidate.providerBackendId as string) ||
    !LEAD_SELECTION_KINDS.has(candidate.model as string) ||
    !LEAD_SELECTION_KINDS.has(candidate.effort as string)
  ) {
    return undefined;
  }
  const hasUnknown =
    candidate.providerBackendId === 'unknown' ||
    candidate.model === 'unknown' ||
    candidate.effort === 'unknown';
  const hasUnknownReason = Object.hasOwn(candidate, 'unknownReason');
  if (
    (hasUnknown &&
      (!UNKNOWN_REASONS.has(candidate.unknownReason as string) ||
        candidate.providerBackendId !== 'unknown' ||
        candidate.model !== 'unknown' ||
        candidate.effort !== 'unknown')) ||
    (!hasUnknown && hasUnknownReason)
  ) {
    return undefined;
  }
  return {
    version: 1,
    providerBackendId:
      candidate.providerBackendId as TeamLeadRuntimeSelectionProvenance['providerBackendId'],
    model: candidate.model as TeamLeadRuntimeSelectionProvenance['model'],
    effort: candidate.effort as TeamLeadRuntimeSelectionProvenance['effort'],
    ...(hasUnknown
      ? {
          unknownReason: candidate.unknownReason as NonNullable<
            TeamLeadRuntimeSelectionProvenance['unknownReason']
          >,
        }
      : {}),
  };
}

export function createUnknownLeadRuntimeSelectionProvenance(
  unknownReason: NonNullable<TeamLeadRuntimeSelectionProvenance['unknownReason']>
): TeamLeadRuntimeSelectionProvenance {
  return {
    version: 1,
    providerBackendId: 'unknown',
    model: 'unknown',
    effort: 'unknown',
    unknownReason,
  };
}

export function isResolvedLeadRuntimeSelectionProvenance(
  value: TeamLeadRuntimeSelectionProvenance | undefined
): value is TeamLeadRuntimeSelectionProvenance & {
  providerBackendId: 'default' | 'explicit';
  model: 'default' | 'explicit';
  effort: 'default' | 'explicit';
} {
  return Boolean(
    value &&
    value.providerBackendId !== 'unknown' &&
    value.model !== 'unknown' &&
    value.effort !== 'unknown'
  );
}

export function resolveLeadRuntimeSelectionProvenance(input: {
  providerId?: TeamProviderId | null;
  providerBackendId?: unknown;
  model?: unknown;
  effort?: unknown;
  leadRuntimeSelectionProvenance?: unknown;
}): TeamLeadRuntimeSelectionProvenance {
  const normalized = normalizeTeamLeadRuntimeSelectionProvenance(
    input.leadRuntimeSelectionProvenance
  );
  if (normalized) return normalized;
  if (input.leadRuntimeSelectionProvenance !== undefined) {
    return createUnknownLeadRuntimeSelectionProvenance('invalid');
  }
  return createUnknownLeadRuntimeSelectionProvenance('absent');
}
