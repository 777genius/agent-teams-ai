import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('review rejection repairs the same task, re-review binds a new cycle and required human approval pauses automatic work', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'task.board.review-flow', payload: {
    settings: { reviewFlow: 'human_approval', reviewFlowPrompt: 'TEST require the original human decision' },
  } }, 'TEST-goal-review-policy'));
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST implement, review, repair and receive required human acceptance', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 20 } } }, 'TEST-goal-review-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input starts');
  const created = await f.tool('lead', 'task_create', { commandId: 'TEST-goal-review-task',
    subject: 'TEST original implementation with a required review', owner: 'worker' }) as CommandReceipt;
  assert.equal(created.phase, 'completed');
  const taskId = created.effects.taskId;
  const task = async () => success<{ id: string; status: string; reviewState: string;
    historyEvents?: { type: string; actor?: string }[] }>(await f.rpc('team.task.get', { taskId }));
  const call = async (member: 'lead' | 'worker', tool: string, commandId: string, fields: Record<string, unknown> = {}) => {
    const result = await f.tool(member, tool, { commandId, taskId, ...fields }) as CommandReceipt;
    assert.equal(result.phase, 'completed', JSON.stringify(result));
    return result;
  };
  await eventually(() => f.session('worker').submits.length === 1, 'original worker assignment starts');
  await call('worker', 'task_start', 'TEST-goal-review-start');
  await f.captureWrite('worker', 0, 'TEST first implementation with a review defect\n');
  await call('worker', 'task_complete', 'TEST-goal-review-complete');
  await call('worker', 'review_request', 'TEST-goal-review-request', { reviewer: 'lead' });
  const first = await call('lead', 'review_start', 'TEST-goal-review-first-start');
  const firstCycle = (first.result as { reviewRequestId: string }).reviewRequestId;
  assert.equal(typeof firstCycle, 'string');
  await call('lead', 'review_request_changes', 'TEST-goal-review-reject', {
    expectedReviewRequestId: firstCycle, comment: 'TEST fix the original artifact edge case',
  });
  assert.equal((await task()).status, 'pending');
  assert.equal((await task()).reviewState, 'needsFix');
  assert.deepEqual(await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-goal-review-too-early', result: 'TEST rejected work cannot be final',
  }), { error: { code: 'hold' } });
  f.session('worker').finish(0);
  await eventually(() => f.session('worker').submits.length === 2,
    'actual review rejection notification reaches the original owner for repair');
  assert.notEqual(f.session('worker').submits[1]!.inputId, f.session('worker').submits[0]!.inputId);
  await call('worker', 'task_start', 'TEST-goal-review-repair-start');
  await f.captureWrite('worker', 1, 'TEST repaired original artifact edge case\n');
  await call('worker', 'task_complete', 'TEST-goal-review-repair-complete');
  await call('worker', 'review_request', 'TEST-goal-review-request-again', { reviewer: 'lead' });
  const second = await call('lead', 'review_start', 'TEST-goal-review-second-start');
  const secondCycle = (second.result as { reviewRequestId: string }).reviewRequestId;
  assert.equal(typeof secondCycle, 'string');
  assert.notEqual(secondCycle, firstCycle);
  const stale = await f.tool('lead', 'review_complete', {
    commandId: 'TEST-goal-review-stale-cycle', taskId, expectedReviewRequestId: firstCycle,
  }) as CommandReceipt;
  assert.notEqual(stale.phase, 'completed', 'the prior rejected cycle cannot accept the repaired work');
  const agentApproval = await f.tool('lead', 'review_approve', {
    commandId: 'TEST-goal-review-native-final', taskId,
  }) as CommandReceipt;
  assert.notEqual(agentApproval.phase, 'completed', 'native lead cannot impersonate the required human approval');
  await call('lead', 'review_complete', 'TEST-goal-review-second-complete', {
    expectedReviewRequestId: secondCycle,
  });
  assert.equal((await task()).status, 'completed');
  assert.equal((await task()).reviewState, 'reviewed');
  assert.deepEqual(await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-goal-review-human-pending', result: 'TEST required human approval is still pending',
  }), { error: { code: 'hold' } });
  f.session('worker').finish(1);
  await eventually(() => f.runtime('worker')?.inputs[1]?.terminal === 'succeeded', 'actual repair input settles');

  // Drain only already published canonical notifications, never future automatic goal work.
  const originalLeadIds = new Set(f.teamStore.fenced(() => f.teamStore.list<DeliveryIntent>('outbox')
    .filter(intent => intent.binding.memberId === 'lead-id').map(intent => intent.inputId)));
  const finished = new Set<string>();
  await eventually(() => {
    const inputs = f.runtime('lead')!.inputs;
    for (const [index, submitted] of f.session().submits.entries()) {
      const input = inputs.find(row => row.intent.inputId === submitted.inputId);
      if (originalLeadIds.has(submitted.inputId) && input?.phase === 'consumed' && !finished.has(submitted.inputId)) {
        finished.add(submitted.inputId);
        f.session().finish(index);
      }
    }
    return [...originalLeadIds].every(id => inputs.some(row => row.intent.inputId === id &&
      ['terminal', 'cancelled', 'rejected', 'not-sent'].includes(row.phase)));
  }, 'original task review notifications settle without inventing more verification work');
  await eventually(() => /human.*approval|approval.*human/iu.test(f.goal()?.reason ?? ''),
    'required human decision becomes visible Attention');
  const leadCount = f.session().submits.length, workerCount = f.session('worker').submits.length;
  const attempts = Object.keys(f.goal()!.debits).length;
  for (let read = 0; read < 3; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session().submits.length, leadCount, 'human approval wait spends no verification input');
  assert.equal(f.session('worker').submits.length, workerCount);
  assert.equal(Object.keys(f.goal()!.debits).length, attempts);
  assert.notEqual(f.goal()!.published, true);

  const accepted = success<CommandReceipt>(await f.rpc('team.execute', {
    operation: 'task.review', payload: { taskId, action: 'approve' },
  }, 'TEST-goal-review-human-approve'));
  assert.equal(accepted.phase, 'completed');
  assert.equal((await task()).reviewState, 'approved');
  await eventually(() => f.session().submits.length === leadCount + 1,
    'actual human acceptance wakes one fresh original lead verification input');
  const finalIndex = f.session().submits.length - 1;
  assert.equal(originalLeadIds.has(f.session().submits[finalIndex]!.inputId), false);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-goal-review-final', result: 'TEST original task repaired, re-reviewed and human-approved',
  }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(finalIndex);
  await eventually(() => f.goal()?.published === true, 'final publication follows the original fresh verification terminal');
  const current = await task();
  assert.equal(current.id, taskId, 'review and repair never replace the scoped task');
  assert.equal(current.historyEvents?.filter(event => event.type === 'human_approved' && event.actor === 'user').length, 1);
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});
