import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { deliveryFingerprint } from '../dist/runtime/identity.js';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';
import { captureGoalStopWitness, goalStopInputsSettled } from './fixtures/real-vendor/goal-stop-oracle.ts';

async function activeGoal(t: TestContext) {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST original active Stop qualification input', actionMode: 'do',
    autonomousGoal: { durationHours: 1, maxAttempts: 8 } } }, 'TEST-stop-oracle-intake'));
  await eventually(() => f.runtime('lead')?.inputs[0]?.phase === 'consumed', 'the actual original input is consumed');
  const records = () => ['lead', 'worker'].map(name => {
    const record = f.runtime(name as 'lead' | 'worker');
    assert.ok(record);
    return record;
  });
  const stop = async () => {
    const goal = f.goal()!;
    return success<GoalStatus>(await f.rpc('team.goal.control', {
      goalId: goal.goalId, expectedRevision: goal.revision, action: 'stop',
    }, 'TEST-stop-oracle-control'));
  };
  return { f, records, stop };
}

for (const outcome of ['succeeded', 'failed', 'cancelled', 'unknown'] as const) {
  test(`Stop qualification retains the actual original ${outcome} outcome after confirmed cleanup`, async t => {
    const { f, records, stop } = await activeGoal(t);
    const original = captureGoalStopWitness(records());
    assert.equal(goalStopInputsSettled(original, records()), false, 'an active native input has not settled');
    const stopped = await stop();
    assert.equal(stopped.disposition, 'stopped');
    f.session().finish(0, outcome);
    await eventually(() => outcome === 'unknown' ? f.runtime('lead')?.inputs[0]?.phase === 'unknown'
      : f.runtime('lead')?.inputs[0]?.terminal === outcome, 'the real Runtime stores the paired provider outcome');
    const assertOutcome = () => {
      if (outcome === 'succeeded') assert.equal(goalStopInputsSettled(original, records()), true);
      else assert.throws(() => goalStopInputsSettled(original, records()),
        'a non-success original input cannot qualify Stop');
    };
    assertOutcome();
    for (const memberId of ['lead-id', 'worker-id'])
      success(await f.rpc('runtime.stop', { memberId, expectedGeneration: '1' }));
    assert.ok(records().every(record => record.custody === 'released'));
    assertOutcome();
    assert.equal(f.goal()!.disposition, 'stopped');
    assert.equal(Object.keys(f.goal()!.debits).length, stopped.attemptsUsed);
    assert.notEqual(f.goal()!.published, true);
    assert.equal(f.session().submits.length, 1);
    assert.equal(f.session('worker').submits.length, 0);
  });
}

test('Stop qualification refuses lost, rebound or newly started inputs from otherwise successful original records', async t => {
  const { f, records, stop } = await activeGoal(t);
  const original = captureGoalStopWitness(records());
  await stop();
  f.session().finish(0);
  await eventually(() => f.runtime('lead')?.inputs[0]?.terminal === 'succeeded', 'the original input succeeds');
  const settled = records();
  assert.equal(goalStopInputsSettled(original, settled), true);
  // These are readback fault candidates only; canonical Runtime history is never rewritten.
  const faults: [string, (rows: RuntimeSessionRecord[]) => void][] = [
    ['missing original binding', rows => { rows.shift(); }],
    ['different generation', rows => { rows[0]!.binding.generation = '2'; }],
    ['missing original input', rows => { rows[0]!.inputs = []; }],
    ['rebound operation', rows => { rows[0]!.inputs[0]!.operationRef += '-changed'; }],
    ['rebound fingerprint', rows => { rows[0]!.inputs[0]!.fingerprint = 'f'.repeat(64); }],
    ['new successful claim', rows => {
      const input = structuredClone(rows[0]!.inputs[0]!);
      input.intent.inputId += '-new';
      input.operationRef += '-new';
      input.fingerprint = deliveryFingerprint(input.intent);
      rows[0]!.inputs.push(input);
    }],
  ];
  for (const [label, mutate] of faults) {
    const candidate = structuredClone(settled);
    mutate(candidate);
    assert.throws(() => goalStopInputsSettled(original, candidate), label);
  }
  assert.equal(goalStopInputsSettled(original, records()), true);
});

test('Stop qualification rejects a different originally admitted input that becomes unknown without successful model work', async t => {
  const { f, records, stop } = await activeGoal(t);
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'worker',
    text: 'TEST original independent active input', actionMode: 'ask' } }, 'TEST-stop-oracle-worker-active'));
  await eventually(() => f.runtime('worker')?.inputs[0]?.phase === 'consumed', 'the independent original input is active');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'worker',
    text: 'TEST admitted ordinary input used only as negative qualification evidence', actionMode: 'ask' } },
  'TEST-stop-oracle-worker-queued'));
  await eventually(() => f.runtime('worker')?.inputs[1]?.phase === 'admitted', 'the different original input is only admitted');
  const queuedId = f.runtime('worker')!.inputs[1]!.intent.inputId;
  const original = captureGoalStopWitness(records());
  await stop();
  f.session().finish(0);
  f.session('worker').finish(0);
  // The product correctly permits this ordinary human input. A closed-canary
  // proof must still reject it: it is not one of the captured active originals.
  await eventually(() => f.runtime('worker')?.inputs[1]?.phase === 'consumed', 'the ordinary queued input reaches its own submit');
  assert.equal(f.session('worker').submits[1]!.inputId, queuedId);
  f.session('worker').finish(1, 'unknown');
  await eventually(() => f.runtime('worker')?.inputs[1]?.phase === 'unknown', 'the actual paired outcome is unknown');
  assert.throws(() => goalStopInputsSettled(original, records()), /unknown/u);
  for (const memberId of ['lead-id', 'worker-id'])
    success(await f.rpc('runtime.stop', { memberId, expectedGeneration: '1' }));
  assert.ok(records().every(record => record.custody === 'released'));
  assert.throws(() => goalStopInputsSettled(original, records()), /unknown/u);
});
