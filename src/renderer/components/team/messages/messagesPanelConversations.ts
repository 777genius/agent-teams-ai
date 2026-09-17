import {
  belongsToConversation,
  type ConversationMessageKeyFn,
  type ConversationScope,
  conversationScopeKey,
  type ConversationSurface,
  countUniqueUnread,
  emptyUnreadCounts,
  isLeadConversationParticipant,
  isUserUnreadMessage,
  normalizeConversationParticipant,
} from '@features/team-direct-chats/renderer';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

export function leadNamesFromMembers(members: readonly ResolvedTeamMember[]): string[] {
  return members.filter(isLeadMember).map((member) => member.name);
}

export function resolveConversationParticipantName(
  members: readonly ResolvedTeamMember[],
  participant: string | undefined
): string | undefined {
  if (!participant) {
    return undefined;
  }
  const normalized = normalizeConversationParticipant(participant);
  const exact = members.find(
    (member) => normalizeConversationParticipant(member.name) === normalized
  );
  if (exact) {
    return exact.name;
  }
  const leadNames = leadNamesFromMembers(members);
  if (isLeadConversationParticipant(participant, leadNames)) {
    return members.find((member) => isLeadMember(member))?.name ?? participant;
  }
  return participant;
}

export function conversationDisplayTitle(
  renderSurface: ConversationSurface,
  scope: ConversationScope,
  labels: { list: string; teamFeed: string },
  members: readonly ResolvedTeamMember[] = []
): string {
  if (renderSurface !== 'thread') {
    return labels.list;
  }
  if (scope.kind !== 'direct') {
    return labels.teamFeed;
  }
  const resolved =
    resolveConversationParticipantName(members, scope.participant) ?? scope.participant;
  return displayMemberName(resolved);
}

export function filterScopedMessages(
  messages: readonly InboxMessage[],
  scope: ConversationScope,
  leadNames: Iterable<string>
): InboxMessage[] {
  if (scope.kind === 'team-feed') {
    return [...messages];
  }
  return messages.filter((message) => belongsToConversation(message, scope, leadNames));
}

export function scopedUnreadKeys(
  messages: readonly InboxMessage[],
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn
): string[] {
  return messages
    .filter((message) => isUserUnreadMessage(message, readSet, toKey))
    .map((message) => toKey(message));
}

export function scopedUnreadCounts(
  messages: readonly InboxMessage[],
  scope: ConversationScope,
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn,
  leadNames: Iterable<string>
): { unreadCount: number; attentionCount: number } {
  if (scope.kind === 'team-feed') {
    return countUniqueUnread(messages, readSet, toKey);
  }
  const scoped = filterScopedMessages(messages, scope, leadNames);
  return countUniqueUnread(scoped, readSet, toKey);
}

export function collectThreadUnreadSnapshotKeys(args: {
  messages: readonly InboxMessage[];
  readSetAtOpen: ReadonlySet<string>;
  toKey: ConversationMessageKeyFn;
  openedAt: number;
  existing?: ReadonlySet<string>;
}): Set<string> {
  const next = new Set(args.existing);
  for (const message of args.messages) {
    const timestamp = Date.parse(message.timestamp);
    if (args.openedAt > 0 && Number.isFinite(timestamp) && timestamp > args.openedAt) {
      continue;
    }
    if (!isUserUnreadMessage(message, args.readSetAtOpen, args.toKey)) {
      continue;
    }
    next.add(args.toKey(message));
  }
  return next;
}

export { conversationScopeKey, emptyUnreadCounts };
