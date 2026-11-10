import type { InboxMessage } from '@shared/types';

type AutomationMessageLike = Pick<InboxMessage, 'from' | 'messageId' | 'messageKind' | 'source'>;

function getMessageId(message: AutomationMessageLike): string {
  return typeof message.messageId === 'string' ? message.messageId.trim() : '';
}

export function isTaskStallRemediationMessage(message: AutomationMessageLike): boolean {
  if (message.messageKind === 'task_stall_remediation') {
    return true;
  }

  return (
    message.source === 'system_notification' &&
    message.from === 'system' &&
    getMessageId(message).startsWith('task-stall:')
  );
}

export function isMemberWorkSyncNudgeMessage(message: AutomationMessageLike): boolean {
  return message.messageKind === 'member_work_sync_nudge';
}

export function isRuntimeRecoveryNudgeMessage(message: AutomationMessageLike): boolean {
  return message.messageKind === 'runtime_recovery_nudge';
}

export function isReviewPickupEscalationMessage(message: AutomationMessageLike): boolean {
  return (
    message.source === 'system_notification' &&
    message.from === 'system' &&
    getMessageId(message).startsWith('member-work-sync-review-pickup-escalation:')
  );
}
