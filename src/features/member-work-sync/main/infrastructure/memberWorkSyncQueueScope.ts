import type { MemberWorkSyncReconcileContext } from '../../core/application/MemberWorkSyncReconciler';
import type { MemberWorkSyncTriggerReason } from './MemberWorkSyncEventQueue';
import type { LegacySourceExecutionScope } from '@agent-teams/legacy-agent-host/lifecycle';

/** Event-driven drain of already queued work; it neither changes due times nor retries it. */
export class MemberWorkSyncQueueIdleSignal {
  private readonly waiters = new Set<{
    teamKey: string;
    resolve(): void;
    reject(error: unknown): void;
  }>();

  changed(): void {
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  refuse(teamName: string, error: unknown): void {
    const key = teamName.trim().toLowerCase();
    for (const waiter of this.waiters)
      if (waiter.teamKey === key) {
        this.waiters.delete(waiter);
        waiter.reject(error);
      }
  }

  async drain(
    teamName: string,
    queues: readonly ReadonlyMap<string, { teamName: string }>[],
    owners: readonly ReadonlyMap<string, ReadonlySet<Promise<void>>>[]
  ): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    const matches = (name: string) => name.trim().toLowerCase() === teamKey;
    while (
      queues.some((queue) => [...queue.values()].some((item) => matches(item.teamName))) ||
      owners.some((owner) => [...owner].some(([name, promises]) => matches(name) && promises.size))
    ) {
      await new Promise<void>((resolve, reject) => this.waiters.add({ teamKey, resolve, reject }));
    }
  }
}

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
