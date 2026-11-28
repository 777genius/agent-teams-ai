import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandReceipt } from '../dist/team/contracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('one unresolved native submit cannot block an eligible independent member input', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST delegate the bounded worker branch', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-isolation-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input starts');

  let release: (() => void) | undefined;
  f.session('worker').submitAction = input => new Promise(resolve => {
    release = () => resolve({ ok: true, value: { inputId: input.inputId,
      operationRef: input.operationRef, delivery: 'client-consumed', providerAcceptance: 'unknown' } });
  });
  const assignment = f.tool('lead', 'task_create', { commandId: 'TEST-hanging-assignment',
    subject: 'TEST worker native submit remains unresolved', owner: 'worker' });
  void assignment.catch(() => {}); // Its original result is asserted after releasing the TEST transport.
  let independent: Promise<unknown> | undefined;
  try {
    await eventually(() => f.session('worker').submits.length === 1, 'actual original worker handoff is in flight');
    assert.equal(f.runtime('worker')!.inputs[0]!.phase, 'claimed');
    f.session().finish(0);
    independent = f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
      text: 'TEST independent human question while worker transport is unresolved', actionMode: 'ask',
    } }, 'TEST-independent-member-input');
    void independent.catch(() => {});
    await eventually(() => f.session().submits.length === 2,
      'healthy lead original input starts before hung worker submit resolves');
    assert.match(f.session().submits[1]!.content, /independent human question/u);
    assert.equal(f.runtime('worker')!.inputs[0]!.phase, 'claimed', 'isolation never erases ambiguous custody');
    assert.equal(f.session('worker').submits.length, 1, 'hung original is not replayed');
    f.session().finish(1);
    release?.();
    assert.equal((await assignment as CommandReceipt).phase, 'completed', 'original assignment command succeeds');
    assert.equal(success<CommandReceipt>(await independent).phase, 'completed', 'independent human command succeeds');
  } finally {
    release?.();
    const results = await Promise.allSettled([assignment, ...(independent ? [independent] : [])]);
    assert.equal(results.every(result => result.status === 'fulfilled'), true, 'owned disposable pending requests settle for cleanup');
  }
});
