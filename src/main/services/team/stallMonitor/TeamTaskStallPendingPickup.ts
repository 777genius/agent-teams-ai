import { isTeamTaskBlockedByUnfinishedDependency } from '@shared/utils/teamTaskState';

import {
  getPendingPickupStallThresholdMs,
  isPendingPickupStallRemediationEnabled,
} from './featureGates';

import type { TaskStallEvaluation, TeamTaskStallSnapshot } from './TeamTaskStallTypes';
import type { TeamTask } from '@shared/types';

/**
 * Comment id written by the controller when a blocker completes:
 * `dep-resolved-<completedTaskId>-<blockedTaskId>` (agent-teams-controller
 * notifyUnblockedOwners). The comment is the artifact the owner was notified
 * with, so it is also the pickup clock.
 */
const DEPENDENCY_RESOLVED_COMMENT_ID_PREFIX = 'dep-resolved-';

function normalizeMemberKey(name: string | undefined): string {
  return name?.trim().toLowerCase() ?? '';
}

function skip(
  taskId: string,
  reason: string,
  skipReason: TaskStallEvaluation['skipReason']
): TaskStallEvaluation {
  return {
    status: 'skip',
    taskId,
    reason,
    skipReason,
  };
}

function laterIsoTimestamp(left: string, right: string | null): string {
  if (!right) {
    return left;
  }
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(rightMs)) {
    return left;
  }
  return Number.isFinite(leftMs) && leftMs >= rightMs ? left : right;
}

/**
 * ISO time at which the app told the owner a dependency was resolved, or null.
 * Only `system`-authored comments count: `resolveTaskCommentAuthorName` rejects
 * `from: 'system'` for agent tool calls, so an agent cannot forge this clock.
 */
function resolveDependencyUnblockedAt(task: TeamTask): string | null {
  const idSuffix = `-${task.id}`;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const comment of task.comments ?? []) {
    if (normalizeMemberKey(comment.author) !== 'system') {
      continue;
    }
    if (
      !comment.id.startsWith(DEPENDENCY_RESOLVED_COMMENT_ID_PREFIX) ||
      !comment.id.endsWith(idSuffix)
    ) {
      continue;
    }
    const createdAtMs = Date.parse(comment.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= latestMs) {
      continue;
    }
    latestMs = createdAtMs;
    latest = comment.createdAt;
  }
  return latest;
}

/** ISO time the task was last handed to `owner`, so a reassignment restarts the clock. */
function resolveOwnerAssignedAt(task: TeamTask, owner: string): string | null {
  const events = task.historyEvents ?? [];
  const ownerKey = normalizeMemberKey(owner);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'owner_changed' && normalizeMemberKey(event.to) === ownerKey) {
      return event.timestamp;
    }
  }
  return null;
}

/**
 * Start of the pickup clock. A task that had blockers uses the resolved notice
 * the owner was sent; a task that never had one - the launch shape, and anything
 * the lead creates mid-run - uses the moment it became this owner's to start.
 * Null only when blockers exist and the resolved notice was never written, which
 * is the one shape with no trustworthy clock.
 */
export function resolvePendingPickupReadyAt(task: TeamTask, owner: string): string | null {
  const ownerAssignedAt = resolveOwnerAssignedAt(task, owner);
  const unblockedAt = resolveDependencyUnblockedAt(task);
  if (unblockedAt) {
    return laterIsoTimestamp(unblockedAt, ownerAssignedAt);
  }
  if ((task.blockedBy ?? []).length > 0) {
    return null;
  }
  return task.createdAt ? laterIsoTimestamp(task.createdAt, ownerAssignedAt) : ownerAssignedAt;
}

/** Sequential work is the legitimate reason a pending task sits untouched. */
function ownerIsBusyOnAnotherTask(
  snapshot: TeamTaskStallSnapshot,
  ownerKey: string,
  taskId: string
): boolean {
  return snapshot.inProgressTasks.some(
    (other) => other.id !== taskId && normalizeMemberKey(other.owner) === ownerKey
  );
}

function buildPendingPickupEpochKey(args: {
  task: TeamTask;
  owner: string;
  readyAt: string;
}): string {
  // Deliberately omits task.updatedAt: a stray comment must not rotate the key,
  // reset the journal's two-scan counter, or slip past the alert cooldown.
  return [args.task.id, 'work', 'pending_pickup_after_unblock', args.owner, args.readyAt].join(':');
}

/**
 * "Pickup stall": a pending task has nothing left to wait for - every blocker is
 * resolved, or it never had one - its owner is not busy on another task, and its
 * OpenCode lane is not mid-turn. Needs no transcript evidence, which is what
 * makes it work on OpenCode/ACP-lead teams where the lead transcript carries no
 * per-member turn rows.
 *
 * `lane_active` below means a *fresh* delivery-turn sample. TeamTaskStallSnapshotSource
 * demotes an 'active' sample older than getOpenCodeLaneTurnActivityMaxAgeMs (see
 * openCodeLaneTurnFreshness); without that bound a jammed delivery lane silences the
 * branch that exists to catch the jam. The gate order and resolvePendingPickupReadyAt
 * are correct as they stand, so the freshness rule deliberately lives upstream of this
 * function rather than inside it.
 */
export function evaluatePendingPickupTask(args: {
  now: Date;
  task: TeamTask;
  snapshot: TeamTaskStallSnapshot;
}): TaskStallEvaluation {
  const { task, snapshot } = args;

  if (!isPendingPickupStallRemediationEnabled()) {
    return skip(task.id, 'Pending pickup remediation is disabled', 'pickup_remediation_disabled');
  }
  if (task.status !== 'pending') {
    return skip(task.id, 'Task is not pending', 'task_not_pending');
  }
  if (!task.owner?.trim()) {
    return skip(task.id, 'Task has no owner', 'owner_missing');
  }
  if (task.owner === snapshot.leadName) {
    return skip(task.id, 'Task owner is the lead', 'owner_is_lead');
  }
  if (task.needsClarification) {
    return skip(task.id, 'Task is waiting for clarification', 'needs_clarification');
  }
  if (isTeamTaskBlockedByUnfinishedDependency(task, snapshot.allTasksById)) {
    return skip(task.id, 'Task is blocked', 'task_blocked');
  }

  const ownerKey = normalizeMemberKey(task.owner);
  if (snapshot.providerByMemberName.get(ownerKey) !== 'opencode') {
    // Native owners are covered by member-work-sync's stale-assigned-work
    // activation, which already accepts owned pending tasks.
    return skip(task.id, 'Task owner is not an OpenCode member', 'owner_not_opencode');
  }
  if (ownerIsBusyOnAnotherTask(snapshot, ownerKey, task.id)) {
    return skip(task.id, 'Task owner is already working another task', 'owner_busy_on_other_task');
  }

  const readyAt = resolvePendingPickupReadyAt(task, task.owner);
  if (!readyAt) {
    return skip(
      task.id,
      'Task has no creation, assignment or dependency-resolved evidence to start the pickup clock',
      'no_unblock_evidence'
    );
  }

  if (snapshot.openCodeLaneActiveMemberNames?.has(ownerKey)) {
    // The lane is still generating its turn; a nudge now would only queue
    // behind - or derail - work that is already running.
    return skip(task.id, 'OpenCode lane turn is still active', 'lane_active');
  }

  // An idle sample is ordinary evidence, not a precondition: it can push the
  // clock later but never starts it, so a team whose lane was never sampled is
  // judged exactly as it was before this branch learned to read lanes at all. A
  // sample demoted for age publishes its ORIGINAL observation time, so the age
  // bound cannot restart the clock either.
  const laneIdleSince = snapshot.openCodeLaneIdleSinceByMemberName?.get(ownerKey);
  const laneIdleSinceMs = laneIdleSince ? Date.parse(laneIdleSince) : Number.NaN;
  const clockStartMs = Number.isFinite(laneIdleSinceMs)
    ? Math.max(Date.parse(readyAt), laneIdleSinceMs)
    : Date.parse(readyAt);

  if (args.now.getTime() - clockStartMs < getPendingPickupStallThresholdMs()) {
    return skip(
      task.id,
      'Pending pickup is still below the configured stall threshold',
      'below_threshold'
    );
  }

  const clockLabel = (task.blockedBy ?? []).length
    ? `all blockers resolved at ${readyAt}`
    : `owner has had it since ${readyAt}`;
  const laneLabel = laneIdleSince
    ? ` and its OpenCode lane has been idle since ${laneIdleSince}`
    : '';
  return {
    status: 'alert',
    taskId: task.id,
    memberName: task.owner,
    branch: 'work',
    signal: 'pending_pickup_after_unblock',
    remediationKind: 'pending_pickup',
    epochKey: buildPendingPickupEpochKey({ task, owner: task.owner, readyAt }),
    readyAt,
    reason: `Potential pickup stall: ${clockLabel} but the task is still pending, its owner is not working anything else${laneLabel}.`,
  };
}
