import {
  classifyIdleNotificationText,
  type IdleNotificationPrimaryKind as MainProcessIdlePrimaryKind,
} from '@shared/utils/idleNotificationSemantics';

export type MainProcessIdleHandling = 'silent_noise' | 'passive_activity' | 'visible_actionable';

export interface ClassifiedMainProcessIdle {
  primaryKind: MainProcessIdlePrimaryKind;
  hasPeerSummary: boolean;
  peerSummary: string | null;
  handling: MainProcessIdleHandling;
}

export function classifyIdleNotificationForMainProcess(
  text: string
): ClassifiedMainProcessIdle | null {
  const classified = classifyIdleNotificationText(text);
  if (!classified) return null;

  const handling: MainProcessIdleHandling =
    classified.primaryKind === 'heartbeat'
      ? classified.hasPeerSummary
        ? 'passive_activity'
        : 'silent_noise'
      : 'visible_actionable';

  return {
    primaryKind: classified.primaryKind,
    hasPeerSummary: classified.hasPeerSummary,
    peerSummary: classified.peerSummary,
    handling,
  };
}
