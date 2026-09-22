import { classifyIdleNotificationText } from '@shared/utils/idleNotificationSemantics';

import type { InboxMessage } from '@shared/types';
import type {
  ClassifiedIdleNotification as SharedClassifiedIdleNotification,
  IdleNotificationPayload,
  IdleNotificationPrimaryKind,
} from '@shared/utils/idleNotificationSemantics';

export interface ClassifiedIdleNotification {
  payload: IdleNotificationPayload;
  primaryKind: IdleNotificationPrimaryKind;
  hasPeerSummary: boolean;
  peerSummary: string | null;
  countsAsBootstrapConfirmation: boolean;
  liveDelivery: 'silent_finalize' | 'passive_activity' | 'visible_actionable';
  uiPresentation: 'heartbeat' | 'peer_summary' | 'interrupted' | 'task_terminal' | 'failure';
}

export function classifyIdleNotification(
  value: string | Pick<InboxMessage, 'text'> | Record<string, unknown> | IdleNotificationPayload
): ClassifiedIdleNotification | null {
  const text =
    typeof value === 'string'
      ? value
      : 'text' in value && typeof value.text === 'string'
        ? value.text
        : JSON.stringify(value);
  const shared = classifyIdleNotificationText(text);
  if (!shared) return null;

  const liveDelivery =
    shared.primaryKind === 'heartbeat'
      ? shared.hasPeerSummary
        ? 'passive_activity'
        : 'silent_finalize'
      : 'visible_actionable';

  const uiPresentation =
    shared.primaryKind === 'heartbeat'
      ? shared.hasPeerSummary
        ? 'peer_summary'
        : 'heartbeat'
      : shared.primaryKind;

  return {
    ...shared,
    liveDelivery,
    uiPresentation,
  };
}

export function shouldKeepIdleMessageInActivityWhenNoiseHidden(
  value: string | Pick<InboxMessage, 'text'> | Record<string, unknown> | IdleNotificationPayload
): boolean {
  const classified = classifyIdleNotification(value);
  return classified?.liveDelivery === 'passive_activity';
}

export function getIdleNoiseLabel(
  value: string | Pick<InboxMessage, 'text'> | Record<string, unknown> | IdleNotificationPayload
): string | null {
  const classified = classifyIdleNotification(value);
  if (!classified) return null;

  if (classified.uiPresentation !== 'heartbeat') {
    return null;
  }

  const reason =
    typeof classified.payload.idleReason === 'string' &&
    classified.payload.idleReason.trim().length > 0
      ? classified.payload.idleReason.trim()
      : null;
  return reason ? `Idle (${reason})` : 'Idle';
}
