// ── Cross-Team Message Protocol ──────────────────────────────────────────────
// Single source of truth for the cross-team message prefix format.
// Used by: CrossTeamService (main), crossTeam.js (controller), ActivityItem (renderer), tests.

/** Prefix tag that wraps cross-team metadata in stored message text. */
export const CROSS_TEAM_PREFIX_TAG = 'Cross-team from';

export interface CrossTeamPrefixMeta {
  conversationId?: string;
  replyToConversationId?: string;
}

export interface ParsedCrossTeamPrefix extends CrossTeamPrefixMeta {
  from: string;
  chainDepth: number;
}

/**
 * Build the full prefix line:
 * `[Cross-team from team.member | depth:N | conversation:abc | replyTo:def]`
 */
export function formatCrossTeamPrefix(
  from: string,
  chainDepth: number,
  meta?: CrossTeamPrefixMeta
): string {
  const parts = [`${CROSS_TEAM_PREFIX_TAG} ${from}`, `depth:${chainDepth}`];
  if (meta?.conversationId) {
    parts.push(`conversation:${meta.conversationId}`);
  }
  if (meta?.replyToConversationId) {
    parts.push(`replyTo:${meta.replyToConversationId}`);
  }
  return `[${parts.join(' | ')}]`;
}

/** Format the full message text with prefix + body. */
export function formatCrossTeamText(
  from: string,
  chainDepth: number,
  text: string,
  meta?: CrossTeamPrefixMeta
): string {
  return `${formatCrossTeamPrefix(from, chainDepth, meta)}\n${text}`;
}

/**
 * Regex that matches the cross-team prefix line at the start of a message.
 * Compatible with legacy rows that only contain `depth`.
 */
export const CROSS_TEAM_PREFIX_RE =
  /^\[Cross-team from (?<from>[^\]|]+?) \| depth:(?<depth>\d+)(?: \| conversation:(?<conversationId>[^\]|]+))?(?: \| replyTo:(?<replyToConversationId>[^\]|]+))?\]\n?/;

/** Parse metadata from a cross-team prefix line. */
export function parseCrossTeamPrefix(text: string): ParsedCrossTeamPrefix | null {
  const match = text.match(CROSS_TEAM_PREFIX_RE);
  if (!match?.groups) return null;

  const from = match.groups.from?.trim();
  const chainDepth = Number.parseInt(match.groups.depth ?? '', 10);
  if (!from || !Number.isFinite(chainDepth)) return null;

  return {
    from,
    chainDepth,
    conversationId: match.groups.conversationId?.trim() || undefined,
    replyToConversationId: match.groups.replyToConversationId?.trim() || undefined,
  };
}

/** Strip the cross-team prefix from message text (for UI display). */
export function stripCrossTeamPrefix(text: string): string {
  return text.replace(CROSS_TEAM_PREFIX_RE, '');
}

// ── Source discriminators ────────────────────────────────────────────────────

/** Incoming cross-team message (written to target team's inbox). */
export const CROSS_TEAM_SOURCE = 'cross_team' as const;

/** Outgoing cross-team message copy (written to sender team's inbox). */
export const CROSS_TEAM_SENT_SOURCE = 'cross_team_sent' as const;
