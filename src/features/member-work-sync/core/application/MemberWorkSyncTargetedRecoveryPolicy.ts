import { isReviewPickupAgenda } from './MemberWorkSyncNudgeAgendaPredicates';

import type { MemberWorkSyncStatus } from '../../contracts';

export type MemberWorkSyncTargetedRecoveryReason =
  | 'opencode_targeted_shadow_collecting'
  | 'lead_targeted_shadow_collecting'
  | 'native_targeted_shadow_collecting';

export type MemberWorkSyncTargetedRecoveryCapability =
  | 'opencode_runtime_delivery'
  | 'lead_inbox_relay'
  | 'native_inbox_watch';

export type MemberWorkSyncTargetedRecoveryDecision =
  | {
      active: true;
      reason: MemberWorkSyncTargetedRecoveryReason;
      capability: MemberWorkSyncTargetedRecoveryCapability;
    }
  | { active: false };

function isLeadLikeMemberName(memberName: string): boolean {
  const normalized = memberName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return (
    normalized === 'lead' ||
    normalized === 'team-lead' ||
    normalized === 'teamlead' ||
    normalized === 'team-leader'
  );
}

function isNativeInboxWatchProvider(providerId: MemberWorkSyncStatus['providerId']): boolean {
  return providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini';
}

function resolveTargetedRecoveryCapability(status: MemberWorkSyncStatus): {
  capability: MemberWorkSyncTargetedRecoveryCapability;
  reason: MemberWorkSyncTargetedRecoveryReason;
} | null {
  if (status.providerId === 'opencode') {
    return {
      capability: 'opencode_runtime_delivery',
      reason: 'opencode_targeted_shadow_collecting',
    };
  }

  if (isLeadLikeMemberName(status.memberName)) {
    return {
      capability: 'lead_inbox_relay',
      reason: 'lead_targeted_shadow_collecting',
    };
  }

  if (isNativeInboxWatchProvider(status.providerId)) {
    return {
      capability: 'native_inbox_watch',
      reason: 'native_targeted_shadow_collecting',
    };
  }

  return null;
}

export function decideMemberWorkSyncTargetedRecovery(
  status: MemberWorkSyncStatus
): MemberWorkSyncTargetedRecoveryDecision {
  if (
    status.state !== 'needs_sync' ||
    status.shadow?.wouldNudge !== true ||
    status.agenda.items.length === 0 ||
    isReviewPickupAgenda(status)
  ) {
    return { active: false };
  }

  const target = resolveTargetedRecoveryCapability(status);
  return target ? { active: true, ...target } : { active: false };
}
