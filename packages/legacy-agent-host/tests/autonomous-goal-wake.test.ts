import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('the existing Work Sync timer dispatches a continuation after a lost native progress hint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const f = await goalHost(t);
  await f.open('lead'); await f.open('worker');
  // Exclude the one-shot launch timeout hint from the repeating fallback proof.
  t.mock.timers.tick(60_000);
  success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
  for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  success(await f.rpc('team.execute', { operation: 'message.send', payload: {
    to: 'lead', text: 'TEST continue after the provider loses only its progress hint', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 4 },
  } }, 'TEST-timer-original-goal'));
  await eventually(() => f.session().submits.length === 1, 'original human input reaches the actual Session');
  success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
  // Drain earlier admission hints. From here only the existing scheduled fallback may dispatch.
  for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  f.session().notifyProgress = false;
  f.session().finish(0);
  await eventually(() => f.runtime('lead')!.inputs[0]!.terminal === 'succeeded',
    'the original native terminal is durably recorded even when the scheduling hint is lost');
  assert.equal(f.session().submits.length, 1);
  assert.deepEqual(f.goal()!.debits, {});
  t.mock.timers.tick(60_000);
  await eventually(() => f.session().submits.length === 2,
    'scheduled goal settlement wakes actual Runtime dispatch without a new user command');
  assert.equal(Object.keys(f.goal()!.debits).length, 1);
  assert.ok(f.goal()!.debits[f.session().submits[1]!.inputId]);
  assert.equal(f.runtime('lead')!.inputs[0]!.terminal, 'succeeded');
  const goal = f.goal()!;
  success(await f.rpc('team.goal.control', { goalId: goal.goalId,
    expectedRevision: goal.revision, action: 'stop' }, 'TEST-timer-cleanup-stop'));
  f.session().notifyProgress = true;
  f.session().finish(1);
});
