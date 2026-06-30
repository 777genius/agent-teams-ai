export interface CrossTeamRecipient {
  teamName: string;
  memberName: string;
}

export interface CrossTeamReplyHint {
  toTeam?: unknown;
  conversationId?: unknown;
}

const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

const CROSS_TEAM_TOOL_RECIPIENT_NAMES = new Set([
  'cross_team_send',
  'cross_team_list_targets',
  'cross_team_get_outbox',
]);

const CROSS_TEAM_PSEUDO_PREFIXES = [
  'cross_team::',
  'cross_team--',
  'cross-team:',
  'cross-team-',
  'cross_team:',
  'cross_team-',
] as const;

export function extractCrossTeamPseudoTargetTeam(value: string): string | null {
  const trimmed = value.trim();
  for (const prefix of CROSS_TEAM_PSEUDO_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const teamName = trimmed.slice(prefix.length).trim();
    if (TEAM_NAME_PATTERN.test(teamName)) {
      return teamName;
    }
  }
  return null;
}

export function parseCrossTeamRecipient(
  currentTeam: string,
  recipient: string,
  localRecipientNames: ReadonlySet<string>
): CrossTeamRecipient | null {
  const trimmed = recipient.trim();
  if (localRecipientNames.has(trimmed)) return null;
  const pseudoTeamName = extractCrossTeamPseudoTargetTeam(trimmed);
  if (pseudoTeamName) {
    if (pseudoTeamName === currentTeam) {
      return null;
    }
    return { teamName: pseudoTeamName, memberName: 'team-lead' };
  }
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  const teamName = trimmed.slice(0, dot).trim();
  const memberName = trimmed.slice(dot + 1).trim();
  if (!TEAM_NAME_PATTERN.test(teamName) || !memberName || teamName === currentTeam) {
    return null;
  }
  return { teamName, memberName };
}

export function isCrossTeamToolRecipientName(name: string): boolean {
  return CROSS_TEAM_TOOL_RECIPIENT_NAMES.has(name.trim());
}

export function isCrossTeamPseudoRecipientName(name: string): boolean {
  return extractCrossTeamPseudoTargetTeam(name) !== null;
}

export function resolveSingleActiveCrossTeamReplyHint(
  hints: readonly CrossTeamReplyHint[] | null | undefined
): { toTeam: string; conversationId: string } | null {
  const uniqueHints = new Map<string, { toTeam: string; conversationId: string }>();
  for (const hint of hints ?? []) {
    const toTeam = typeof hint?.toTeam === 'string' ? hint.toTeam.trim() : '';
    const conversationId =
      typeof hint?.conversationId === 'string' ? hint.conversationId.trim() : '';
    if (!toTeam || !conversationId) continue;
    uniqueHints.set(`${toTeam}\0${conversationId}`, { toTeam, conversationId });
  }
  return uniqueHints.size === 1 ? (Array.from(uniqueHints.values())[0] ?? null) : null;
}

export function looksLikeQualifiedExternalRecipientName(name: string): boolean {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return false;
  const teamName = trimmed.slice(0, dot).trim();
  const memberName = trimmed.slice(dot + 1).trim();
  return TEAM_NAME_PATTERN.test(teamName) && memberName.length > 0;
}

export function buildCrossTeamConversationKey(otherTeam: string, conversationId: string): string {
  return `${otherTeam.trim()}\0${conversationId.trim()}`;
}

export function parseCrossTeamTargetTeam(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('cross-team:')) {
    const teamName = trimmed.slice('cross-team:'.length).trim();
    return TEAM_NAME_PATTERN.test(teamName) ? teamName : null;
  }
  const dot = trimmed.indexOf('.');
  if (dot <= 0) return null;
  const teamName = trimmed.slice(0, dot).trim();
  return TEAM_NAME_PATTERN.test(teamName) ? teamName : null;
}

export function getCrossTeamSourceTeam(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0) return null;
  const teamName = trimmed.slice(0, dot).trim();
  return TEAM_NAME_PATTERN.test(teamName) ? teamName : null;
}
