import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { inspectGoalWaits } from '../work-sync/inspectGoalWaits.js';
import { projectWorkSyncTask, readWorkSyncKanbanProjection } from '../work-sync/createNativeMemberWorkSyncAgendaSource.js';
import { buildActionableWorkAgenda } from '../work-sync/policy/core/domain/ActionableWorkAgenda.js';
import { goalLeadObligationCurrent, goalTaskObligationKey } from '../work-sync/policy/core/domain/GoalContinuationPolicy.js';
import { resolveGoalWaitObserver } from '../work-sync/policy/core/domain/GoalWaitPolicy.js';
import type { CommandReceipt } from './contracts.js';
import type { GoalContinuation, GoalRecord } from './goalContracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamTask } from './ports.js';
import type { WorkSyncCommandReceipt } from '../work-sync/commandContracts.js';

/** Recheck queued work using fresh canonical facts inside the original Team admission/claim fence. */
export function goalContinuationCurrent(input: {
  receipt: CommandReceipt; goal: GoalRecord; state: OwnerState;
  scoped: readonly TeamTask[]; allTasks: readonly TeamTask[]; kanban: unknown;
  reports: readonly WorkSyncCommandReceipt[];
  history: readonly (GoalContinuation & { inputId: string; createdAt: string })[];
  nowMs: number;
}): boolean {
  const next = input.receipt.goal?.continuation;
  if (!next) return true;
  const member = input.state.members.find(row => row.memberId === next.target.memberId);
  if (!member?.delivery || runtimeDigest(normalizeBinding(member.delivery)) !== runtimeDigest(normalizeBinding(next.target))) return false;
  const kanban = readWorkSyncKanbanProjection(input.kanban);
  const requiredTaskIds = new Set(input.scoped.map(task => task.id));
  const all = new Map([...input.allTasks, ...input.scoped].map(task => [task.id, task]));
  const tasks = [...all.values()].map(task => ({ ...projectWorkSyncTask(task, kanban.columns[task.id]),
    humanApprovalPending: task.humanApprovalPending === true, progressReferences: [] as string[] }));
  const members = input.state.members.map(row => ({ name: row.name,
    agentType: row.role === 'lead' ? 'team-lead' : 'general-purpose' }));
  // This exact queued attempt must not advance its own observation dueAt.
  const waits = inspectGoalWaits(input.reports,
    input.history.filter(row => row.inputId !== input.receipt.effects.deliveryId), input.goal.deadlineAt)
    .map(wait => ({ ...wait, observer: resolveGoalWaitObserver(wait, tasks, members) }));
  if (next.reason === 'wait') {
    const wait = waits.find(row => `wait:${row.key}` === next.obligationKey);
    return !!wait && wait.pending && !wait.attentionReason && wait.observer === member.name &&
      input.nowMs >= wait.dueAt && input.nowMs < wait.horizonAt &&
      next.evidenceFingerprint === runtimeDigest(JSON.stringify([wait.key, wait.dueAt]));
  }
  const agenda = buildActionableWorkAgenda({ teamName: input.state.binding.teamName, memberName: member.name,
    generatedAt: new Date(input.nowMs).toISOString(), tasks, members,
    kanbanReviewersByTaskId: kanban.reviewers, hash: runtimeDigest });
  if (agenda.diagnostics.length) return false;
  if (next.obligationKey.startsWith('task:')) {
    const blocked = new Set(waits.filter(wait => wait.pending).flatMap(wait => wait.taskIds));
    return agenda.items.some(item => requiredTaskIds.has(item.taskId) &&
      !blocked.has(item.taskId) && goalTaskObligationKey(item, member.name) === next.obligationKey);
  }
  return goalLeadObligationCurrent({ goalId: input.goal.goalId, teamName: input.state.binding.teamName,
    memberName: member.name, role: member.role, nowMs: input.nowMs, tasks, requiredTaskIds,
    members, reviewers: kanban.reviewers, waits, history: [], progressReferences: [], hash: runtimeDigest }, next.obligationKey);
}
