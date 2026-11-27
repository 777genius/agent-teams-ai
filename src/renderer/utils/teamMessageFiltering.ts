import { omitVisualizationSourceForSearch } from '@features/chat-visualizations/contracts';
import {
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { shouldKeepIdleMessageInActivityWhenNoiseHidden } from '@renderer/utils/idleNotificationSemantics';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import {
  isMemberWorkSyncNudgeMessage,
  isReviewPickupEscalationMessage,
  isRuntimeRecoveryNudgeMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';
import { deduplicateVisibleRelayMessages } from '@shared/utils/teamMessageRelayDeduplication';

import type { InboxMessage } from '@shared/types';

export interface TeamMessagesFilter {
  from: Set<string>;
  to: Set<string>;
  showNoise: boolean;
}

interface CachedMessageFilterData {
  readonly messageKind: InboxMessage['messageKind'];
  readonly source: InboxMessage['source'];
  readonly from: InboxMessage['from'];
  readonly to: InboxMessage['to'];
  readonly messageId: InboxMessage['messageId'];
  readonly text: InboxMessage['text'];
  readonly trimmedFrom: string;
  readonly trimmedTo: string;
  readonly isTaskCommentNotification: boolean;
  readonly isTaskStallRemediation: boolean;
  readonly isMemberWorkSyncNudge: boolean;
  readonly isRuntimeRecoveryNudge: boolean;
  readonly isReviewPickupEscalation: boolean;
  readonly isInternalControlEnvelope: boolean;
  readonly isNoiseMessage: boolean;
  readonly keepIdleWhenNoiseHidden: boolean;
}

const messageFilterDataCache = new WeakMap<InboxMessage, CachedMessageFilterData>();

function getMessageFilterData(message: InboxMessage): CachedMessageFilterData {
  const cached = messageFilterDataCache.get(message);
  if (
    cached &&
    cached.messageKind === message.messageKind &&
    cached.source === message.source &&
    cached.from === message.from &&
    cached.to === message.to &&
    cached.messageId === message.messageId &&
    cached.text === message.text
  ) {
    return cached;
  }

  const text = typeof message.text === 'string' ? message.text : '';
  const isNoiseMessage = isInboxNoiseMessage(text);
  const next: CachedMessageFilterData = {
    messageKind: message.messageKind,
    source: message.source,
    from: message.from,
    to: message.to,
    messageId: message.messageId,
    text: message.text,
    trimmedFrom: typeof message.from === 'string' ? message.from.trim() : '',
    trimmedTo: typeof message.to === 'string' ? message.to.trim() : '',
    isTaskCommentNotification: message.messageKind === 'task_comment_notification',
    isTaskStallRemediation: isTaskStallRemediationMessage(message),
    isMemberWorkSyncNudge: isMemberWorkSyncNudgeMessage(message),
    isRuntimeRecoveryNudge: isRuntimeRecoveryNudgeMessage(message),
    isReviewPickupEscalation: isReviewPickupEscalationMessage(message),
    isInternalControlEnvelope: isTeamInternalControlMessageEnvelope(message),
    isNoiseMessage,
    keepIdleWhenNoiseHidden: isNoiseMessage && shouldKeepIdleMessageInActivityWhenNoiseHidden(text),
  };
  messageFilterDataCache.set(message, next);
  return next;
}

export function filterTeamMessages(
  messages: InboxMessage[],
  options: {
    includePassiveIdlePeerSummariesWhenNoiseHidden?: boolean;
    includeAutomationEvents?: boolean;
    includeMemberWorkSyncNudges?: boolean;
    leadNames?: Iterable<string>;
    timeWindow?: { start: number; end: number } | null;
    filter: TeamMessagesFilter;
    searchQuery: string;
  }
): InboxMessage[] {
  const {
    includePassiveIdlePeerSummariesWhenNoiseHidden = false,
    includeAutomationEvents = false,
    includeMemberWorkSyncNudges = false,
    leadNames: rawLeadNames,
    timeWindow,
    filter,
    searchQuery,
  } = options;
  const hasFrom = filter.from.size > 0;
  const hasTo = filter.to.size > 0;
  const q = searchQuery.trim().toLowerCase();
  const filteredMessages: InboxMessage[] = [];

  for (const message of messages) {
    const data = getMessageFilterData(message);
    if (
      data.isTaskCommentNotification ||
      (!includeAutomationEvents && data.isTaskStallRemediation) ||
      (!includeMemberWorkSyncNudges && data.isMemberWorkSyncNudge) ||
      data.isRuntimeRecoveryNudge ||
      data.isReviewPickupEscalation ||
      data.isInternalControlEnvelope
    ) {
      continue;
    }

    if (timeWindow) {
      const ts = new Date(message.timestamp).getTime();
      if (ts < timeWindow.start || ts >= timeWindow.end) {
        continue;
      }
    }

    if (
      !filter.showNoise &&
      data.isNoiseMessage &&
      (!includePassiveIdlePeerSummariesWhenNoiseHidden || !data.keepIdleWhenNoiseHidden)
    ) {
      continue;
    }

    if (hasFrom || hasTo) {
      const fromMatch = Boolean(data.trimmedFrom && filter.from.has(data.trimmedFrom));
      const toMatch = Boolean(data.trimmedTo && filter.to.has(data.trimmedTo));
      if ((hasFrom && !fromMatch) || (hasTo && !toMatch)) {
        continue;
      }
    }

    if (q) {
      const text = omitVisualizationSourceForSearch(
        getSanitizedInboxMessageText(message)
      ).toLowerCase();
      const summary = omitVisualizationSourceForSearch(
        getSanitizedInboxMessageSummary(message)
      ).toLowerCase();
      const from = (message.from ?? '').toLowerCase();
      const to = (message.to ?? '').toLowerCase();
      if (!text.includes(q) && !summary.includes(q) && !from.includes(q) && !to.includes(q)) {
        continue;
      }
    }

    filteredMessages.push(message);
  }

  return deduplicateVisibleRelayMessages(filteredMessages, rawLeadNames);
}
