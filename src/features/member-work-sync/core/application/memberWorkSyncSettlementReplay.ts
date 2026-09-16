import type { MemberWorkSyncReconcileContext } from './MemberWorkSyncReconciler';

function preferLaterSettlement(
  current: MemberWorkSyncReconcileContext['settlement'],
  next: MemberWorkSyncReconcileContext['settlement']
): MemberWorkSyncReconcileContext['settlement'] {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  return Date.parse(next.recordedAt) >= Date.parse(current.recordedAt) ? next : current;
}

interface RememberedMemberWorkSyncSettlement {
  settlement: NonNullable<MemberWorkSyncReconcileContext['settlement']>;
  boundIntentId?: string;
}

const lastSettlements = new Map<string, RememberedMemberWorkSyncSettlement>();

function keyOf(teamName: string, memberName: string): string {
  return `${teamName.trim()}\0${memberName.trim().toLowerCase()}`;
}

function isSameSettlementAttempt(
  left: RememberedMemberWorkSyncSettlement['settlement'],
  right: RememberedMemberWorkSyncSettlement['settlement']
): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.completedGeneration === right.completedGeneration &&
    left.runtimeInstanceId === right.runtimeInstanceId
  );
}

export function isMemberWorkSyncSettlementReplayTrigger(reason: string): boolean {
  return reason === 'manual_refresh' || reason === 'turn_settled';
}

export function rememberMemberWorkSyncLastSettlement(input: {
  teamName: string;
  memberName: string;
  settlement?: MemberWorkSyncReconcileContext['settlement'];
}): MemberWorkSyncReconcileContext['settlement'] {
  const key = keyOf(input.teamName, input.memberName);
  if (!input.settlement) {
    return lastSettlements.get(key)?.settlement;
  }
  const previous = lastSettlements.get(key);
  const settlement = preferLaterSettlement(previous?.settlement, input.settlement);
  if (!settlement) {
    return undefined;
  }
  const keepBinding = previous && isSameSettlementAttempt(previous.settlement, settlement);
  lastSettlements.set(key, {
    settlement,
    ...(keepBinding && previous.boundIntentId ? { boundIntentId: previous.boundIntentId } : {}),
  });
  return settlement;
}

export function peekMemberWorkSyncLastSettlement(input: {
  teamName: string;
  memberName: string;
}): MemberWorkSyncReconcileContext['settlement'] {
  return lastSettlements.get(keyOf(input.teamName, input.memberName))?.settlement;
}

export function peekMemberWorkSyncLastSettlementBinding(input: {
  teamName: string;
  memberName: string;
}): RememberedMemberWorkSyncSettlement | undefined {
  return lastSettlements.get(keyOf(input.teamName, input.memberName));
}

export function bindMemberWorkSyncLastSettlementIntent(input: {
  teamName: string;
  memberName: string;
  intentId: string;
  settlement?: MemberWorkSyncReconcileContext['settlement'];
}): void {
  const key = keyOf(input.teamName, input.memberName);
  const current = lastSettlements.get(key);
  const settlement = input.settlement ?? current?.settlement;
  if (!settlement) {
    return;
  }
  if (current && !isSameSettlementAttempt(current.settlement, settlement)) {
    return;
  }
  if (current?.boundIntentId && current.boundIntentId !== input.intentId) {
    return;
  }
  lastSettlements.set(key, { settlement, boundIntentId: input.intentId });
}

export function resolveQueuedMemberWorkSyncSettlement(input: {
  teamName: string;
  memberName: string;
  triggerReason: string;
  incoming?: MemberWorkSyncReconcileContext['settlement'];
}): MemberWorkSyncReconcileContext['settlement'] {
  if (input.incoming) {
    return rememberMemberWorkSyncLastSettlement({
      teamName: input.teamName,
      memberName: input.memberName,
      settlement: input.incoming,
    });
  }
  if (input.triggerReason === 'manual_refresh') {
    return peekMemberWorkSyncLastSettlement(input);
  }
  return undefined;
}

export function resetMemberWorkSyncLastSettlements(): void {
  lastSettlements.clear();
}

export function dropMemberWorkSyncLastSettlementsForTeam(teamName: string): void {
  const prefix = `${teamName.trim()}\0`;
  for (const key of lastSettlements.keys()) {
    if (key.startsWith(prefix)) {
      lastSettlements.delete(key);
    }
  }
}
