import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkExecutorIdentity } from './execution-provenance.mts';

const t80 = '80ad7936b6d602c89f712e14771911098277ec44';
const executor = 'b'.repeat(40);

// Red if a dispatched or checked-out executor can be relabeled as plan authority.
void test('separate executor preserves the original T80 plan authority', () => {
  assert.deepEqual(checkExecutorIdentity(t80, executor, executor, executor), {
    toolingSha: t80,
    executionSha: executor,
  });
});
void test('the existing same-head contract remains strict', () => {
  assert.doesNotThrow(() => checkExecutorIdentity(executor, executor, executor, executor));
  assert.throws(() => checkExecutorIdentity(executor, executor, t80, executor));
});
void test('spoofed dispatch head or actual checkout rejects before producer download', () => {
  assert.throws(() => checkExecutorIdentity(t80, executor, t80, executor));
  assert.throws(() => checkExecutorIdentity(t80, executor, executor, t80));
  assert.throws(() => checkExecutorIdentity(t80, executor, undefined, executor));
});
void test('a separate executor cannot select a different plan producer', () => {
  const foreignPlan = 'c'.repeat(40);
  assert.throws(() => checkExecutorIdentity(foreignPlan, executor, executor, executor));
});
void test('execution identity rejects malformed immutable refs', () => {
  assert.throws(() => checkExecutorIdentity(t80, 'main', 'main', 'main'));
});
