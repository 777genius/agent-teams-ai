import { isLeadMember } from '@shared/utils/leadDetection';

import type { TeamConfig, TeamMember } from '@shared/types';

export interface CrossTeamRecipientIdentitySources {
  config: TeamConfig | null | undefined;
  metaMembers?: readonly TeamMember[];
}

export interface CrossTeamRecipientIdentity {
  memberName: string;
  leadName: string | null;
  isLead: boolean;
}

function normalizeMemberKey(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : '';
}

function uniqueCanonicalNames(values: readonly unknown[]): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const name = typeof value === 'string' ? value.trim() : '';
    const key = normalizeMemberKey(name);
    if (key && !names.has(key)) {
      names.set(key, name);
    }
  }
  return [...names.values()];
}

interface ReconciledRecipientMember {
  name: string;
  isLead: boolean;
}

function reconcileRecipientMembers(
  input: CrossTeamRecipientIdentitySources
): ReconciledRecipientMember[] {
  const configMembers = input.config?.members ?? [];
  const metaMembers = input.metaMembers ?? [];
  const tombstonedMemberKeys = new Set(
    [...configMembers, ...metaMembers]
      .filter((member) => member.removedAt != null)
      .map((member) => normalizeMemberKey(member.name))
      .filter(Boolean)
  );
  const members = new Map<string, ReconciledRecipientMember>();

  const addActiveMember = (member: TeamMember): void => {
    const name = member.name?.trim();
    const key = normalizeMemberKey(name);
    if (!name || !key || member.removedAt != null || tombstonedMemberKeys.has(key)) {
      return;
    }
    const existing = members.get(key);
    if (existing) {
      existing.isLead ||= isLeadMember(member);
      return;
    }
    members.set(key, { name, isLead: isLeadMember(member) });
  };

  for (const member of configMembers) {
    addActiveMember(member);
  }
  for (const member of metaMembers) {
    addActiveMember(member);
  }

  return [...members.values()];
}

function resolveAuthoritativeLeadName(
  members: readonly ReconciledRecipientMember[]
): string | null {
  const activeLeads = uniqueCanonicalNames(
    members.filter((member) => member.isLead).map((member) => member.name)
  );
  if (activeLeads.length > 1) {
    throw new Error(`Ambiguous active team lead identity: ${activeLeads.join(', ')}`);
  }
  return activeLeads[0] ?? members[0]?.name ?? null;
}

function resolveDirectMemberName(
  members: readonly ReconciledRecipientMember[],
  requestedKey: string
): string | null {
  const canonicalMatches = uniqueCanonicalNames(
    members
      .filter((member) => normalizeMemberKey(member.name) === requestedKey)
      .map((member) => member.name)
  );
  if (canonicalMatches.length > 1) {
    throw new Error(`Ambiguous cross-team recipient identity: ${canonicalMatches.join(', ')}`);
  }
  return canonicalMatches[0] ?? null;
}

/**
 * Resolves both the canonical recipient and the lead identity from the same
 * directory evidence used by cross-team send and runtime-delivery journaling.
 */
export function resolveCrossTeamRecipientIdentity(input: {
  sources: CrossTeamRecipientIdentitySources;
  rawToMember: string | undefined;
}): CrossTeamRecipientIdentity {
  const requestedKey = normalizeMemberKey(input.rawToMember);
  const members = reconcileRecipientMembers(input.sources);
  const leadName = resolveAuthoritativeLeadName(members);
  const directMemberName = requestedKey ? resolveDirectMemberName(members, requestedKey) : null;

  if (directMemberName) {
    return {
      memberName: directMemberName,
      leadName,
      isLead: normalizeMemberKey(directMemberName) === normalizeMemberKey(leadName),
    };
  }

  const leadKey = normalizeMemberKey(leadName);
  const requestsLead =
    !requestedKey ||
    requestedKey === 'lead' ||
    requestedKey === 'team-lead' ||
    requestedKey === leadKey;
  if (requestsLead) {
    if (!leadName) {
      throw new Error('Cross-team target lead identity is unavailable');
    }
    return { memberName: leadName, leadName, isLead: true };
  }

  throw new Error(
    `Unknown toMember: ${input.rawToMember}. Use an authoritative target team member name.`
  );
}
