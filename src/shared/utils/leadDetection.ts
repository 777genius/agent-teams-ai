/**
 * Lead agent type detection.
 *
 * CLI Claude Code assigns inconsistent agentType values to the lead member
 * across different versions/runs: "team-lead", "lead", "orchestrator",
 * or even "general-purpose". This module centralizes lead detection
 * so the rest of the codebase does not need to hard-code any single value.
 */

const LEAD_AGENT_TYPES = new Set(['team-lead', 'lead', 'orchestrator']);

const LEAD_NAME_ALIASES = new Set(['lead', 'team-lead', 'teamlead', 'team-leader', 'orchestrator']);

/** Conversation routing aliases. `orchestrator` is a CLI identity, not a chat participant. */
const CONVERSATION_LEAD_NAME_ALIASES = new Set(['lead', 'team-lead', 'teamlead', 'team-leader']);

/** Normalize a participant name for lead-alias comparison. */
export function normalizeLeadNameAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function matchesLeadAliasSet(
  value: string | undefined | null,
  aliases: ReadonlySet<string>
): boolean {
  if (!value) return false;
  const normalized = normalizeLeadNameAlias(value);
  return aliases.has(normalized) || normalized.replace(/-/g, '') === 'teamlead';
}

/** True when the name is a known lead identity alias (not a roster member check). */
export function isLeadNameAlias(value: string | undefined | null): boolean {
  return matchesLeadAliasSet(value, LEAD_NAME_ALIASES);
}

/** True when the name is a conversation lead alias. Does not include `orchestrator`. */
export function isConversationLeadAlias(value: string | undefined | null): boolean {
  return matchesLeadAliasSet(value, CONVERSATION_LEAD_NAME_ALIASES);
}

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

/**
 * Returns true if the member is a team lead, checking both agentType
 * and the conventional runtime-owned name.
 */
export function isLeadMember(member: {
  agentType?: unknown;
  name?: unknown;
  role?: unknown;
}): boolean {
  const agentType = typeof member.agentType === 'string' ? member.agentType : null;
  if (isLeadAgentType(agentType)) return true;
  const name = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
  return name === 'team-lead';
}

/** Inbox speaker identity for lead process/session thoughts. */
export const LEAD_THOUGHT_SPEAKER_NAME = 'team-lead';

/**
 * True for lead process/session thoughts that are not addressed to a recipient.
 * `from` is not part of this check: live overlays may stamp a teammate name.
 */
export function isLeadThoughtSourceMessage(message: { source?: unknown; to?: unknown }): boolean {
  if (typeof message.to === 'string' && message.to.trim().length > 0) {
    return false;
  }
  return message.source === 'lead_session' || message.source === 'lead_process';
}

/**
 * Runtime speaker / inbox identity for the orchestrator process.
 * Reserved teammate roles such as "Team Lead" must not win this lookup.
 */
export function resolveRuntimeLeadName(
  members: readonly { name?: unknown; role?: unknown; agentType?: unknown }[] | null | undefined
): string {
  const list = Array.isArray(members) ? members : [];
  for (const member of list) {
    if (!isLeadMember(member)) continue;
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    if (name) return name;
  }
  return 'team-lead';
}

/** Canonical settings identity also recognizes legacy role-only leads. */
export function isCanonicalSettingsLeadMember(member: {
  name?: unknown;
  agentType?: unknown;
  role?: unknown;
}): boolean {
  if (isLeadMember(member)) return true;
  if (typeof member.agentType === 'string' && member.agentType.trim()) return false;
  const name = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
  const role = typeof member.role === 'string' ? normalizeTeamMemberRole(member.role) : '';
  return isReservedLeadRole(role) && (role !== 'lead' || name === 'lead');
}
