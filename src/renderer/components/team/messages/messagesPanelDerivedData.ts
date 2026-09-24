import {
  type ConversationScope,
  type ConversationSurface,
  createDirectScope,
  normalizeConversationParticipant,
  TEAM_FEED_SCOPE,
} from '@features/team-direct-chats/renderer';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { shouldExcludeInboxTextFromReplyCandidates } from '@shared/utils/idleNotificationSemantics';
import {
  isMemberWorkSyncNudgeMessage,
  isReviewPickupEscalationMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';

import { getThoughtGroupKey, groupTimelineItems } from '../activity/LeadThoughtsGroup';

import { conversationScopeKey, filterScopedMessages } from './messagesPanelConversations';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';
import type { MessagesFilterState } from './MessagesFilterPopover';
import type { ComposerDraftAddress, ComposerWorkingSummary } from '@renderer/types/composerDraft';
import type { InboxMessage } from '@shared/types';

export function localDraftsByConversationScope(summaries: readonly ComposerWorkingSummary[]) {
  const drafts = new Map<
    string,
    {
      preview: string;
      updatedAt: number;
      attachmentCount: number;
      chipCount: number;
      editorKind: 'plain' | 'revision';
    }
  >();
  for (const summary of summaries) {
    const target = summary.address.target;
    if (target.kind === 'cross-team') continue;
    drafts.set(
      conversationScopeKey(
        target.kind === 'team-feed' ? TEAM_FEED_SCOPE : createDirectScope(target.participant)
      ),
      {
        preview: summary.preview,
        updatedAt: summary.updatedAt,
        attachmentCount: summary.attachmentCount,
        chipCount: summary.chipCount,
        editorKind: summary.editorKind,
      }
    );
  }
  return drafts;
}

export function memberConversationParticipants(members: readonly { name: string }[]): Set<string> {
  return new Set(members.map((member) => normalizeConversationParticipant(member.name)));
}

export function canOpenConversationAddress(
  address: ComposerDraftAddress,
  participants: ReadonlySet<string>
): boolean {
  return (
    address.target.kind === 'team-feed' ||
    (address.target.kind === 'direct' && participants.has(address.target.participant))
  );
}

export function replyCandidates(messages: readonly InboxMessage[]): InboxMessage[] {
  return messages.filter(
    (message) =>
      message.messageKind !== 'task_comment_notification' &&
      !isTaskStallRemediationMessage(message) &&
      !isMemberWorkSyncNudgeMessage(message) &&
      !isReviewPickupEscalationMessage(message) &&
      !shouldExcludeInboxTextFromReplyCandidates(
        typeof message.text === 'string' ? message.text : ''
      )
  );
}

export function resolveExpandedTimelineItem(
  key: string | null,
  messages: InboxMessage[]
): TimelineItem | null {
  if (!key) return null;
  if (!key.startsWith('thoughts-')) {
    const message = messages.find((item) => toMessageKey(item) === key);
    return message ? { type: 'message', message } : null;
  }
  return (
    groupTimelineItems(messages).find(
      (item) => item.type === 'lead-thoughts' && getThoughtGroupKey(item.group) === key
    ) ?? null
  );
}

export function conversationIdentity(args: {
  teamName: string;
  scopeKey: string;
  threadOpenedAt: number;
  searchQuery: string;
  filter: MessagesFilterState;
  timeWindow: { start: number; end: number } | null;
}): string {
  return JSON.stringify([
    args.teamName,
    args.scopeKey,
    args.threadOpenedAt,
    args.searchQuery.trim().toLowerCase(),
    [...args.filter.from].sort(),
    [...args.filter.to].sort(),
    args.filter.showNoise,
    args.timeWindow,
  ]);
}

export function activityMessages(args: {
  messages: InboxMessage[];
  leadNames: readonly string[];
  timeWindow: { start: number; end: number } | null;
  filter: MessagesFilterState;
  searchQuery: string;
  renderSurface: ConversationSurface;
  scope: ConversationScope;
}): InboxMessage[] {
  const unscoped = filterTeamMessages(args.messages, {
    includeAutomationEvents: true,
    leadNames: args.leadNames,
    timeWindow: args.timeWindow,
    filter: args.filter,
    searchQuery: args.searchQuery,
  });
  return args.renderSurface === 'thread'
    ? filterScopedMessages(unscoped, args.scope, args.leadNames)
    : unscoped;
}

export function canonicalTeamMessages(
  messages: InboxMessage[],
  leadNames: readonly string[]
): InboxMessage[] {
  return filterTeamMessages(messages, {
    leadNames,
    filter: { from: new Set(), to: new Set(), showNoise: false },
    searchQuery: '',
  });
}

export function visibleTeamMessages(args: {
  messages: InboxMessage[];
  leadNames: readonly string[];
  timeWindow: { start: number; end: number } | null;
  filter: MessagesFilterState;
  searchQuery: string;
}): InboxMessage[] {
  return filterTeamMessages(args.messages, {
    leadNames: args.leadNames,
    timeWindow: args.timeWindow,
    filter: args.filter,
    searchQuery: args.searchQuery,
  });
}
