import { preferLaterMemberWorkSyncSettlement } from './memberWorkSyncSettlementCoalesce';

import type { MemberWorkSyncReconcileContext } from '../../core/application/MemberWorkSyncReconciler';

const lastSettlements = new Map<string, MemberWorkSyncReconcileContext['settlement']>();

function keyOf(teamName: string, memberName: string): string {
  return `${teamName.trim()}\0${memberName.trim().toLowerCase()}`;
}

export function rememberMemberWorkSyncLastSettlement(input: {
  teamName: string;
  memberName: string;
  settlement?: MemberWorkSyncReconcileContext['settlement'];
}): MemberWorkSyncReconcileContext['settlement'] {
  const key = keyOf(input.teamName, input.memberName);
  const settlement = preferLaterMemberWorkSyncSettlement(
    lastSettlements.get(key),
    input.settlement
  );
  if (settlement) {
    lastSettlements.set(key, settlement);
  }
  return settlement;
}

export function peekMemberWorkSyncLastSettlement(input: {
  teamName: string;
  memberName: string;
}): MemberWorkSyncReconcileContext['settlement'] {
  return lastSettlements.get(keyOf(input.teamName, input.memberName));
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

export function buildMemberWorkSyncTurnSettledSettlement(event: {
  sourceId: string;
  recordedAt: string;
  turnId?: string;
  threadId?: string;
  runtimeInstanceId?: string;
  completedGeneration?: number;
  outcome?: string;
}): MemberWorkSyncReconcileContext['settlement'] {
  return {
    sourceId: event.sourceId,
    recordedAt: event.recordedAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.runtimeInstanceId ? { runtimeInstanceId: event.runtimeInstanceId } : {}),
    ...(typeof event.completedGeneration === 'number'
      ? { completedGeneration: event.completedGeneration }
      : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
  };
}
