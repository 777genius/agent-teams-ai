export type RunningTeamActivity =
  | 'active'
  | 'provisioning'
  | 'idle'
  | 'running_unknown'
  | 'not_running';

export interface RunningTeamTaskCountsFact {
  pending: number;
  inProgress: number;
  completed: number;
}

export interface RunningTeamFacts {
  /** Opaque within one source scope. The caller resolves it for navigation. */
  targetKey: string;
  displayName: string;
  activity: RunningTeamActivity;
  taskCounts: { kind: 'known'; counts: RunningTeamTaskCountsFact } | { kind: 'unknown' };
  lastActivity: { kind: 'known'; iso: string } | { kind: 'unknown' };
  projectLabel?: string;
}

const STATUS_PRIORITY: Record<Exclude<RunningTeamActivity, 'not_running'>, number> = {
  active: 0,
  provisioning: 1,
  idle: 2,
  running_unknown: 3,
};

function isRunning(fact: RunningTeamFacts): fact is RunningTeamFacts & {
  activity: Exclude<RunningTeamActivity, 'not_running'>;
} {
  return fact.activity !== 'not_running';
}

function inProgressCount(fact: RunningTeamFacts): number {
  return fact.taskCounts.kind === 'known' ? fact.taskCounts.counts.inProgress : 0;
}

function activityTime(fact: RunningTeamFacts): number {
  if (fact.lastActivity.kind === 'unknown') return 0;
  const parsed = Date.parse(fact.lastActivity.iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sorts a copy. Desktop ties preserve input order; unknown-runtime ties use opaque keys. */
export function rankRunningTeamFacts(facts: readonly RunningTeamFacts[]): RunningTeamFacts[] {
  return facts.filter(isRunning).sort((left, right) => {
    const statusDelta = STATUS_PRIORITY[left.activity] - STATUS_PRIORITY[right.activity];
    if (statusDelta !== 0) return statusDelta;

    if (left.activity === 'running_unknown' && right.activity === 'running_unknown') {
      return (
        left.displayName.localeCompare(right.displayName) ||
        left.targetKey.localeCompare(right.targetKey)
      );
    }

    const inProgressDelta = inProgressCount(right) - inProgressCount(left);
    if (inProgressDelta !== 0) return inProgressDelta;

    const activityDelta = activityTime(right) - activityTime(left);
    if (activityDelta !== 0) return activityDelta;

    // Keep the existing Desktop comparator's stable tie behavior.
    return left.displayName.localeCompare(right.displayName);
  });
}
