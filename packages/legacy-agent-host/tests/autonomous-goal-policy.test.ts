import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideGoalContinuation, goalLeadObligationCurrent } from '../dist/work-sync/policy/core/domain/GoalContinuationPolicy.js';
import { goalContinuationCurrent } from '../dist/team/goalContinuationCurrent.js';
import type { GoalWorkDecisionInput, GoalWorkHistory } from '../dist/work-sync/policy/core/domain/GoalContinuationPolicy.js';
import { runtimeDigest } from '../dist/runtime/identity.js';

const input = (): GoalWorkDecisionInput => ({ goalId: 'TEST-goal', teamName: 'TEST-team', memberName: 'worker',
  role: 'member', nowMs: Date.parse('2026-11-27T12:00:00.000Z'),
  tasks: [{ id: 'TEST-task', subject: 'TEST bounded work', status: 'in_progress', owner: 'worker', progressReferences: [] }],
  requiredTaskIds: new Set(['TEST-task']), members: [{ name: 'lead', agentType: 'team-lead' },
    { name: 'worker', agentType: 'general-purpose' }], reviewers: {}, history: [], waits: [],
  progressReferences: [], hash: runtimeDigest });

const next = (selected: GoalWorkDecisionInput, history: GoalWorkHistory[]) => {
  const result = decideGoalContinuation({ ...selected, history });
  assert.equal(result.kind, 'continue');
  if (result.kind !== 'continue') assert.fail();
  history.push(result);
  return result;
};

test('one initial eligible action is followed by exactly two no-progress recoveries', () => {
  const selected = input(), history: GoalWorkHistory[] = [];
  assert.equal(next(selected, history).reason, 'productive');
  assert.equal(next(selected, history).reason, 'recovery');
  assert.equal(next(selected, history).reason, 'recovery');
  assert.deepEqual(history.map(row => row.sequence), [1, 2, 3]);
  assert.equal(decideGoalContinuation({ ...selected, history }).kind, 'attention');
});

test('new verified evidence permits productive continuation; its replay or absence does not reset recovery', () => {
  const selected = input(), history: GoalWorkHistory[] = [];
  for (let step = 0; step < 3; step++) next(selected, history);
  selected.tasks[0]!.progressReferences = ['native-artifact:TEST-first-bytes'];
  assert.equal(next(selected, history).reason, 'productive');
  assert.equal(next(selected, history).reason, 'recovery');
  selected.tasks[0]!.progressReferences = [];
  assert.equal(next(selected, history).reason, 'recovery');
  selected.tasks[0]!.progressReferences = ['native-artifact:TEST-first-bytes'];
  assert.equal(decideGoalContinuation({ ...selected, history }).kind, 'attention');
  selected.tasks[0]!.progressReferences = ['native-artifact:TEST-new-bytes'];
  assert.equal(next(selected, history).reason, 'productive');
});

test('an exhausted obligation keeps attention while another assigned obligation can proceed', () => {
  const selected = input(), history: GoalWorkHistory[] = [];
  for (let step = 0; step < 3; step++) next(selected, history);
  selected.tasks.push({ id: 'TEST-other', status: 'pending', owner: 'worker', subject: 'TEST independent work', progressReferences: [] });
  selected.requiredTaskIds = new Set(['TEST-task', 'TEST-other']);
  const result = next(selected, history);
  assert.match(result.obligationKey, /^task:TEST-other:/u);
  assert.match(result.attentionReason!, /two recovery attempts/u);
});

for (const removedMember of ['absent', 'marked-removed'] as const) {
  test(`a removed assigned reviewer (${removedMember}) yields lead coordination until review is reassigned`, () => {
    const selected = input();
    selected.memberName = 'lead'; selected.role = 'lead';
    const task = selected.tasks[0]!;
    task.status = 'completed'; task.reviewState = 'review'; task.kanbanColumn = 'review';
    task.historyEvents = [{ id: 'TEST-review-request-1', type: 'review_requested',
      actor: 'worker', reviewer: 'reviewer', timestamp: '2026-11-27T11:59:00.000Z' }];
    selected.members.push({ name: 'reviewer', agentType: 'general-purpose' });
    selected.reviewers[task.id] = 'reviewer';
    const coordinateKey = `lead:${selected.goalId}:coordinate`;
    const reviewerWork = () => decideGoalContinuation({ ...selected, memberName: 'reviewer', role: 'member' });
    const workerWork = () => decideGoalContinuation({ ...selected, memberName: 'worker', role: 'member' });

    assert.equal(decideGoalContinuation(selected).kind, 'waiting');
    assert.equal(workerWork().kind, 'waiting', 'completed work is still waiting for the required review');
    const assigned = reviewerWork();
    assert.equal(assigned.kind, 'continue');
    if (assigned.kind !== 'continue') assert.fail();
    assert.match(assigned.obligationKey, /^task:TEST-task:review:/u);
    assert.equal(goalLeadObligationCurrent(selected, coordinateKey), false);

    // Canonical roster removal leaves the completed task and review assignment intact.
    if (removedMember === 'absent') selected.members = selected.members.filter(member => member.name !== 'reviewer');
    else selected.members.find(member => member.name === 'reviewer')!.removedAt = '2026-11-27T12:00:00.000Z';
    assert.equal(reviewerWork().kind, 'attention', 'a removed actor gains no new review work');
    assert.equal(workerWork().kind, 'waiting', 'the implementation owner cannot bypass the review');
    const coordination = decideGoalContinuation(selected);
    assert.equal(coordination.kind, 'continue');
    if (coordination.kind !== 'continue') assert.fail();
    assert.equal(coordination.obligationKey, coordinateKey);
    assert.equal(coordination.reason, 'productive');
    assert.equal(goalLeadObligationCurrent(selected, coordinateKey), true,
      'the shared claim-time predicate keeps the queued coordination eligible');
    assert.equal(selected.reviewers[task.id], 'reviewer', 'the policy itself cannot mutate the canonical assignment');
    assert.equal(task.reviewState, 'review');

    task.needsClarification = 'user';
    assert.equal(decideGoalContinuation(selected).kind, 'waiting', 'required user clarification remains a pause');
    assert.equal(goalLeadObligationCurrent(selected, coordinateKey), false);
    task.needsClarification = null;

    // A new canonical review_request can select the lead, who is not this task's owner.
    selected.reviewers[task.id] = 'lead';
    task.historyEvents.push({ id: 'TEST-review-request-2', type: 'review_requested',
      actor: 'lead', reviewer: 'lead', timestamp: '2026-11-27T12:00:01.000Z' });
    assert.equal(goalLeadObligationCurrent(selected, coordinateKey), false,
      'stale queued coordination must stop being eligible once an active reviewer is assigned');
    const reassigned = decideGoalContinuation(selected);
    assert.equal(reassigned.kind, 'continue');
    if (reassigned.kind !== 'continue') assert.fail();
    assert.match(reassigned.obligationKey, /^task:TEST-task:review:/u);
    assert.notEqual(reassigned.obligationKey, assigned.obligationKey, 'the new canonical review cycle has its own work');
    assert.equal(workerWork().kind, 'waiting');
  });
}

for (const kind of ['coordinate', 'external-result'] as const) {
  test(`an exhausted lead task does not invalidate its independent ${kind} obligation`, () => {
    const selected = input(), history: GoalWorkHistory[] = [];
    selected.memberName = 'lead'; selected.role = 'lead'; selected.tasks[0]!.owner = 'lead';
    for (let step = 0; step < 3; step++) next(selected, history);
    if (kind === 'coordinate') {
      selected.tasks.push({ id: 'TEST-other', status: 'pending', subject: 'TEST unassigned work', progressReferences: [] });
      selected.requiredTaskIds = new Set(['TEST-task', 'TEST-other']);
    } else selected.waits = [{ key: 'TEST-failed-check', taskIds: [], observer: 'lead',
      pending: false, dueAt: 0, horizonAt: selected.nowMs + 60_000, description: 'TEST required CI run',
      attentionReason: 'TEST known failed check needs lead coordination' }];
    const continuation = next(selected, history);
    assert.equal(continuation.obligationKey, `lead:TEST-goal:${kind}`);
    assert.equal(goalLeadObligationCurrent({ ...selected, history: [] }, continuation.obligationKey), true,
      'claim validity tests current membership without resetting another task\'s recovery priority');
    if (kind === 'coordinate') {
      const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'TEST-team' };
      const target = { ...binding, runId: 'TEST-run', memberId: 'lead-id', generation: '1' };
      const source = { binding: target, inputId: 'TEST-original', operationRef: 'TEST-operation', inputFingerprint: 'a'.repeat(64) };
      const command = { commandId: 'TEST-lead-coordinate', operation: 'message.send' as const,
        payload: { to: 'lead', text: 'TEST coordinate independent unassigned work' } };
      const scoped = selected.tasks.map(task => ({ id: task.id, status: task.status,
        subject: task.subject, owner: task.owner }));
      assert.equal(goalContinuationCurrent({
        receipt: { schemaVersion: 1, binding, commandId: command.commandId, principalId: 'lead-session',
          fingerprint: 'b'.repeat(64), command, effects: { taskId: 'TEST-effect', commentId: 'TEST-comment',
            messageId: 'TEST-message', deliveryId: 'TEST-continuation' },
          createdAt: new Date(selected.nowMs).toISOString(), phase: 'completed',
          goal: { goalId: selected.goalId, revision: 1, kind: 'continuation',
            continuation: { ...continuation, target, source, text: command.payload.text } } },
        goal: { goalId: selected.goalId, revision: 1, rootCommandId: 'TEST-original', rootPrincipalId: 'human',
          rootBinding: target, rootMode: 'do', startedAt: new Date(selected.nowMs).toISOString(),
          deadlineAt: new Date(selected.nowMs + 3600_000).toISOString(), attemptLimit: 8, disposition: 'active', debits: {} },
        state: { schemaVersion: 1, binding, ready: true, grants: [],
          members: [{ memberId: target.memberId, name: 'lead', role: 'lead', delivery: target }] },
        scoped, allTasks: scoped, kanban: { tasks: {} }, reports: [], history: [], nowMs: selected.nowMs,
      }), true, 'the actual shared admission/claim predicate accepts the valid queued coordination');
      selected.tasks[1]!.owner = 'worker';
    } else selected.waits = [];
    assert.equal(goalLeadObligationCurrent(selected, continuation.obligationKey), false,
      'the same obligation becomes obsolete after its current facts are resolved');
  });
}
