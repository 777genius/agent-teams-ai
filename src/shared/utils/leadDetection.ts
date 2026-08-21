/**
 * Lead agent type detection.
 *
 * CLI Claude Code assigns inconsistent agentType values to the lead member
 * across different versions/runs: "team-lead", "lead", "orchestrator",
 * or even "general-purpose". This module centralizes lead detection
 * so the rest of the codebase does not need to hard-code any single value.
 */

const LEAD_AGENT_TYPES = new Set(['team-lead', 'lead', 'orchestrator']);
const LEAD_MEMBER_NAMES = new Set(['team-lead', 'lead']);

/** Role labels reserved for the runtime-owned team lead identity. */
export const RESERVED_LEAD_ROLES: ReadonlySet<string> = new Set([
  'lead',
  'team lead',
  'team-lead',
  'orchestrator',
]);

export function normalizeTeamMemberRole(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isReservedLeadRole(role: string): boolean {
  return RESERVED_LEAD_ROLES.has(normalizeTeamMemberRole(role));
}

/**
 * Returns true if the given agentType string identifies a team lead.
 * Handles all known CLI variants: "team-lead", "lead", "orchestrator".
 *
 * Does NOT match "general-purpose" — that value is ambiguous and used
 * for regular teammates too. Lead detection for "general-purpose" agents
 * must rely on name-based checks (see {@link isLeadMember}).
 */
export function isLeadAgentType(agentType: string | undefined | null): boolean {
  if (!agentType) return false;
  return LEAD_AGENT_TYPES.has(agentType.trim().toLowerCase());
}

export function isLeadMemberName(name: string | undefined | null): boolean {
  if (!name) return false;
  return LEAD_MEMBER_NAMES.has(name.trim().toLowerCase());
}

/**
 * Returns true if the member is a team lead, checking both agentType
 * and the conventional "team-lead" name as a fallback.
 */
export function isLeadMember(member: {
  agentType?: unknown;
  name?: unknown;
  role?: unknown;
}): boolean {
  const agentType = typeof member.agentType === 'string' ? member.agentType : null;
  if (isLeadAgentType(agentType)) return true;
  const name = typeof member.name === 'string' ? member.name : null;
  if (isLeadMemberName(name)) return true;
  if (agentType?.trim()) return false;
  const role = typeof member.role === 'string' ? normalizeTeamMemberRole(member.role) : '';
  return role === 'team lead';
}
