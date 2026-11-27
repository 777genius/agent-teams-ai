import type { MemberWorkSyncMemberLike, MemberWorkSyncTaskLike } from './ActionableWorkAgenda.js';

/** A read-only observation request, never an executable callback or proof that CI passed. */
export interface GoalWaitReport {
  kind: 'ci';
  repository: string;
  runId: string;
  expectedCommit: string;
  taskId?: string;
  horizonAt: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}

export function isGoalWaitReport(value: unknown): value is GoalWaitReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  return Object.keys(wait).every(key => ['kind', 'repository', 'runId', 'expectedCommit', 'taskId', 'horizonAt', 'status'].includes(key)) &&
    wait.kind === 'ci' && typeof wait.repository === 'string' && wait.repository.length <= 256 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(wait.repository) &&
    typeof wait.runId === 'string' && /^[0-9]{1,24}$/.test(wait.runId) &&
    typeof wait.expectedCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(wait.expectedCommit) &&
    (wait.taskId === undefined || typeof wait.taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(wait.taskId)) &&
    typeof wait.horizonAt === 'string' && wait.horizonAt.length <= 64 && Number.isFinite(Date.parse(wait.horizonAt)) &&
    typeof wait.status === 'string' && ['pending', 'succeeded', 'failed', 'cancelled'].includes(wait.status);
}

export function goalWaitKey(wait: GoalWaitReport): string {
  return JSON.stringify([wait.kind, wait.repository.toLowerCase(), wait.runId, wait.expectedCommit]);
}

export function goalWaitBackoffMs(observations: number): number {
  return (observations === 0 ? 5 : observations === 1 ? 15 : 30) * 60_000;
}

/** Scheduling and final claim use the same current owner for the original wait obligation. */
export function resolveGoalWaitObserver(
  wait: { taskIds: readonly string[]; observer: string },
  tasks: readonly MemberWorkSyncTaskLike[],
  members: readonly MemberWorkSyncMemberLike[]
): string {
  const current = members.filter(member => !member.removedAt);
  const owners = [...wait.taskIds].sort().flatMap(id => {
    const owner = tasks.find(task => task.id === id)?.owner;
    return owner && current.some(member => member.name === owner) ? [owner] : [];
  });
  return owners.includes(wait.observer) ? wait.observer : owners[0] ??
    (current.some(member => member.name === wait.observer) ? wait.observer :
      current.find(member => member.agentType === 'team-lead')?.name ?? wait.observer);
}
