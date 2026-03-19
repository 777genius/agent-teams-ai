// ── Cross-Team Message Protocol ──────────────────────────────────────────────
// Single source of truth for the cross-team message prefix format.
// Used by: CrossTeamService (main), crossTeam.js (controller), ActivityItem (renderer), tests.

/** Canonical metadata tag written before stored cross-team message text. */
export const CROSS_TEAM_TAG_NAME = 'cross-team';
export const CROSS_TEAM_ATTR_FROM = 'from';
export const CROSS_TEAM_ATTR_DEPTH = 'depth';
export const CROSS_TEAM_ATTR_CONVERSATION_ID = 'conversationId';
export const CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID = 'replyToConversationId';
export const CROSS_TEAM_PREFIX_TAG = CROSS_TEAM_TAG_NAME;

export interface CrossTeamPrefixMeta {
  conversationId?: string;
  replyToConversationId?: string;
}

export interface ParsedCrossTeamPrefix extends CrossTeamPrefixMeta {
  from: string;
  chainDepth: number;
}

function escapeCrossTeamAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeCrossTeamAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseCrossTeamAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const matches = raw.matchAll(
    /* eslint-disable-next-line sonarjs/slow-regex -- attr values bounded by quotes, trusted prefix input */
    /([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g
  );
  for (const match of matches) {
    const key = match[1]?.trim();
    const value = match[2];
    if (!key || value == null) continue;
    attrs.set(key, unescapeCrossTeamAttribute(value));
  }
  return attrs;
}

/**
 * Build the full prefix line:
 * `<cross-team from="team.member" depth="0" conversationId="abc" replyToConversationId="def" />`
 */
export function formatCrossTeamPrefix(
  from: string,
  chainDepth: number,
  meta?: CrossTeamPrefixMeta
): string {
  const attrs = [
    `${CROSS_TEAM_ATTR_FROM}="${escapeCrossTeamAttribute(from)}"`,
    `${CROSS_TEAM_ATTR_DEPTH}="${String(chainDepth)}"`,
  ];
  if (meta?.conversationId) {
    attrs.push(
      `${CROSS_TEAM_ATTR_CONVERSATION_ID}="${escapeCrossTeamAttribute(meta.conversationId)}"`
    );
  }
  if (meta?.replyToConversationId) {
    attrs.push(
      `${CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID}="${escapeCrossTeamAttribute(meta.replyToConversationId)}"`
    );
  }
  return `<${CROSS_TEAM_TAG_NAME} ${attrs.join(' ')} />`;
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
 * Regex that matches the canonical cross-team metadata tag at the start of a message.
 */
export const CROSS_TEAM_PREFIX_RE = new RegExp(
  `^<${CROSS_TEAM_TAG_NAME}\\s+(?<attrs>[^>]*?)\\s*\\/>\\n?`
);

/** Parse metadata from a cross-team prefix line. */
export function parseCrossTeamPrefix(text: string): ParsedCrossTeamPrefix | null {
  const match = CROSS_TEAM_PREFIX_RE.exec(text);
  if (!match?.groups) return null;

  const attrs = parseCrossTeamAttributes(match.groups.attrs ?? '');
  const from = attrs.get(CROSS_TEAM_ATTR_FROM)?.trim();
  const chainDepth = Number.parseInt(attrs.get(CROSS_TEAM_ATTR_DEPTH) ?? '', 10);
  if (!from || !Number.isFinite(chainDepth)) return null;

  return {
    from,
    chainDepth,
    conversationId: attrs.get(CROSS_TEAM_ATTR_CONVERSATION_ID)?.trim() || undefined,
    replyToConversationId: attrs.get(CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID)?.trim() || undefined,
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
