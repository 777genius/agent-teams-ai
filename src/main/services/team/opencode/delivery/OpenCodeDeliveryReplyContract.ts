import { isLeadAgentType, isLeadMember } from '@shared/utils/leadDetection';

/**
 * Reserved reply-recipient marker for informational system/task notifications.
 * "system" is never a configured team member, so a delivery carrying it must
 * not demand a message_send reply — the contract would be unfulfillable.
 */
export const OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT = 'system';

/**
 * Reply contract of one OpenCode prompt delivery, derived from the reply
 * recipient the inbox relay resolved for the inbound message (the sender, or
 * the informational marker):
 *
 * - `user_reply`: the human asked; a visible message_send reply to the user is
 *   required.
 * - `lead_reply`: the team lead addressed this teammate; a visible reply back to
 *   the lead is required.
 * - `teammate_report`: a teammate (not the lead, not the user) sent this. Such
 *   messages are status reports (task done/started/progress, acknowledgements)
 *   by contract: a reply is optional and must only be sent when the report
 *   needs a decision. Mandatory replies here created receipt ping-pong that
 *   kept teammates answering each other after the team had already finished.
 * - `informational`: app/system notice; no reply recipient exists.
 */
export type OpenCodeDeliveryReplyContract =
  | 'user_reply'
  | 'lead_reply'
  | 'teammate_report'
  | 'informational';

export function classifyOpenCodeDeliveryReplyContract(
  replyRecipient: string | null | undefined
): OpenCodeDeliveryReplyContract {
  const recipient = typeof replyRecipient === 'string' ? replyRecipient.trim() : '';
  const lower = recipient.toLowerCase();
  if (!recipient || lower === 'user') {
    return 'user_reply';
  }
  if (lower === OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT) {
    return 'informational';
  }
  if (isLeadMember({ name: recipient }) || isLeadAgentType(lower)) {
    return 'lead_reply';
  }
  return 'teammate_report';
}

/**
 * True when the delivery never requires a visible reply: the recipient runtime
 * has fulfilled the contract as soon as it produced any assistant response
 * (plain text, tool calls, or an optional visible message). Such deliveries
 * must never be re-prompted for "missing reply proof" — every retry spends
 * another model turn on a message that asked nothing.
 */
export function isOpenCodeReplyOptionalDeliveryContract(
  replyRecipient: string | null | undefined
): boolean {
  const contract = classifyOpenCodeDeliveryReplyContract(replyRecipient);
  return contract === 'informational' || contract === 'teammate_report';
}
