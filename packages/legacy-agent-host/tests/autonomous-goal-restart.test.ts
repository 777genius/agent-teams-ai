import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('a fresh configured Restart cannot resume an original charged goal', async t => {
  const f = await goalHost(t, { solo: true });
  const initial = success<{ launchId: string; rosterRevision: string }>(await f.rpc('team.launch.read', {}));
  success(await f.rpc('team.launch.start', {
    launchId: initial.launchId, rosterRevision: initial.rosterRevision,
    configuration: { members: [{ memberId: 'lead-id', model: 'TEST-goal-selected-restart' }] },
  }, 'TEST-goal-configured-start'));
  await eventually(() => f.opens() === 1 && f.session().ready, 'the configured original member is ready');
  assert.equal(f.contexts.get('lead')!.profile.model, 'TEST-goal-selected-restart');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: {
    to: 'lead', text: 'TEST preserve the original unfinished objective through an offered Resume',
    actionMode: 'do', autonomousGoal: { durationHours: 12, maxAttempts: 8 },
  } }, 'TEST-goal-before-restart'));
  const original = f.session(), originalBinding = structuredClone(f.contexts.get('lead')!.endpoint.binding);
  await eventually(() => original.submits.length === 1, 'the original objective starts');
  original.finish(0);
  await eventually(() => original.submits.length === 2, 'one real charged continuation starts');
  const before = f.goal()!;
  assert.equal(Object.keys(before.debits).length, 1);
  success(await f.rpc('team.goal.control', {
    goalId: before.goalId, expectedRevision: before.revision, action: 'stop',
  }, 'TEST-goal-stop-before-restart'));
  original.finish(1);
  await eventually(() => f.runtime('lead')!.inputs.at(-1)?.terminal === 'succeeded',
    'the charged original settles before Restart');
  const launch = success<{ launchId: string; rosterRevision: string }>(await f.rpc('team.launch.read', {}));
  const action = { launchId: launch.launchId, rosterRevision: launch.rosterRevision,
    memberId: 'lead-id', expectedGeneration: originalBinding.generation, action: 'restart' };
  for (const operation of ['prepare', 'execute'])
    success(await f.rpc('team.member.action.' + operation, action, 'TEST-goal-fresh-restart'));
  await eventually(() => f.opens() === 2 && f.session() !== original && f.session().ready,
    'configured Restart publishes its actual new ready generation');
  const successorBinding = f.contexts.get('lead')!.endpoint.binding;
  assert.notEqual(successorBinding.generation, originalBinding.generation);
  const successor = f.runtimeStore.fenced(successorBinding, tx => tx.get());
  assert.equal(successor?.restoredFrom, undefined, 'a fresh Restart is not checkpoint Restore');
  assert.equal(f.runtime('lead')!.phase, 'closed');
  assert.equal(f.runtime('lead')!.custody, 'released');
  assert.equal(f.session().submits.length, 0, 'Restart never replays an original input');
  assert.equal(f.goal()!.goalId, before.goalId);
  assert.equal(f.goal()!.deadlineAt, before.deadlineAt);
  assert.deepEqual(f.goal()!.debits, before.debits);
  const stopped = structuredClone(f.goal()!);
  assert.equal(stopped.disposition, 'stopped');
  const snapshot = success<{ autonomousGoal: GoalStatus }>(await f.rpc('team.snapshot', {}));
  assert.equal(snapshot.autonomousGoal.canResume, false, 'a fresh Restart is outside the original Restore lineage');
  assert.deepEqual(await f.rpc('team.goal.control', {
    goalId: before.goalId, expectedRevision: before.revision, action: 'resume',
  }, 'TEST-resume-after-fresh-restart'), { ok: false, code: 'hold', outcome: 'unknown' });
  assert.deepEqual(f.goal(), stopped, 'refused Resume preserves the original goal, deadline, debit and controls');
  assert.equal(f.runtimeStore.fenced(successorBinding, tx => tx.get()?.inputs.length), 0);
  assert.equal(f.session().submits.length, 0, 'a fresh Restart receives no adopted goal input');
  assert.equal(original.submits.length, 2, 'the historical Session never receives replacement work');
});

test('an active goal cannot adopt a fresh configured lead Restart before its next automatic claim', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const f = await goalHost(t, { solo: true });
  const initial = success<{ launchId: string; rosterRevision: string }>(await f.rpc('team.launch.read', {}));
  success(await f.rpc('team.launch.start', {
    launchId: initial.launchId, rosterRevision: initial.rosterRevision,
    configuration: { members: [{ memberId: 'lead-id', model: 'TEST-goal-active-restart' }] },
  }, 'TEST-active-goal-configured-start'));
  await eventually(() => f.opens() === 1 && f.session().ready, 'the configured original is ready');
  t.mock.timers.tick(60_000);
  success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
  for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  success(await f.rpc('team.execute', { operation: 'message.send', payload: {
    to: 'lead', text: 'TEST keep this unfinished objective on its original execution',
    actionMode: 'do', autonomousGoal: { durationHours: 12, maxAttempts: 8 },
  } }, 'TEST-active-goal-before-restart'));
  const original = f.session(), originalBinding = structuredClone(f.contexts.get('lead')!.endpoint.binding);
  await eventually(() => original.submits.length === 1, 'the original goal input starts');
  success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
  for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  // A real terminal can arrive before its progress hint or the next periodic wake.
  original.notifyProgress = false;
  original.finish(0);
  await eventually(() => f.runtime('lead')!.inputs[0]?.terminal === 'succeeded',
    'the original settled input is durable before the configured action');
  const before = structuredClone(f.goal()!);
  assert.equal(before.disposition, 'active');
  assert.deepEqual(before.debits, {});
  assert.equal(original.submits.length, 1);
  const launch = success<{ launchId: string; rosterRevision: string }>(await f.rpc('team.launch.read', {}));
  const action = { launchId: launch.launchId, rosterRevision: launch.rosterRevision,
    memberId: 'lead-id', expectedGeneration: originalBinding.generation, action: 'restart' };
  for (const operation of ['prepare', 'execute'])
    success(await f.rpc('team.member.action.' + operation, action, 'TEST-active-goal-fresh-restart'));
  await eventually(() => f.opens() === 2 && f.session() !== original && f.session().ready,
    'the same configured action opens its actual fresh successor');
  const successorBinding = f.contexts.get('lead')!.endpoint.binding;
  assert.notEqual(successorBinding.generation, originalBinding.generation);
  assert.equal(f.runtimeStore.fenced(successorBinding, tx => tx.get()?.restoredFrom), undefined);
  assert.equal(f.runtime('lead')!.phase, 'closed');
  assert.equal(f.runtime('lead')!.custody, 'released');
  assert.equal(f.runtime('lead')!.inputs[0]?.terminal, 'succeeded');
  // The public dispatch route waits for the existing Goal pump and this exact member's claim.
  success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
  assert.equal(f.session().submits.length, 0,
    'automatic goal work must not move to a fresh Restart without the original Restore lineage');
  assert.equal(f.runtimeStore.fenced(successorBinding, tx => tx.get()?.inputs.length), 0);
  assert.equal(f.goal()!.goalId, before.goalId);
  assert.equal(f.goal()!.deadlineAt, before.deadlineAt);
  assert.deepEqual(f.goal()!.debits, before.debits);
  assert.equal(original.submits.length, 1, 'no original native input is replayed');
});

test('a canonical task notification from the original worker cannot claim a fresh restarted goal lead', async t => {
  const f = await goalHost(t);
  const initial = success<{ launchId: string; rosterRevision: string }>(await f.rpc('team.launch.read', {}));
  success(await f.rpc('team.launch.start', {
    launchId: initial.launchId, rosterRevision: initial.rosterRevision,
    configuration: { members: [{ memberId: 'lead-id', model: 'TEST-goal-notification-restart' }] },
  }, 'TEST-notification-configured-start'));
  await eventually(() => f.opens() === 2 && f.session().ready && f.session('worker').ready,
    'the configured lead and independent original worker are ready');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: {
    to: 'lead', text: 'TEST finish the original delegated objective without adopting another lead',
    actionMode: 'delegate', autonomousGoal: { durationHours: 12, maxAttempts: 8 },
  } }, 'TEST-notification-original-goal'));
  const original = f.session(), originalBinding = structuredClone(f.contexts.get('lead')!.endpoint.binding);
  await eventually(() => original.submits.length === 1, 'original lead receives its goal');
  const task = await f.tool('lead', 'task_create', { commandId: 'TEST-original-worker-task',
    subject: 'TEST independent worker obligation', owner: 'worker' }) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  await eventually(() => f.session('worker').submits.length === 1, 'the original worker owns a real goal input');
  const before = structuredClone(f.goal()!);
  assert.equal(before.disposition, 'active');
  const launch = success<{ launchId: string; rosterRevision: string }>(await f.rpc('team.launch.read', {}));
  const action = { launchId: launch.launchId, rosterRevision: launch.rosterRevision,
    memberId: 'lead-id', expectedGeneration: originalBinding.generation, action: 'restart' };
  for (const operation of ['prepare', 'execute'])
    success(await f.rpc('team.member.action.' + operation, action, 'TEST-notification-fresh-restart'));
  await eventually(() => f.opens() === 3 && f.session() !== original && f.session().ready,
    'only the configured lead moves to its actual fresh generation');
  const successorBinding = f.contexts.get('lead')!.endpoint.binding;
  assert.equal(f.runtimeStore.fenced(successorBinding, tx => tx.get()?.restoredFrom), undefined);
  assert.equal(f.runtime('lead')!.inputs[0]?.phase, 'unknown', 'closure preserves the original active outcome');
  assert.equal(f.session().submits.length, 0);
  const commandId = 'TEST-worker-task-for-fresh-lead';
  const created = await f.tool('worker', 'task_create', { commandId,
    subject: 'TEST original worker asks its lead to verify the result', owner: 'lead' }) as CommandReceipt;
  assert.equal(created.phase, 'completed', 'independent original worker commands remain authorized');
  assert.equal(created.principalId, 'worker-session');
  assert.equal(created.goal?.goalId, before.goalId);
  const notifications = f.teamStore.fenced(() => f.teamStore.list<DeliveryIntent>('outbox'))
    .filter(intent => intent.commandId === commandId && intent.binding.memberId === 'lead-id');
  assert.equal(notifications.length, 1, 'the canonical Task owner produces exactly one original notification');
  assert.equal(notifications[0]!.binding.generation, successorBinding.generation);
  success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
  assert.equal(f.runtimeStore.fenced(successorBinding, tx => tx.get()?.inputs.some(
    input => input.intent.inputId === notifications[0]!.inputId)), false,
  'the existing admission gate rejects goal notification adoption independently of Work Sync');
  assert.equal(f.session().submits.length, 0);
  assert.deepEqual(f.goal()!.debits, before.debits, 'a denied fresh lead receives no automatic debit');
  assert.equal(f.session('worker').submits.length, 1);
  assert.equal(f.runtime('worker')!.inputs[0]?.phase, 'consumed');
  assert.equal((await f.tool('worker', 'task_get', { taskId: created.effects.taskId }) as { owner: string }).owner, 'lead');
});
