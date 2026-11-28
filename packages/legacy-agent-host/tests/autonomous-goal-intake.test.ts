import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('only explicit Do or Delegate to a ready lead may opt in', async t => {
  const f = await goalHost(t); await f.open('lead'); await f.open('worker');
  const payload = { to: 'lead', text: 'TEST bounded objective', autonomousGoal: { durationHours: 1, maxAttempts: 3 } };
  for (const [name, change] of Object.entries({ missingMode: {}, ask: { actionMode: 'ask' },
    teammate: { actionMode: 'do', to: 'worker' }, native: { actionMode: 'do', text: '/cost', nativeCommand: 'cost' } })) {
    const response = await f.rpc('team.execute', { operation: 'message.send', payload: { ...payload, ...change } },
      `TEST-invalid-goal-${name}`) as { ok: boolean };
    assert.equal(response.ok, false, name); assert.equal(f.goal(), undefined);
    assert.equal(f.session().submits.length, 0); assert.equal(f.session('worker').submits.length, 0);
  }
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { ...payload, actionMode: 'do' } }, 'TEST-valid-goal'));
  await eventually(() => f.session().submits.length === 1, 'original explicit Do reaches its lead');
  assert.equal(f.goal()!.rootMode, 'do'); assert.equal(Object.keys(f.goal()!.debits).length, 0);
});
