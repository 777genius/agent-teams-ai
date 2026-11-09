import { isLeadAgentType, isLeadNameAlias } from '@shared/utils/leadDetection';

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
  if (isLeadNameAlias(recipient) || isLeadAgentType(lower)) {
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
/**
 * True when NOBODY authored this delivery: the app itself wrote it (a task
 * state change, a comment notification, a stall or restart notice), so no
 * member is waiting on anything and the text carries no instruction of its own.
 *
 * This is deliberately narrower than `isOpenCodeReplyOptionalDeliveryContract`.
 * "Reply optional" also covers `teammate_report`, and that classification is
 * made purely from the SENDER: every ordinary `SendMessage` a teammate writes
 * lands there, including "I found a bug in your module, please look". Optional
 * reply is a safe thing to tell the runtime about such a message; SUPPRESSING
 * it is not. Anything that absorbs a message instead of delivering it must use
 * this predicate, so only app-written notices can ever be absorbed.
 */
export function isOpenCodeAppAuthoredNoticeContract(
  replyRecipient: string | null | undefined
): boolean {
  return classifyOpenCodeDeliveryReplyContract(replyRecipient) === 'informational';
}

export function isOpenCodeReplyOptionalDeliveryContract(
  replyRecipient: string | null | undefined
): boolean {
  const contract = classifyOpenCodeDeliveryReplyContract(replyRecipient);
  return contract === 'informational' || contract === 'teammate_report';
}

/** Resolve a configured lead independently of its display-name aliases. */
export function isOpenCodeConfiguredLeadReply(
  record: { replyRecipient?: string | null } | null | undefined,
  configuredLeadName: string | null | undefined
): boolean {
  const recipient = record?.replyRecipient?.trim().toLowerCase();
  return Boolean(
    recipient && configuredLeadName?.trim() &&
    recipient === configuredLeadName.trim().toLowerCase()
  );
}
/** Concrete user/lead messages must not settle without a destination receipt. */
export function isOpenCodeReplyRequiredDeliveryRecipient(
  recipient: string | null | undefined,
  configuredLeadName?: string | null
): boolean {
  if (!recipient?.trim()) return false;
  const replyContract = classifyOpenCodeDeliveryReplyContract(recipient);
  return replyContract === 'user_reply' || replyContract === 'lead_reply' ||
    isOpenCodeConfiguredLeadReply({ replyRecipient: recipient }, configuredLeadName);
}

/** The persisted recipient, reply ID and physical inbox must describe the same lead delivery. */
export function isOpenCodeLeadDestinationProof(
  record: {
    memberName: string;
    inboxMessageId: string;
    visibleReplyInbox?: string | null;
    visibleReplyMessageId?: string | null;
  } | null | undefined,
  configuredLeadName: string | null | undefined,
  proof: {
    inboxName: string;
    message: {
      messageId: string;
      from: string;
      to?: string;
      relayOfMessageId?: string;
    };
  } | null | undefined
): boolean {
  const lead = configuredLeadName?.trim().toLowerCase();
  return Boolean(
    lead && record && proof &&
    record.visibleReplyInbox?.trim().toLowerCase() === lead &&
    record.visibleReplyMessageId?.trim() === proof.message.messageId.trim() &&
    proof.inboxName.trim().toLowerCase() === lead &&
    proof.message.to?.trim().toLowerCase() === lead &&
    proof.message.from.trim().toLowerCase() === record.memberName.trim().toLowerCase() &&
    proof.message.relayOfMessageId?.trim() === record.inboxMessageId.trim()
  );
}

/** Lead role may be a legacy alias or the configured member's custom name. */
export function isOpenCodeLeadReplyRecipient(
  record: { replyRecipient?: string | null } | null | undefined,
  configuredLeadName: string | null | undefined
): boolean {
  return Boolean(record &&
    (classifyOpenCodeDeliveryReplyContract(record.replyRecipient) === 'lead_reply' ||
      isOpenCodeConfiguredLeadReply(record, configuredLeadName)));
}
