/**
 * Lead agent type detection.
 *
 * CLI Claude Code assigns inconsistent agentType values to the lead member
 * across different versions/runs: "team-lead", "lead", "orchestrator",
 * or even "general-purpose". This module centralizes lead detection
 * so the rest of the codebase does not need to hard-code any single value.
 */

const LEAD_AGENT_TYPES = new Set(['team-lead', 'lead', 'orchestrator']);

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
  return LEAD_AGENT_TYPES.has(agentType);
}

/**
 * Returns true if the member is a team lead, checking both agentType
 * and the conventional "team-lead" name as a fallback.
 */
export function isLeadMember(member: { agentType?: unknown; name?: unknown }): boolean {
  const agentType = typeof member.agentType === 'string' ? member.agentType : null;
  if (isLeadAgentType(agentType)) return true;
  const name = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
  return name === 'team-lead';
}
