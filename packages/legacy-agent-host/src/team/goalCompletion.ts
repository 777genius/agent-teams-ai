import { TeamOwnerError } from './contracts.js';
import { digest, effectId } from './identity.js';
import type { TeamTask } from './ports.js';
import type { GoalInputSource, GoalProposalRequest, GoalRecord } from './goalContracts.js';
import type { RuntimeInput } from '../runtime/contracts.js';
import { getTeamTaskWorkflowColumn, isTeamTaskDeleted, isTeamTaskNeedsFixActionable } from '../task-workflow/taskState.js';

/** Exclude display/read clocks; retain the canonical work, review and artifact identity. */
export function goalTaskFingerprint(tasks: readonly TeamTask[]): string {
  return digest(tasks.map(task => ({
    id: task.id, status: task.status, subject: task.subject, description: task.description,
    owner: task.owner, blockedBy: task.blockedBy, deletedAt: task.deletedAt,
    reviewState: task.reviewState, reviewRequestId: task.reviewRequestId,
    reviewer: task.reviewer, kanbanColumn: task.kanbanColumn,
    needsClarification: task.needsClarification, clarificationRequestId: task.clarificationRequestId,
    attachments: task.attachments, comments: task.comments,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function incomplete(tasks: readonly TeamTask[]): boolean {
  return tasks.some(task => isTeamTaskDeleted(task) || task.status !== 'completed' ||
    getTeamTaskWorkflowColumn(task) === 'review' || isTeamTaskNeedsFixActionable(task) ||
    Boolean(task.needsClarification));
}

export function proposeGoal(goal: GoalRecord, tasks: readonly TeamTask[], principalId: string,
  source: GoalInputSource, request: GoalProposalRequest, authorityRevision: number, evidenceFingerprint: string): GoalRecord {
  if (!request || Object.keys(request).some(key => !['commandId', 'result', 'evidence'].includes(key)) ||
      typeof request.commandId !== 'string' || !request.commandId.trim() || request.commandId.length > 256 ||
      typeof request.result !== 'string' || !request.result.trim() || request.result.length > 48000 ||
      (request.evidence !== undefined && (typeof request.evidence !== 'string' || request.evidence.length > 8192)))
    throw new TeamOwnerError('invalid');
  if (!/^[a-f0-9]{64}$/.test(evidenceFingerprint)) throw new TeamOwnerError('hold');
  const proposal = { ...request, source: structuredClone(source), principalId, revision: goal.revision,
    authorityRevision, evidenceFingerprint,
    taskFingerprint: goalTaskFingerprint(tasks), resultMessageId: effectId('goal-result', goal.goalId, request.commandId) };
  if (goal.proposal?.commandId === request.commandId) {
    if (digest(goal.proposal) !== digest(proposal)) throw new TeamOwnerError('conflict');
    return goal;
  }
  if (goal.disposition !== 'active' || incomplete(tasks)) throw new TeamOwnerError('hold');
  const next = structuredClone(goal);
  next.disposition = 'finalizing'; next.proposal = proposal; delete next.reason;
  return next;
}

export function reconcileGoalCandidate(goal: GoalRecord, tasks: readonly TeamTask[], inputs: readonly RuntimeInput[],
  pendingWait: boolean, waitFailure?: string, evidenceFingerprint?: string): GoalRecord {
  if (goal.disposition !== 'finalizing' || !goal.proposal) return goal;
  const next = structuredClone(goal), proposal = goal.proposal;
  const proposing = inputs.find(input => input.intent.inputId === proposal.source.inputId &&
    input.operationRef === proposal.source.operationRef && input.fingerprint === proposal.source.inputFingerprint);
  if (waitFailure || proposal.revision !== goal.revision || incomplete(tasks) || goalTaskFingerprint(tasks) !== proposal.taskFingerprint ||
      (evidenceFingerprint !== undefined && evidenceFingerprint !== proposal.evidenceFingerprint) ||
      (proposing && ['not-sent', 'cancelled', 'rejected'].includes(proposing.phase)) ||
      (proposing?.phase === 'terminal' && proposing.terminal !== 'succeeded')) {
    next.disposition = 'active'; delete next.proposal; next.reason = waitFailure ?? 'verification-changed';
    return next;
  }
  if (!proposing || proposing.phase !== 'terminal' || proposing.terminal !== 'succeeded' || pendingWait ||
      evidenceFingerprint === undefined ||
      inputs.some(input => ['admitted', 'claimed', 'consumed', 'unknown'].includes(input.phase))) {
    next.reason = pendingWait ? 'verification-waiting' : 'waiting-for-input-settlement';
    return next;
  }
  next.disposition = 'accepted'; delete next.reason;
  return next;
}
