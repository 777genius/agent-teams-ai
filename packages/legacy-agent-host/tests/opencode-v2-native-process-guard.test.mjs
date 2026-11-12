import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signalCapturedNativeGroup } from './opencode-v2-native-process-guard.mjs';

for (const [label, captured, observed, alive, expected] of [
  ['missing capture and leader with surviving group', undefined, undefined, [-123], 'unknown'],
  ['missing capture and live leader', undefined, '42', [123, -123], 'unknown'],
  ['reused PID', '41', '42', [123, -123], 'unknown'],
  ['exited leader with surviving group', '42', undefined, [-123], 'unknown'],
  ['absent leader and group without capture', undefined, undefined, [], 'absent'],
  ['absent leader and group after capture', '42', undefined, [], 'absent'],
  ['captured live isolated process', '42', '42', [123, -123], 'signalled'],
]) {
  test(label + ' preserves the native process signal boundary', () => {
    const signals = [];
    const result = signalCapturedNativeGroup(123, captured, {
      readIdentity: () => observed,
      present: pid => alive.includes(pid),
      signal: (...args) => signals.push(args),
    });
    assert.equal(result, expected);
    assert.deepEqual(signals, expected === 'signalled' ? [[-123, 'SIGTERM']] : []);
  });
}

test('unreadable process identity never authorizes a signal', () => {
  let signals = 0;
  assert.throws(() => signalCapturedNativeGroup(123, '42', {
    readIdentity: () => { throw Error('TEST_identity_unreadable'); },
    present: () => true,
    signal: () => signals++,
  }), /TEST_identity_unreadable/);
  assert.equal(signals, 0);
});
