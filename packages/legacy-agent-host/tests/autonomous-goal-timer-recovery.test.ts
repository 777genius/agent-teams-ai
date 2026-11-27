import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

for (const boundary of ['goal-state', 'intake-outbox', 'continuation-outbox'] as const) {
  test(`the existing timer recovers the original after a temporary ${boundary} write failure`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-11-27T12:00:00.000Z') });
    const f = await goalHost(t);
    await f.open('lead'); await f.open('worker');
    // The one-shot launch deadlines can also wake the pump. Exhaust them first
    // so a late storage fault is recovered solely by the repeating fallback.
    t.mock.timers.tick(60_000);
    success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
    for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    const commandId = `TEST-timer-recovery-${boundary}`;
    const intake = { operation: 'message.send', payload: { to: 'lead', actionMode: 'do',
      text: `TEST recover the original ${boundary} input without another user event`,
      autonomousGoal: { durationHours: 12, maxAttempts: 3 } } };
    const charged = boundary === 'continuation-outbox';
    if (charged) {
      success(await f.rpc('team.execute', intake, commandId));
      await eventually(() => f.session().submits.length === 1, 'original human input starts');
    }
    const write = TeamOwnerStore.prototype.write;
    let armed = true, faults = 0;
    const fault = t.mock.method(TeamOwnerStore.prototype, 'write', function (this: TeamOwnerStore,
      path: string, value: unknown) {
      const row = value as { commandId?: string; autonomousGoal?: { rootCommandId: string } };
      const selected = boundary === 'goal-state'
        ? path === 'state.json' && row.autonomousGoal?.rootCommandId === commandId
        : path.startsWith('outbox/') && (charged ? row.commandId !== commandId : row.commandId === commandId);
      if (armed && selected) { faults++; throw new Error('TEST temporary original publication failure'); }
      write.call(this, path, value);
    });
    try {
      if (charged) f.session().finish(0);
      else assert.equal((await f.rpc('team.execute', intake, commandId) as { ok: boolean }).ok, false);
      await eventually(() => faults > 0, 'actual original publication reaches the failing storage boundary');
      // Drain the original event-driven pass while storage is still unavailable.
      success(await f.rpc('runtime.dispatch', { memberId: 'lead-id' }));
      for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      const original = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands'))
        .filter(row => charged ? row.goal?.kind === 'continuation' : row.commandId === commandId);
      assert.equal(original.length, 1);
      assert.ok(!['completed', 'rejected'].includes(original[0]!.phase));
      const inputId = original[0]!.effects.deliveryId;
      assert.equal(f.teamStore.fenced(() => f.teamStore.list<DeliveryIntent>('outbox'))
        .some(row => row.inputId === inputId), false);
      assert.equal(f.session().submits.length, charged ? 1 : 0);
      if (boundary === 'goal-state') assert.equal(f.goal(), undefined);
      else assert.deepEqual(f.goal()!.debits, {});

      armed = false; fault.mock.restore();
      // Only the existing scheduled callback runs: no RPC, provider hint or new command.
      t.mock.timers.tick(60_000);
      await eventually(() => f.session().submits.length === (charged ? 2 : 1),
        'the scheduled fallback must resume the exact original receipt after storage recovers');
      const recovered = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands'))
        .filter(row => charged ? row.goal?.kind === 'continuation' : row.commandId === commandId);
      assert.equal(recovered.length, 1); assert.equal(recovered[0]!.phase, 'completed');
      assert.deepEqual(recovered[0]!.effects, original[0]!.effects);
      assert.equal(f.session().submits.at(-1)!.inputId, inputId);
      assert.deepEqual(Object.keys(f.goal()!.debits), charged ? [inputId] : []);
      t.mock.timers.tick(60_000);
      for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.session().submits.length, charged ? 2 : 1, 'a later timer cannot resubmit the active original');
    } finally {
      armed = false; fault.mock.restore();
      // Cleanup may explicitly wake our disposable original even when the assertion fails.
      f.contexts.get('lead')!.onProgress();
      await eventually(() => f.session().submits.length === (charged ? 2 : 1), 'owned original recovers for strict cleanup');
      const goal = f.goal()!;
      success(await f.rpc('team.goal.control', { goalId: goal.goalId,
        expectedRevision: goal.revision, action: 'stop' }, `TEST-cleanup-${boundary}`));
      f.session().finish(charged ? 1 : 0);
    }
  });
}
