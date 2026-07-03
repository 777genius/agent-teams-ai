import { CROSS_TEAM_SOURCE, parseCrossTeamPrefix } from '@shared/constants/crossTeam';

import type { InboxMessage } from '@shared/types';

export interface CrossTeamRecipient {
  teamName: string;
  memberName: string;
}

export interface CrossTeamReplyHint {
  toTeam?: unknown;
  conversationId?: unknown;
}

export interface CrossTeamDeliveredLeadBlock {
  teammateId: string;
  content: string;
  toTeam: string;
  conversationId: string;
}

export interface CrossTeamLeadInboxMatch extends CrossTeamDeliveredLeadBlock {
  messageId: string;
  wasRead: boolean;
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

export function registerPendingCrossTeamReplyExpectation(
  pendingReplies: Map<string, Map<string, number>>,
  teamName: string,
  otherTeam: string,
  conversationId: string,
  now: number
): void {
  const normalizedTeam = teamName.trim();
  const normalizedOtherTeam = otherTeam.trim();
  const normalizedConversationId = conversationId.trim();
  if (!normalizedTeam || !normalizedOtherTeam || !normalizedConversationId) return;

  const teamMap = pendingReplies.get(normalizedTeam) ?? new Map<string, number>();
  teamMap.set(buildCrossTeamConversationKey(normalizedOtherTeam, normalizedConversationId), now);
  pendingReplies.set(normalizedTeam, teamMap);
}

export function clearPendingCrossTeamReplyExpectation(
  pendingReplies: Map<string, Map<string, number>>,
  teamName: string,
  otherTeam: string,
  conversationId: string
): void {
  const normalizedTeam = teamName.trim();
  const teamMap = pendingReplies.get(normalizedTeam);
  if (!teamMap) return;
  teamMap.delete(buildCrossTeamConversationKey(otherTeam, conversationId));
  if (teamMap.size === 0) {
    pendingReplies.delete(normalizedTeam);
  }
}

export function getPendingCrossTeamReplyExpectationKeys(
  pendingReplies: Map<string, Map<string, number>>,
  teamName: string,
  now: number,
  ttlMs: number
): Set<string> {
  const normalizedTeam = teamName.trim();
  const teamMap = pendingReplies.get(normalizedTeam);
  if (!teamMap) return new Set<string>();

  pruneExpiredMapEntries(teamMap, now - ttlMs);
  if (teamMap.size === 0) {
    pendingReplies.delete(normalizedTeam);
    return new Set<string>();
  }
  return new Set(teamMap.keys());
}

export function rememberRecentCrossTeamLeadDeliveryMessageIds(
  recentMessageIds: Map<string, Map<string, number>>,
  teamName: string,
  messageIds: readonly string[],
  now: number,
  ttlMs: number
): void {
  const normalizedIds = messageIds.map((id) => id.trim()).filter((id) => id.length > 0);
  if (normalizedIds.length === 0) return;

  const teamKey = teamName.trim();
  const current = recentMessageIds.get(teamKey) ?? new Map<string, number>();
  pruneExpiredMapEntries(current, now - ttlMs);
  for (const messageId of normalizedIds) {
    current.set(messageId, now);
  }
  if (current.size > 0) {
    recentMessageIds.set(teamKey, current);
  }
}

export function wasRecentlyDeliveredToLead(
  recentMessageIds: Map<string, Map<string, number>>,
  teamName: string,
  messageId: string,
  now: number,
  ttlMs: number
): boolean {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) return false;

  const teamKey = teamName.trim();
  const current = recentMessageIds.get(teamKey);
  if (!current) return false;

  pruneExpiredMapEntries(current, now - ttlMs);
  if (current.size === 0) {
    recentMessageIds.delete(teamKey);
    return false;
  }
  return current.has(normalizedMessageId);
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

function hasStableInboxMessageId(
  message: InboxMessage
): message is InboxMessage & { messageId: string } {
  return typeof message.messageId === 'string' && message.messageId.trim().length > 0;
}

function pruneExpiredMapEntries(map: Map<string, number>, cutoff: number): void {
  for (const [key, createdAt] of map.entries()) {
    if (createdAt < cutoff) {
      map.delete(key);
    }
  }
}

function getCrossTeamMessageConversationId(message: InboxMessage): string | undefined {
  return (
    message.replyToConversationId?.trim() ??
    message.conversationId?.trim() ??
    parseCrossTeamPrefix(message.text)?.conversationId
  );
}

export function matchCrossTeamLeadInboxMessages(
  leadInboxMessages: readonly InboxMessage[],
  deliveredBlocks: readonly CrossTeamDeliveredLeadBlock[]
): CrossTeamLeadInboxMatch[] {
  const usedMessageIds = new Set<string>();
  const matches: CrossTeamLeadInboxMatch[] = [];

  for (const block of deliveredBlocks) {
    const matchesBlock = (message: InboxMessage, requireExactText: boolean): boolean => {
      if (message.source !== CROSS_TEAM_SOURCE) return false;
      if (!hasStableInboxMessageId(message)) return false;
      if (usedMessageIds.has(message.messageId)) return false;
      if (message.from.trim() !== block.teammateId.trim()) return false;
      if (getCrossTeamMessageConversationId(message) !== block.conversationId) return false;
      return !requireExactText || message.text.trim() === block.content.trim();
    };

    const matched =
      leadInboxMessages.find((message) => matchesBlock(message, true)) ??
      leadInboxMessages.find((message) => matchesBlock(message, false));
    if (!matched || !hasStableInboxMessageId(matched)) continue;

    usedMessageIds.add(matched.messageId);
    matches.push({
      teammateId: block.teammateId,
      content: block.content,
      toTeam: block.toTeam,
      conversationId: block.conversationId,
      messageId: matched.messageId,
      wasRead: matched.read === true,
    });
  }

  return matches;
}
