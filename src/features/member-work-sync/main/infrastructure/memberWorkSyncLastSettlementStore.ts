import { expandOpenCodeWorkSyncRuntimeInstanceId } from '../adapters/output/readOpenCodeWorkSyncCurrentRuntimeInstanceId';

import type { MemberWorkSyncReconcileContext } from '../../core/application/MemberWorkSyncReconciler';

export {
  bindMemberWorkSyncLastSettlementIntent,
  dropMemberWorkSyncLastSettlementsForTeam,
  isMemberWorkSyncSettlementReplayTrigger,
  peekMemberWorkSyncLastSettlement,
  peekMemberWorkSyncLastSettlementBinding,
  rememberMemberWorkSyncLastSettlement,
  resetMemberWorkSyncLastSettlements,
  resolveQueuedMemberWorkSyncSettlement,
} from '../../core/application/memberWorkSyncSettlementReplay';

export function buildMemberWorkSyncTurnSettledSettlement(event: {
  sourceId: string;
  recordedAt: string;
  turnId?: string;
  threadId?: string;
  runtimeInstanceId?: string;
  completedGeneration?: number;
  outcome?: string;
  sessionId?: string;
}): MemberWorkSyncReconcileContext['settlement'] {
  const runtimeInstanceId = expandOpenCodeWorkSyncRuntimeInstanceId(
    event.runtimeInstanceId,
    event.sessionId
  );
  return {
    sourceId: event.sourceId,
    recordedAt: event.recordedAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
    ...(typeof event.completedGeneration === 'number'
      ? { completedGeneration: event.completedGeneration }
      : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
  };
}
