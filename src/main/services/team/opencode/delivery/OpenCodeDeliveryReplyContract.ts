/**
 * Reserved reply-recipient marker for informational system/task notifications.
 * "system" is never a configured team member, so a delivery carrying it must
 * not demand a message_send reply — the contract would be unfulfillable.
 */
export const OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT = 'system';
