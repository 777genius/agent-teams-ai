import { randomUUID } from 'node:crypto';

import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  isTeamInternalControlMessageText,
  stripExactInternalControlEchoPrefix,
} from '@shared/utils/teamInternalControlMessages';

import { shouldSuppressUnverifiedLeadRelayStateLine } from './TeamProvisioningInboxRelayPolicy';

import type { InboxMessage } from '@shared/types/team';

export type LeadRelayReplyProjection =
  | {
      kind: 'suppressed';
      reason:
        | 'empty'
        | 'internal_control'
        | 'visible_duplicate'
        | 'unverified_state'
        | 'ambiguous_group_scope';
    }
  | {
      kind: 'live_activity';
      text: string;
      messageId: string;
      timestamp: string;
    }
  | {
      kind: 'group_message';
      message: { groupChatId: string; relayOfMessageId: string; messageId: string; text: string };
    }
  | {
      kind: 'user_message';
      message: InboxMessage;
    };

export function projectLeadRelayReply(input: {
  replyText: string | null;
  relayPrompt: string;
  replyVisibility: 'user' | 'internal_activity';
  capturedVisibleSendMessage: boolean;
  capturedUserVisibleSendMessage: boolean;
  leadName: string;
  runId: string;
  nowIso: string;
  nowMs: number;
  originatingBatch?: readonly InboxMessage[];
}): LeadRelayReplyProjection {
  const cleanReply = input.replyText
    ? stripExactInternalControlEchoPrefix(
        stripAgentBlocks(input.replyText),
        stripAgentBlocks(input.relayPrompt)
      )
    : null;
  if (!cleanReply) {
    return { kind: 'suppressed', reason: 'empty' };
  }
  if (isTeamInternalControlMessageText(cleanReply)) {
    return { kind: 'suppressed', reason: 'internal_control' };
  }
  if (
    (input.replyVisibility === 'internal_activity' && input.capturedVisibleSendMessage) ||
    (input.replyVisibility === 'user' && input.capturedUserVisibleSendMessage)
  ) {
    return { kind: 'suppressed', reason: 'visible_duplicate' };
  }
  if (
    input.replyVisibility === 'internal_activity' &&
    shouldSuppressUnverifiedLeadRelayStateLine(cleanReply)
  ) {
    return { kind: 'suppressed', reason: 'unverified_state' };
  }
  const groupRows = input.originatingBatch?.filter((row) => row.groupChatId) ?? [];
  if (groupRows.length > 0) {
    // A plain response has no per-message routing proof. Permit only one unambiguous inbound.
    const origin = groupRows[0];
    if (input.originatingBatch?.length !== 1 || !origin.groupChatId || !origin.messageId) {
      return { kind: 'suppressed', reason: 'ambiguous_group_scope' };
    }
    return {
      kind: 'group_message',
      message: {
        groupChatId: origin.groupChatId,
        relayOfMessageId: origin.messageId,
        messageId: randomUUID(),
        text: cleanReply,
      },
    };
  }
  if (input.replyVisibility === 'internal_activity') {
    return {
      kind: 'live_activity',
      text: cleanReply,
      messageId: `lead-relay-${input.runId}-${input.nowMs}`,
      timestamp: input.nowIso,
    };
  }

  return {
    kind: 'user_message',
    message: {
      from: input.leadName,
      to: 'user',
      text: cleanReply,
      timestamp: input.nowIso,
      read: true,
      summary: cleanReply.length > 60 ? `${cleanReply.slice(0, 57)}...` : cleanReply,
      messageId: `lead-process-${input.runId}-${input.nowMs}`,
      source: 'lead_process',
    },
  };
}
