import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import type { GoalRecord, GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('Stop during finalization suppresses its late publication and explicit Resume requires a fresh original proposal', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST stop before final publication', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-finalizing-stop-intake'));
  await eventually(() => f.session().submits.length === 1, 'original goal input starts');
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-finalizing-stop-old', result: 'TEST original result suppressed by Stop',
  }) as GoalStatus).disposition, 'finalizing');
  const oldResultId = f.goal()!.proposal!.resultMessageId;
  const originalGoal = f.goal()!;
  const stop = { goalId: originalGoal.goalId, expectedRevision: originalGoal.revision, action: 'stop' };
  const stopped = success<GoalStatus>(await f.rpc('team.goal.control', stop, 'TEST-finalizing-stop'));
  assert.equal(stopped.disposition, 'stopped');
  assert.deepEqual(success(await f.rpc('team.goal.control', stop, 'TEST-finalizing-stop')), stopped);
  f.session().finish(0);
  await eventually(() => f.runtime('lead')?.inputs[0]?.terminal === 'succeeded', 'original proposer settles after Stop');
  assert.notEqual(f.goal()!.published, true);
  assert.equal(f.session().submits.length, 1);
  const current = f.goal()!;
  success(await f.rpc('team.goal.control', { goalId: current.goalId,
    expectedRevision: current.revision, action: 'resume' }, 'TEST-finalizing-resume'));
  await eventually(() => f.session().submits.length === 2, 'explicit Resume creates one fresh verification input');
  assert.equal(f.goal()!.goalId, originalGoal.goalId);
  assert.equal(f.goal()!.proposal, undefined);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-finalizing-stop-new', result: 'TEST fresh result after explicit Resume',
  }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(1);
  await eventually(() => f.goal()?.published === true, 'fresh proposal finishes after its original terminal');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === oldResultId).length, 0);
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});

test('observed expiry survives wall-clock rollback and only explicit extension reopens attempts while a produced result may finish', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST bounded work across a wall-clock rollback', actionMode: 'do',
    autonomousGoal: { durationHours: 1, maxAttempts: 8 } } }, 'TEST-clock-intake'));
  await eventually(() => f.session().submits.length === 1, 'original input begins within the deadline');
  t.mock.timers.tick(60 * 60_000 + 1);
  f.contexts.get('lead')!.onProgress();
  await eventually(() => f.goal()?.deadlineReached === true, 'the production pump durably observes original expiry');
  t.mock.timers.setTime(Date.parse('2026-11-27T12:30:00.000Z'));
  f.session().finish(0);
  await eventually(() => f.runtime('lead')?.inputs[0]?.terminal === 'succeeded', 'original input settles after clock rollback');
  for (let read = 0; read < 3; read++) {
    const status = success<{ autonomousGoal: GoalStatus }>(await f.rpc('team.snapshot', {})).autonomousGoal;
    assert.equal(status.reason, 'deadline-reached');
  }
  assert.equal(f.goal()!.deadlineReached, true);
  assert.equal(f.session().submits.length, 1, 'clock rollback cannot silently reopen authorization');
  const current = f.goal()!;
  const extension = { goalId: current.goalId, expectedRevision: current.revision,
    action: 'extend', deadlineAt: '2026-11-27T14:30:00.000Z' };
  const extended = success<GoalStatus>(await f.rpc('team.goal.control', extension, 'TEST-clock-extend'));
  assert.deepEqual(success(await f.rpc('team.goal.control', extension, 'TEST-clock-extend')), extended);
  await eventually(() => f.session().submits.length === 2, 'explicit future deadline permits one new original attempt');
  assert.notEqual(f.goal()!.deadlineReached, true);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-clock-final', result: 'TEST result produced before the extended deadline',
  }) as GoalStatus).disposition, 'finalizing');
  const attempts = Object.keys(f.goal()!.debits).length;
  t.mock.timers.setTime(Date.parse('2026-11-27T14:30:00.001Z'));
  f.session().finish(1);
  await eventually(() => f.goal()?.published === true, 'expiry cannot discard an already produced quiescent final result');
  assert.equal(Object.keys(f.goal()!.debits).length, attempts);
  assert.equal(f.session().submits.length, 2);
});

test('Stop retires an admitted automatic head without refunding its debit or stranding ordinary user input', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST stop an admitted but unclaimed continuation', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-queued-stop-intake'));
  await eventually(() => f.session().submits.length === 1, 'original intake starts');
  const originalWrite = TeamOwnerStore.prototype.write;
  const originalGoalId = f.goal()!.goalId;
  let blocked = false;
  t.mock.method(TeamOwnerStore.prototype, 'write', function(this: TeamOwnerStore, name: string, value: unknown) {
    originalWrite.call(this, name, value);
    const state = value as { autonomousGoal?: GoalRecord };
    if (!blocked && this.directory === f.teamStore.directory && name === 'state.json' &&
        state.autonomousGoal?.goalId === originalGoalId && Object.keys(state.autonomousGoal.debits).length === 1) {
      blocked = true;
      f.session().ready = false;
    }
  });
  f.session().finish(0);
  await eventually(() => f.runtime('lead')?.inputs[1]?.phase === 'admitted',
    'real admission persists before the controlled provider becomes unready');
  assert.equal(f.session().submits.length, 1);
  const queuedId = f.runtime('lead')!.inputs[1]!.intent.inputId;
  const debit = structuredClone(f.goal()!.debits[queuedId]);
  assert.ok(debit);
  const current = f.goal()!;
  success(await f.rpc('team.goal.control', { goalId: current.goalId,
    expectedRevision: current.revision, action: 'stop' }, 'TEST-queued-stop-control'));
  f.session().ready = true;
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST independent ordinary question after stopped queue', actionMode: 'ask' } }, 'TEST-queued-stop-ordinary'));
  await eventually(() => f.session().submits.length === 2, 'ordinary user input passes the retired automatic head');
  assert.match(f.session().submits[1]!.content, /TEST independent ordinary question/u);
  assert.notEqual(f.session().submits[1]!.inputId, queuedId);
  assert.ok(['cancelled', 'not-sent', 'rejected'].includes(f.runtime('lead')!.inputs[1]!.phase));
  assert.deepEqual(f.goal()!.debits[queuedId], debit);
  f.session().finish(1);
  await eventually(() => f.runtime('lead')!.inputs.find(row => row.intent.inputId === f.session().submits[1]!.inputId)?.terminal === 'succeeded',
    'ordinary input settles without resuming the goal');
  assert.equal(f.goal()!.disposition, 'stopped');
  assert.notEqual(f.goal()!.published, true);
});

test('Stop preserves a queued original human Goal intake and Resume continues from that same settled input', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST ordinary work already occupying the lead', actionMode: 'ask' } }, 'TEST-intake-stop-ordinary'));
  await eventually(() => f.runtime('lead')?.inputs[0]?.phase === 'consumed', 'ordinary human input is active');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST original human objective queued behind ordinary work', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-intake-stop-goal'));
  await eventually(() => f.runtime('lead')?.inputs[1]?.phase === 'admitted', 'original Goal intake is durably queued');
  const original = structuredClone(f.runtime('lead')!.inputs[1]!);
  const originalGoal = structuredClone(f.goal()!);
  assert.deepEqual(originalGoal.rootBinding, f.runtimeBinding('lead'));
  assert.equal(f.session().submits.length, 1, 'the active ordinary input is not preempted');
  assert.deepEqual(originalGoal.debits, {});
  const stopped = success<GoalStatus>(await f.rpc('team.goal.control', {
    goalId: originalGoal.goalId, expectedRevision: originalGoal.revision, action: 'stop',
  }, 'TEST-intake-stop-control'));
  assert.equal(stopped.disposition, 'stopped');
  f.session().finish(0);
  await eventually(() => ['consumed', 'rejected', 'cancelled', 'not-sent'].includes(
    f.runtime('lead')!.inputs.find(row => row.intent.inputId === original.intent.inputId)!.phase),
  'the original queued intake reaches its original dispatch decision');
  const dispatched = f.runtime('lead')!.inputs.find(row => row.intent.inputId === original.intent.inputId)!;
  assert.equal(dispatched.phase, 'consumed', 'Stop continuation must not irreversibly reject the original human request');
  assert.deepEqual(dispatched.intent, original.intent);
  assert.equal(dispatched.fingerprint, original.fingerprint);
  assert.equal(dispatched.operationRef, original.operationRef);
  assert.equal(f.session().submits.length, 2);
  assert.equal(f.session().submits[1]!.inputId, original.intent.inputId);
  assert.equal(f.session().submits[1]!.operationRef, original.operationRef);
  assert.deepEqual(f.goal()!.debits, {}, 'the original human request is not an automatic attempt');
  assert.equal(f.goal()!.disposition, 'stopped');
  f.session().finish(1);
  await eventually(() => f.runtime('lead')!.inputs.find(row => row.intent.inputId === original.intent.inputId)?.terminal === 'succeeded',
    'the same original human input settles while continuation is stopped');
  for (let read = 0; read < 3; read++) {
    const status = success<{ autonomousGoal: GoalStatus }>(await f.rpc('team.snapshot', {})).autonomousGoal;
    assert.equal(status.disposition, 'stopped');
  }
  assert.equal(f.session().submits.length, 2, 'Stop still prevents automatic continuation');
  assert.equal(f.session('worker').submits.length, 0);
  assert.deepEqual(f.goal()!.debits, {});
  assert.notEqual(f.goal()!.published, true);
  const resumed = success<GoalStatus>(await f.rpc('team.goal.control', {
    goalId: originalGoal.goalId, expectedRevision: originalGoal.revision, action: 'resume',
  }, 'TEST-intake-stop-resume'));
  assert.equal(resumed.disposition, 'active');
  await eventually(() => f.session().submits.length === 3, 'Resume continues from the successful original Goal input');
  assert.equal(f.goal()!.goalId, originalGoal.goalId);
  assert.equal(f.goal()!.revision, originalGoal.revision);
  assert.deepEqual(f.goal()!.rootBinding, originalGoal.rootBinding);
  assert.equal(f.session().submits.filter(input => input.inputId === original.intent.inputId).length, 1);
  assert.deepEqual(Object.keys(f.goal()!.debits), [f.session().submits[2]!.inputId]);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-intake-stop-result', result: 'TEST original queued objective completed after Resume',
  }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(2);
  await eventually(() => f.goal()?.published === true, 'one fresh result publishes after the resumed input settles');
  assert.equal(f.session().submits.length, 3);
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});
