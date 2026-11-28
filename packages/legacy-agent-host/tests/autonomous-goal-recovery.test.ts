import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import type { RuntimeBinding, RuntimeDelivery } from '../dist/runtime/contracts.js';
import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

const intake = (attempts = 3) => ({ operation: 'message.send', payload: { to: 'lead',
  text: 'TEST durable original objective', actionMode: 'do', autonomousGoal: { durationHours: 1, maxAttempts: attempts } } });

for (const point of ['before', 'after'] as const) {
  test(`a failure ${point} the debit write retains one original attempt and its final dispatch`, async t => {
    const f = await goalHost(t); await f.open('lead'); await f.open('worker');
    success(await f.rpc('team.execute', intake(1), `TEST-debit-${point}`));
    await eventually(() => f.session().submits.length === 1, 'original human input starts');
    const write = TeamOwnerStore.prototype.write;
    let armed = true, faults = 0;
    const fault = t.mock.method(TeamOwnerStore.prototype, 'write', function (this: TeamOwnerStore, path: string, value: unknown) {
      const goal = (value as { autonomousGoal?: { debits: Record<string, unknown> } })?.autonomousGoal;
      const selected = armed && path === 'state.json' && goal && Object.keys(goal.debits).length > 0;
      if (selected && point === 'before') { faults++; throw new Error('TEST before debit publication'); }
      write.call(this, path, value);
      if (selected && point === 'after') { faults++; throw new Error('TEST after debit publication'); }
    });
    f.session().finish(0);
    await eventually(() => faults > 0, 'actual admission reaches the original debit write');
    const candidates = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands')).filter(row => row.goal?.kind === 'continuation');
    assert.equal(candidates.length, 1);
    const inputId = candidates[0]!.effects.deliveryId;
    assert.equal(Object.keys(f.goal()!.debits).length, point === 'before' ? 0 : 1);
    armed = false; fault.mock.restore(); f.contexts.get('lead')!.onProgress();
    await eventually(() => f.session().submits.length === 2, 'original last charged input dispatches');
    assert.equal(f.session().submits[1]!.inputId, inputId); assert.deepEqual(Object.keys(f.goal()!.debits), [inputId]);
    f.session().finish(1);
    await eventually(() => f.runtime('lead')!.inputs.find(row => row.intent.inputId === inputId)?.terminal === 'succeeded', 'last attempt settles');
    await f.rpc('team.snapshot', {});
    assert.equal(f.session().submits.length, 2); assert.equal(Object.keys(f.goal()!.debits).length, 1);
  });
}

test('Resume fences a valid admitted input against a delayed original Stop cancellation', async t => {
  const f = await goalHost(t); await f.open('lead'); await f.open('worker');
  success(await f.rpc('team.execute', intake(), 'TEST-cancel-race-intake'));
  await eventually(() => f.session().submits.length === 1, 'human input starts');
  const original = f.session().submits[0]!.inputId, dispatch = RuntimeOwner.prototype.dispatchNext;
  let pauseDispatch = true;
  t.mock.method(RuntimeOwner.prototype, 'dispatchNext', function (this: RuntimeOwner, binding: RuntimeBinding) {
    if (pauseDispatch && binding.memberId === 'lead-id' && f.runtime('lead')?.inputs.some(row =>
      row.phase === 'admitted' && row.intent.inputId !== original)) return Promise.reject(new RuntimeOwnerError('hold'));
    return dispatch.call(this, binding);
  });
  f.session().finish(0);
  await eventually(() => f.runtime('lead')!.inputs.some(row => row.phase === 'admitted'), 'one continuation is admitted');
  const admitted = f.runtime('lead')!.inputs.find(row => row.phase === 'admitted')!, cancel = RuntimeOwner.prototype.cancelDelivery;
  let reached = false, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(RuntimeOwner.prototype, 'cancelDelivery', async function (this: RuntimeOwner,
    intent: RuntimeDelivery, authority?: (commit: () => void) => void) {
    if (intent.inputId === admitted.intent.inputId) { reached = true; await barrier; }
    return cancel.call(this, intent, authority);
  });
  const goal = f.goal()!;
  const stopped = f.rpc('team.goal.control', { goalId: goal.goalId, expectedRevision: goal.revision, action: 'stop' }, 'TEST-cancel-stop');
  await eventually(() => reached, 'cancellation reaches Runtime after Stop');
  success(await f.rpc('team.goal.control', { goalId: goal.goalId, expectedRevision: goal.revision, action: 'resume' }, 'TEST-cancel-resume'));
  release(); success(await stopped);
  assert.equal(f.runtime('lead')!.inputs.find(row => row.intent.inputId === admitted.intent.inputId)!.phase, 'admitted');
  assert.equal(Object.keys(f.goal()!.debits).length, 1);
  pauseDispatch = false; f.contexts.get('lead')!.onProgress();
  await eventually(() => f.session().submits.length === 2, 'resumed original input dispatches once');
  assert.equal(f.session().submits[1]!.inputId, admitted.intent.inputId);
});

test('bounded control retention reserves one original receipt for Stop and its replay', async t => {
  const f = await goalHost(t); await f.open('lead'); await f.open('worker');
  success(await f.rpc('team.execute', intake(), 'TEST-control-cap-intake'));
  const goal = f.goal()!;
  for (let i = 0; i < 255; i++) success(await f.rpc('team.goal.control', {
    goalId: goal.goalId, expectedRevision: goal.revision, action: 'extend', attemptLimit: goal.attemptLimit,
  }, `TEST-control-extension-${i}`));
  assert.equal((await f.rpc('team.goal.control', { goalId: goal.goalId, expectedRevision: goal.revision,
    action: 'extend', attemptLimit: goal.attemptLimit }, 'TEST-control-cap-refused') as { ok: boolean }).ok, false);
  const stop = { goalId: goal.goalId, expectedRevision: goal.revision, action: 'stop' };
  const result = success(await f.rpc('team.goal.control', stop, 'TEST-control-cap-stop'));
  assert.equal(Object.keys(f.goal()!.controls!).length, 256);
  await f.restart();
  assert.deepEqual(success(await f.rpc('team.goal.control', stop, 'TEST-control-cap-stop')), result);
});

for (const boundary of ['prepared-receipt', 'goal-state', 'outbox', 'completed-receipt'] as const) {
  test(`original intake recovers after ${boundary} publication without another request`, async t => {
    const f = await goalHost(t); await f.open('lead'); await f.open('worker');
    const commandId = `TEST-intake-fault-${boundary}`, write = TeamOwnerStore.prototype.write;
    let armed = true, faults = 0;
    const fault = t.mock.method(TeamOwnerStore.prototype, 'write', function (this: TeamOwnerStore, path: string, value: unknown) {
      // Model process loss, not a recoverable live exception: no catch/retry may
      // rewrite the exact durable crash image before the replacement owner opens it.
      if (armed && faults > 0) throw new Error('TEST process stopped after durable publication');
      write.call(this, path, value);
      if (!armed || !value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>, goal = row.autonomousGoal as Record<string, unknown> | undefined;
      const selected = boundary === 'goal-state' ? path === 'state.json' && goal?.rootCommandId === commandId :
        boundary === 'outbox' ? path.startsWith('outbox/') && row.commandId === commandId :
        path.startsWith('commands/') && row.commandId === commandId &&
          row.phase === (boundary === 'prepared-receipt' ? 'prepared' : 'completed');
      if (selected) { faults++; throw new Error('TEST loss immediately after original durable publication'); }
    });
    await f.rpc('team.execute', intake(), commandId);
    assert.ok(faults > 0, 'actual filesystem boundary was reached');
    const before = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands')).find(row => row.commandId === commandId)!;
    assert.ok(before); armed = false; fault.mock.restore();
    await f.restart(boundary === 'outbox' ? 'lead' : undefined);
    const after = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands')).filter(row => row.commandId === commandId);
    assert.equal(after.length, 1); assert.equal(after[0]!.phase, 'completed'); assert.deepEqual(after[0]!.effects, before.effects);
    assert.equal(f.goal()!.rootCommandId, commandId); assert.equal(f.goal()!.goalId, before.goal!.goalId);
    assert.equal(Object.keys(f.goal()!.debits).length, 0);
    const outbox = f.teamStore.fenced(() => f.teamStore.list<DeliveryIntent>('outbox')).filter(row => row.commandId === commandId);
    assert.equal(outbox.length, 1); assert.equal(outbox[0]!.deliveryId, before.effects.deliveryId);
    const repeated = success<CommandReceipt>(await f.rpc('team.execute', intake(), commandId));
    assert.deepEqual(repeated.effects, before.effects);
  });
}
