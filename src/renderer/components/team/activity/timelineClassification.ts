import { isThoughtProtocolNoise } from '@shared/utils/inboxNoise';
import { isTeamInternalControlMessageText } from '@shared/utils/teamInternalControlMessages';

import type { InboxMessage } from '@shared/types';

/**
 * Check if a message is a context compaction boundary (system event from lead process).
 */
export function isCompactionMessage(msg: InboxMessage): boolean {
  return msg.from === 'system' && !!msg.messageId?.startsWith('compact-');
}

/**
 * Check if a message is an intermediate lead "thought" (assistant text) rather than
 * an official message (SendMessage, direct reply, inbox, etc.).
 */
export function isLeadThought(msg: InboxMessage): boolean {
  if (typeof msg.to === 'string' && msg.to.trim().length > 0) return false;
  // Compaction boundary events are system messages, not lead thoughts
  if (isCompactionMessage(msg)) return false;
  if (msg.messageKind === 'slash_command_result') return false;
  // Protocol noise (JSON coordination signals, raw teammate-message XML) should be hidden
  if (isThoughtProtocolNoise(msg.text)) return false;
  if (isTeamInternalControlMessageText(msg.text)) return false;
  if (msg.source === 'lead_session') return true;
  if (msg.source === 'lead_process') return true;
  return false;
}

/**
 * Check if a message from lead session/process is protocol noise that should be
 * completely excluded from the timeline (not shown as thoughts OR standalone messages).
 *
 * When `isLeadThought` returns false due to `isThoughtProtocolNoise`, the message
 * falls through to become a standalone ActivityItem — but ActivityItem can't parse
 * noise JSON wrapped in `<teammate-message>` tags. This helper catches those cases
 * so `groupTimelineItems` can skip them entirely.
 */
export function isLeadSessionNoise(msg: InboxMessage): boolean {
  if (msg.source !== 'lead_session' && msg.source !== 'lead_process') return false;
  if (typeof msg.to === 'string' && msg.to.trim().length > 0) return false;
  return isThoughtProtocolNoise(msg.text) || isTeamInternalControlMessageText(msg.text);
}
