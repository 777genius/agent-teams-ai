import type { MemberWorkSyncReconcileContext } from '../../core/application/MemberWorkSyncReconciler';
import type { MemberWorkSyncTriggerReason } from './MemberWorkSyncEventQueue';
import type { LegacySourceExecutionScope } from '@agent-teams/legacy-agent-host/lifecycle';

/** Shared timers execute each queued operation under its own captured restriction. */
export function runMemberWorkSyncQueueScope<T>(
  scope: LegacySourceExecutionScope | undefined,
  operation: () => T
): T {
  return scope ? scope.run(operation) : operation();
}

export async function awaitMemberWorkSyncQueueTeamIdle(
  teamName: string,
  ...owners: ReadonlyMap<string, ReadonlySet<Promise<void>>>[]
): Promise<void> {
  while (true) {
    const pending = owners.flatMap((owner) => [...(owner.get(teamName) ?? [])]);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

export function unrefMemberWorkSyncTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export interface QueueItem {
  sourceExecution?: LegacySourceExecutionScope;
  teamName: string;
  memberName: string;
  firstQueuedAt: number;
  lastQueuedAt: number;
  runAt: number;
  maxRunAt: number;
  triggerReasons: Set<MemberWorkSyncTriggerReason>;
  triggerReasonCounts: Map<MemberWorkSyncTriggerReason, number>;
  retryCount: number;
  recovery?: MemberWorkSyncReconcileContext['recovery'];
  settlement?: MemberWorkSyncReconcileContext['settlement'];
}

export interface RunningItem {
  teamName: string;
  memberName: string;
  startedAt: number;
  rerunRequested: boolean;
  triggerReasons: Set<MemberWorkSyncTriggerReason>;
  recovery?: MemberWorkSyncReconcileContext['recovery'];
  settlement?: MemberWorkSyncReconcileContext['settlement'];
}
