import {
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { shouldKeepIdleMessageInActivityWhenNoiseHidden } from '@renderer/utils/idleNotificationSemantics';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import {
  isMemberWorkSyncNudgeMessage,
  isReviewPickupEscalationMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';

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
  readonly trimmedMessageId: string;
  readonly trimmedFrom: string;
  readonly trimmedTo: string;
  readonly normalizedFrom: string;
  readonly normalizedTo: string;
  readonly normalizedText: string;
  readonly isTaskCommentNotification: boolean;
  readonly isTaskStallRemediation: boolean;
  readonly isMemberWorkSyncNudge: boolean;
  readonly isReviewPickupEscalation: boolean;
  readonly isInternalControlEnvelope: boolean;
  readonly isNoiseMessage: boolean;
  readonly keepIdleWhenNoiseHidden: boolean;
}

const messageFilterDataCache = new WeakMap<InboxMessage, CachedMessageFilterData>();

function normalizeMessageText(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

function normalizeParticipant(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeLeadNames(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const name = normalizeParticipant(value);
    if (name) {
      normalized.add(name);
    }
  }
  return normalized;
}

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
    trimmedMessageId: typeof message.messageId === 'string' ? message.messageId.trim() : '',
    trimmedFrom: typeof message.from === 'string' ? message.from.trim() : '',
    trimmedTo: typeof message.to === 'string' ? message.to.trim() : '',
    normalizedFrom: normalizeParticipant(message.from),
    normalizedTo: normalizeParticipant(message.to),
    normalizedText: normalizeMessageText(message.text),
    isTaskCommentNotification: message.messageKind === 'task_comment_notification',
    isTaskStallRemediation: isTaskStallRemediationMessage(message),
    isMemberWorkSyncNudge: isMemberWorkSyncNudgeMessage(message),
    isReviewPickupEscalation: isReviewPickupEscalationMessage(message),
    isInternalControlEnvelope: isTeamInternalControlMessageEnvelope(message),
    isNoiseMessage,
    keepIdleWhenNoiseHidden: isNoiseMessage && shouldKeepIdleMessageInActivityWhenNoiseHidden(text),
  };
  messageFilterDataCache.set(message, next);
  return next;
}

function isLeadAlias(value: string | undefined): boolean {
  const normalized = normalizeParticipant(value).replace(/[\s_]+/g, '-');
  return (
    normalized === 'lead' ||
    normalized === 'team-lead' ||
    normalized === 'teamlead' ||
    normalized === 'team-leader'
  );
}

function isLeadParticipant(value: string | undefined, leadNames: Set<string>): boolean {
  const normalized = normalizeParticipant(value);
  return isLeadAlias(value) || (normalized.length > 0 && leadNames.has(normalized));
}

function isRelayDuplicateOfVisibleMessage(
  message: InboxMessage,
  original: InboxMessage | undefined,
  leadNames: Set<string>
): boolean {
  if (!original) {
    return false;
  }

  const messageData = getMessageFilterData(message);
  if (messageData.isNoiseMessage) {
    return true;
  }
  const originalData = getMessageFilterData(original);

  const isInternalLeadRelayDelivery =
    (message.source === 'runtime_delivery' || message.source === 'lead_process') &&
    original.source === 'user_sent' &&
    originalData.normalizedFrom === 'user' &&
    isLeadParticipant(original.to, leadNames) &&
    isLeadParticipant(message.from, leadNames) &&
    messageData.normalizedTo !== 'user';

  if (isInternalLeadRelayDelivery) {
    return true;
  }

  const sameDirection =
    messageData.normalizedFrom === originalData.normalizedFrom &&
    messageData.normalizedTo === originalData.normalizedTo;

  if (!sameDirection) {
    return false;
  }

  if (message.source === 'lead_process') {
    return true;
  }

  return messageData.normalizedText === originalData.normalizedText;
}

function getRuntimeDeliveryRelayDuplicateKey(
  message: InboxMessage,
  relayOfMessageId: string
): string | null {
  if (message.source !== 'runtime_delivery') {
    return null;
  }
  const data = getMessageFilterData(message);
  const from = data.normalizedFrom;
  const to = data.normalizedTo;
  const text = data.normalizedText;
  if (!from || !to || !text) {
    return null;
  }
  return [relayOfMessageId, from, to, text].join('\0');
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
  const leadNames = normalizeLeadNames(rawLeadNames);
  const hasFrom = filter.from.size > 0;
  const hasTo = filter.to.size > 0;
  const q = searchQuery.trim().toLowerCase();
  const visibleMessagesById = new Map<string, InboxMessage>();
  const filteredMessages: InboxMessage[] = [];

  for (const message of messages) {
    const data = getMessageFilterData(message);
    if (
      data.isTaskCommentNotification ||
      (!includeAutomationEvents && data.isTaskStallRemediation) ||
      (!includeMemberWorkSyncNudges && data.isMemberWorkSyncNudge) ||
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
      const text = getSanitizedInboxMessageText(message).toLowerCase();
      const summary = getSanitizedInboxMessageSummary(message).toLowerCase();
      const from = (message.from ?? '').toLowerCase();
      const to = (message.to ?? '').toLowerCase();
      if (!text.includes(q) && !summary.includes(q) && !from.includes(q) && !to.includes(q)) {
        continue;
      }
    }

    filteredMessages.push(message);
    if (data.trimmedMessageId) {
      visibleMessagesById.set(data.trimmedMessageId, message);
    }
  }

  const seenRuntimeDeliveryRelayDuplicates = new Set<string>();

  return filteredMessages.filter((m) => {
    const relayOfMessageId =
      typeof m.relayOfMessageId === 'string' ? m.relayOfMessageId.trim() : '';
    if (!relayOfMessageId) {
      return true;
    }
    const data = getMessageFilterData(m);
    if (relayOfMessageId === data.trimmedMessageId) {
      return true;
    }
    const runtimeDuplicateKey = getRuntimeDeliveryRelayDuplicateKey(m, relayOfMessageId);
    if (runtimeDuplicateKey) {
      if (seenRuntimeDeliveryRelayDuplicates.has(runtimeDuplicateKey)) {
        return false;
      }
      seenRuntimeDeliveryRelayDuplicates.add(runtimeDuplicateKey);
    }
    return !isRelayDuplicateOfVisibleMessage(
      m,
      visibleMessagesById.get(relayOfMessageId),
      leadNames
    );
  });
}
