import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  EffortLevel,
  TeamFastMode,
  TeamMemberMcpPolicy,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningMemberInput,
} from '@shared/types';

interface CopyableTeamMember {
  name?: string;
  agentType?: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  selectedFastMode?: TeamFastMode;
  mcpPolicy?: TeamMemberMcpPolicy;
  removedAt?: number | string | null;
}

function normalizeCopyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCopyFastMode(value: unknown): TeamFastMode | undefined {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : undefined;
}

function getMemberKey(member: Pick<CopyableTeamMember, 'name'>): string | null {
  const name = normalizeCopyString(member.name);
  return name ? name.toLowerCase() : null;
}

function isCopyableTeammate(member: CopyableTeamMember): boolean {
  const name = normalizeCopyString(member.name);
  return Boolean(name) && !member.removedAt && !isLeadMember(member);
}

function resolveRole(
  member: CopyableTeamMember,
  fallback?: CopyableTeamMember
): string | undefined {
  const explicitRole = normalizeCopyString(member.role) ?? normalizeCopyString(fallback?.role);
  if (explicitRole) {
    return explicitRole;
  }
  const agentType =
    normalizeCopyString(member.agentType) ?? normalizeCopyString(fallback?.agentType);
  return agentType && agentType !== 'general-purpose' ? agentType : undefined;
}

function toCopiedMember(
  member: CopyableTeamMember,
  fallback?: CopyableTeamMember
): TeamProvisioningMemberInput | null {
  const name = normalizeCopyString(member.name);
  if (!name) {
    return null;
  }

  const providerId =
    normalizeOptionalTeamProviderId(member.providerId) ??
    normalizeOptionalTeamProviderId(fallback?.providerId);
  const effort = isTeamEffortLevel(member.effort)
    ? member.effort
    : isTeamEffortLevel(fallback?.effort)
      ? fallback.effort
      : undefined;
  const fastMode =
    normalizeCopyFastMode(member.fastMode) ??
    normalizeCopyFastMode(member.selectedFastMode) ??
    normalizeCopyFastMode(fallback?.fastMode) ??
    normalizeCopyFastMode(fallback?.selectedFastMode);
  const mcpPolicy =
    normalizeTeamMemberMcpPolicy(member.mcpPolicy) ??
    normalizeTeamMemberMcpPolicy(fallback?.mcpPolicy);

  return {
    name,
    role: resolveRole(member, fallback),
    workflow: normalizeCopyString(member.workflow) ?? normalizeCopyString(fallback?.workflow),
    isolation:
      member.isolation === 'worktree' || fallback?.isolation === 'worktree'
        ? 'worktree'
        : undefined,
    providerId,
    providerBackendId: member.providerBackendId ?? fallback?.providerBackendId,
    model: normalizeCopyString(member.model) ?? normalizeCopyString(fallback?.model),
    effort,
    fastMode,
    mcpPolicy,
  };
}

export function buildCopiedTeamMembers(
  primaryMembers: readonly CopyableTeamMember[] | undefined,
  fallbackMembers: readonly CopyableTeamMember[] = []
): TeamProvisioningMemberInput[] {
  const fallbackByName = new Map<string, CopyableTeamMember>();
  for (const member of fallbackMembers) {
    if (!isCopyableTeammate(member)) {
      continue;
    }
    const key = getMemberKey(member);
    if (key && !fallbackByName.has(key)) {
      fallbackByName.set(key, member);
    }
  }

  const copied: TeamProvisioningMemberInput[] = [];
  const seen = new Set<string>();

  for (const member of primaryMembers ?? []) {
    if (!isCopyableTeammate(member)) {
      continue;
    }
    const key = getMemberKey(member);
    if (!key || seen.has(key)) {
      continue;
    }
    const copiedMember = toCopiedMember(member, fallbackByName.get(key));
    if (copiedMember) {
      copied.push(copiedMember);
      seen.add(key);
    }
  }

  for (const [key, member] of fallbackByName) {
    if (seen.has(key)) {
      continue;
    }
    const copiedMember = toCopiedMember(member);
    if (copiedMember) {
      copied.push(copiedMember);
      seen.add(key);
    }
  }

  return copied;
}
