import { isInboxNoiseMessage, parseInboxJson } from './inboxNoise';

export interface IdleNotificationPayload {
  type: 'idle_notification';
  from?: string;
  timestamp?: string;
  idleReason?: 'available' | 'interrupted' | 'failed';
  summary?: string;
  completedTaskId?: string;
  completedStatus?: 'resolved' | 'blocked' | 'failed';
  failureReason?: string;
}

export type IdleNotificationPrimaryKind = 'heartbeat' | 'interrupted' | 'task_terminal' | 'failure';

export interface ClassifiedIdleNotification {
  payload: IdleNotificationPayload;
  primaryKind: IdleNotificationPrimaryKind;
  hasPeerSummary: boolean;
  peerSummary: string | null;
  countsAsBootstrapConfirmation: boolean;
}

function getTrimmedOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isIdleNotificationPayload(value: unknown): value is IdleNotificationPayload {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'idle_notification'
  );
}

export function classifyIdleNotificationText(text: string): ClassifiedIdleNotification | null {
  const parsed = parseInboxJson(text);
  if (!isIdleNotificationPayload(parsed)) return null;

  const peerSummary = getTrimmedOptionalString(parsed.summary);
  const hasPeerSummary = peerSummary !== null;
  const failureReason = getTrimmedOptionalString(parsed.failureReason);
  const completedTaskId = getTrimmedOptionalString(parsed.completedTaskId);

  let primaryKind: IdleNotificationPrimaryKind;
  if (
    parsed.idleReason === 'failed' ||
    failureReason !== null ||
    parsed.completedStatus === 'failed'
  ) {
    primaryKind = 'failure';
  } else if (
    completedTaskId !== null ||
    parsed.completedStatus === 'resolved' ||
    parsed.completedStatus === 'blocked'
  ) {
    primaryKind = 'task_terminal';
  } else if (parsed.idleReason === 'interrupted') {
    primaryKind = 'interrupted';
  } else {
    primaryKind = 'heartbeat';
  }

  return {
    payload: parsed,
    primaryKind,
    hasPeerSummary,
    peerSummary,
    countsAsBootstrapConfirmation: primaryKind !== 'failure',
  };
}

export function shouldSuppressDesktopNotificationForInboxText(text: string): boolean {
  return classifyIdleNotificationText(text) !== null || isInboxNoiseMessage(text);
}

export function shouldExcludeInboxTextFromReplyCandidates(text: string): boolean {
  return classifyIdleNotificationText(text) !== null || isInboxNoiseMessage(text);
}

export function getIdleGraphLabel(text: string): string | null {
  const classified = classifyIdleNotificationText(text);
  if (!classified) return null;
  return classified.hasPeerSummary && classified.peerSummary ? classified.peerSummary : 'idle';
}
