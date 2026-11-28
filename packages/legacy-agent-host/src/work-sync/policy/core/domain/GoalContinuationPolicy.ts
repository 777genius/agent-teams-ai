import { buildActionableWorkAgenda } from './ActionableWorkAgenda.js';
import type { MemberWorkSyncMemberLike, MemberWorkSyncTaskLike } from './ActionableWorkAgenda.js';
import type { MemberWorkSyncActionableWorkItem } from '../../contracts/index.js';
import { getTeamTaskWorkflowColumn, isTeamTaskDeleted, isTeamTaskFinishedForDependency } from '../../../../task-workflow/taskState.js';

export interface GoalWorkHistory {
  obligationKey: string;
  evidenceFingerprint: string;
  reason: 'productive' | 'recovery' | 'wait';
  sequence: number;
}
export interface GoalWorkWait {
  key: string;
  taskIds: readonly string[];
  observer: string;
  dueAt: number;
  horizonAt: number;
  pending: boolean;
  description: string;
  /** Derived from the original Runtime input; never persisted as a second wait state. */
  awaitingInput?: boolean;
  attentionReason?: string;
}
export interface GoalWorkTask extends MemberWorkSyncTaskLike {
  /** Derived from the effective canonical review flow; never copied into task storage. */
  humanApprovalPending?: boolean;
  /** References already verified by the canonical task/artifact owner, never report text. */
  progressReferences: readonly string[];
}
export interface GoalWorkDecisionInput {
  goalId: string;
  teamName: string;
  memberName: string;
  role: 'lead' | 'member';
  nowMs: number;
  tasks: GoalWorkTask[];
  requiredTaskIds: ReadonlySet<string>;
  members: MemberWorkSyncMemberLike[];
  reviewers: Record<string, string | null | undefined>;
  history: readonly GoalWorkHistory[];
  waits: readonly GoalWorkWait[];
  progressReferences: readonly string[];
  hash(value: string): string;
}
export type GoalWorkDecision =
  | { kind: 'continue'; obligationKey: string; evidenceFingerprint: string;
      reason: GoalWorkHistory['reason']; sequence: number; instruction: string; attentionReason?: string }
  | { kind: 'waiting' | 'attention' | 'caught_up'; reason: string };

interface Obligation { key: string; references: readonly string[]; instruction: string; taskId?: string }

/** Original continuation identity, shared with admission/retirement of queued task wakes. */
export function goalTaskObligationKey(item: MemberWorkSyncActionableWorkItem, memberName: string): string {
  return `task:${item.taskId}:${item.kind}:${item.evidence.reviewCycleId ?? 'work'}:${memberName}`;
}

/** Claim-time validity is membership, independent of another obligation's recovery priority. */
export function goalLeadObligationCurrent(input: GoalWorkDecisionInput, key: string): boolean {
  if (input.role !== 'lead') return false;
  const obligations: Obligation[] = [];
  addLeadObligations(input, input.tasks.filter(task => input.requiredTaskIds.has(task.id)), obligations, input.waits);
  return obligations.some(obligation => obligation.key === key);
}

/** Select one existing obligation. Ordinary Work Sync policy and all non-opted-in teams are unchanged. */
export function decideGoalContinuation(input: GoalWorkDecisionInput): GoalWorkDecision {
  const required = input.tasks.filter(task => input.requiredTaskIds.has(task.id));
  const agenda = buildActionableWorkAgenda({
    teamName: input.teamName, memberName: input.memberName,
    generatedAt: new Date(input.nowMs).toISOString(), tasks: input.tasks,
    members: input.members, kanbanReviewersByTaskId: input.reviewers, hash: input.hash,
  });
  if (agenda.diagnostics.length) return { kind: 'attention', reason: agenda.diagnostics.join(', ') };
  const pendingWaits = input.waits.filter(wait => wait.pending);
  const blockedTasks = new Set(pendingWaits.flatMap(wait => wait.taskIds));
  const obligations: Obligation[] = agenda.items
    .filter(item => input.requiredTaskIds.has(item.taskId) && !blockedTasks.has(item.taskId))
    .map(item => {
      const task = required.find(candidate => candidate.id === item.taskId)!;
      const dependencies = input.tasks.filter(candidate => task.blockedBy?.some(reference =>
        reference.replace(/^#/, '') === candidate.id || reference.replace(/^#/, '') === candidate.displayId));
      return {
        key: goalTaskObligationKey(item, input.memberName),
        taskId: task.id,
        references: [...task.progressReferences,
          ...dependencies.filter(isTeamTaskFinishedForDependency).map(row => `dependency:${row.id}:complete`)],
        instruction: `${item.kind === 'review' ? 'Review' : 'Continue'} task ${task.displayId ?? task.id}: ${item.subject}. ${item.reason}.`,
      };
    });
  if (input.role === 'lead') addLeadObligations(input, required, obligations, input.waits);

  // Keep serving other eligible work when one obligation reaches its recovery limit.
  let exhausted = input.waits.find(wait => wait.observer === input.memberName && wait.attentionReason)?.attentionReason;
  for (const obligation of obligations) {
    const decision = selectObligation(input, obligation);
    if (decision.kind === 'continue') return { ...decision, ...(exhausted ? { attentionReason: exhausted } : {}) };
    exhausted ??= decision.reason;
  }
  for (const wait of pendingWaits) {
    if (wait.observer !== input.memberName) continue;
    if (wait.attentionReason) { exhausted ??= wait.attentionReason; continue; }
    if (input.nowMs >= wait.horizonAt) {
      exhausted ??= `Waiting limit reached: ${wait.description}`;
      continue;
    }
    if (wait.awaitingInput) continue;
    if (input.nowMs < wait.dueAt) continue;
    return {
      kind: 'continue', obligationKey: `wait:${wait.key}`,
      evidenceFingerprint: input.hash(JSON.stringify([wait.key, wait.dueAt])),
      reason: 'wait', sequence: nextSequence(input.history),
      instruction: `Use the already authorized read-only tool to check ${wait.description}. Do not rerun or modify it. Report the observed status with the same original reference and horizon.`,
    };
  }
  if (exhausted) return { kind: 'attention', reason: exhausted };
  if (pendingWaits.length)
    return { kind: 'waiting', reason: `Waiting for ${pendingWaits.map(wait => wait.description).join('; ')}.` };
  if (required.some(task => task.humanApprovalPending && isTeamTaskFinishedForDependency(task)))
    return { kind: 'waiting', reason: 'Waiting for required human approval of completed work.' };
  if (required.some(task => !isTeamTaskFinishedForDependency(task)))
    return { kind: 'waiting', reason: 'Waiting for assigned work, review or clarification.' };
  return { kind: 'caught_up', reason: 'No actionable work for this member. Goal acceptance remains lead-owned.' };
}

function selectObligation(input: GoalWorkDecisionInput, obligation: Obligation): GoalWorkDecision {
  const history = input.history.filter(row => row.obligationKey === obligation.key)
    .sort((a, b) => a.sequence - b.sequence);
  const evidenceFingerprint = input.hash(JSON.stringify([...new Set(obligation.references)].sort()));
  const freshEvidence = obligation.references.length > 0 && !history.some(row => row.evidenceFingerprint === evidenceFingerprint);
  let recoveryCount = 0;
  for (const row of history) {
    if (row.reason === 'productive') recoveryCount = 0;
    else if (row.reason === 'recovery') recoveryCount++;
  }
  const reason = history.length === 0 || freshEvidence ? 'productive' : 'recovery';
  if (reason === 'recovery' && recoveryCount >= 2)
    return { kind: 'attention', reason: `No verified progress after two recovery attempts: ${obligation.instruction}` };
  return { kind: 'continue', obligationKey: obligation.key, evidenceFingerprint, reason,
    sequence: nextSequence(input.history), instruction: obligation.instruction };
}

function addLeadObligations(input: GoalWorkDecisionInput, required: GoalWorkTask[],
  obligations: Obligation[], waits: readonly GoalWorkWait[]): void {
  const members = new Set(input.members.filter(member => !member.removedAt).map(member => member.name));
  const coordination = required.filter(task => isTeamTaskDeleted(task) ||
    (!isTeamTaskFinishedForDependency(task) && task.needsClarification !== 'user' &&
      (!task.owner || !members.has(task.owner) ||
        (getTeamTaskWorkflowColumn(task) === 'review' && !members.has(input.reviewers[task.id] ?? '')))));
  const failedWaits = waits.filter(wait => !wait.pending && wait.attentionReason);
  if (failedWaits.length) obligations.push({ key: `lead:${input.goalId}:external-result`,
    references: failedWaits.map(wait => wait.key), instruction:
      `Resolve the failed/cancelled required check within the original permissions: ${failedWaits.map(wait => wait.description).join('; ')}. A pending or failed check does not authorize rerun.` });
  if (coordination.length || hasDependencyCycle(required)) {
    obligations.push({ key: `lead:${input.goalId}:coordinate`,
      references: coordination.map(task => `${task.id}:${task.owner ?? 'unassigned'}:${isTeamTaskDeleted(task) ? 'deleted' : 'open'}`),
      instruction: 'Resolve required unassigned/deleted work, unavailable owners/reviewers or cyclic dependencies. Keep the original objective scope; deletion is not completion.' });
  }
  if (!required.length && !waits.some(wait => wait.pending && wait.taskIds.length === 0) && !failedWaits.length)
    obligations.push({ key: `lead:${input.goalId}:plan`, references: input.progressReferences,
      instruction: 'Continue the accepted objective. Create only necessary tasks, or produce and verify the task-free result. Propose the final result when its criteria are met.' });
  else if (required.length && required.every(task => !isTeamTaskDeleted(task) && !task.humanApprovalPending && isTeamTaskFinishedForDependency(task)) && !waits.some(wait => wait.pending || wait.attentionReason))
    obligations.push({ key: `lead:${input.goalId}:verify`,
      references: [...input.progressReferences, ...required.flatMap(task => [`completed:${task.id}`, ...task.progressReferences])],
      instruction: 'Verify the completed objective against its original criteria and current artifacts/checks. Use goal_propose to propose the final result; the Host waits for settled inputs before acceptance.' });
}

function nextSequence(history: readonly GoalWorkHistory[]): number {
  return history.reduce((highest, row) => Math.max(highest, row.sequence), 0) + 1;
}

function hasDependencyCycle(tasks: readonly GoalWorkTask[]): boolean {
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) if (task.displayId && !byId.has(task.displayId)) byId.set(task.displayId, task);
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (task: GoalWorkTask): boolean => {
    if (isTeamTaskFinishedForDependency(task)) return false;
    if (active.has(task.id)) return true;
    if (visited.has(task.id)) return false;
    active.add(task.id);
    for (const reference of task.blockedBy ?? []) {
      const next = byId.get(reference.replace(/^#/, ''));
      if (next && visit(next)) return true;
    }
    active.delete(task.id); visited.add(task.id); return false;
  };
  return tasks.some(visit);
}
