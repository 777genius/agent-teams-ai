import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  certifyWindowsCaptureRace,
  certifiedWindowsCaptureRetry,
  WindowsCaptureBeforePixelsRace,
} from './windows-native.mts';

// Actual E5 ARM native-545 input and final capture-focus record, reduced to certification fields.
const owner = {
  pid: 1004,
  parent: 880,
  executable: 'C:\\TEST\\install\\AgentTeamsAI.exe',
  command: '"C:\\TEST\\install\\AgentTeamsAI.exe" --updated',
  start: '2026-10-08T19:06:55.3180830Z',
  sid: 'S-1-5-21-3434829844-2332801152-586023220-500',
  session: 2,
};
const input = { ...owner, diagnosticOnly: false };
const result = {
  operation: 'capture',
  code: 1,
  killed: false,
  signal: null,
  stderr:
    'native.ps1: Exception calling "Capture" with "11" argument(s): "Owned foreground changed before pixels"',
};
const geometry = { hwnd: '60092', pid: 1004, thread: 10176 };
const focus = {
  synchronizationSucceeded: true,
  desiredHwnd: '60092',
  foregroundHwnd: '60092',
  desiredPid: 1004,
  foregroundPid: 1004,
  desiredThread: 10176,
  foregroundThread: 10176,
  ownedGeometry: geometry,
  foregroundGeometry: geometry,
};
const progress = (details = focus) =>
  JSON.stringify({ operation: 'capture', phase: 'capture-focus', details });
const proof = certifyWindowsCaptureRace(input, result, progress(), 'native-545.result.json');
assert(proof);
const race = () => new WindowsCaptureBeforePixelsRace(proof);

await test('actual 545 focus race qualifies; 535 process observation and uncertain capture do not', () => {
  assert.equal(proof.hwnd, '60092');
  for (const mutation of [
    { operation: 'processes', code: null },
    { killed: true },
    { signal: 'SIGTERM' },
    { code: 0 },
    { stderr: 'Owned foreground changed during pixels' },
  ])
    assert.equal(
      certifyWindowsCaptureRace(input, { ...result, ...mutation }, progress(), 'failed'),
      null
    );
  for (const mutation of [
    { synchronizationSucceeded: false },
    { foregroundPid: 7972 },
    { foregroundHwnd: '123' },
    { desiredThread: 0 },
    { foregroundGeometry: { ...geometry, pid: 7972 } },
  ])
    assert.equal(
      certifyWindowsCaptureRace(input, result, progress({ ...focus, ...mutation }), 'failed'),
      null
    );
  for (const text of [
    'invalid',
    'null\n' + progress(),
    JSON.stringify({ phase: 'capture-focus', details: focus }),
  ])
    assert.equal(certifyWindowsCaptureRace(input, result, text, 'failed'), null);
});
await test('certified transient retries original owned capture and returns only new stable pixels', async () => {
  let calls = 0,
    checks = 0;
  const failures: number[] = [];
  const capture = certifiedWindowsCaptureRetry(
    owner,
    () => (++calls === 1 ? Promise.reject(race()) : Promise.resolve('new-stable-frame')),
    () => {
      checks++;
      return Promise.resolve({ ...owner });
    },
    (_error, count) => {
      failures.push(count);
      return Promise.resolve();
    },
    45,
    () => 1
  );
  assert.equal(await capture(), 'new-stable-frame');
  assert.equal(calls, 2);
  assert.equal(checks, 1);
  assert.deepEqual(failures, [1]);
});
await test('persistent race stops at three; ownership/deadline/other errors never repeat', async () => {
  let calls = 0;
  const counts: number[] = [];
  const capture = certifiedWindowsCaptureRetry(
    owner,
    () => {
      calls++;
      return Promise.reject(race());
    },
    () => Promise.resolve(owner),
    (_error, count) => {
      counts.push(count);
      return Promise.resolve();
    },
    45,
    () => 1
  );
  await assert.rejects(capture());
  assert.equal(calls, 3);
  assert.deepEqual(counts, [1, 2, 3]);
  for (const change of [
    { start: 'reused' },
    { pid: 7972 },
    { executable: 'foreign.exe' },
    { sid: 'foreign' },
    { session: 3 },
    { parent: 999 },
    { command: 'foreign' },
  ]) {
    calls = 0;
    await assert.rejects(
      certifiedWindowsCaptureRetry(
        owner,
        () => {
          calls++;
          return Promise.reject(race());
        },
        () => Promise.resolve({ ...owner, ...change }),
        () => Promise.resolve(),
        45,
        () => 1
      )()
    );
    assert.equal(calls, 1);
  }
  for (const error of [
    new Error(result.stderr),
    new WindowsCaptureBeforePixelsRace({ ...proof, owner: { ...owner, start: 'reused' } }),
  ]) {
    calls = 0;
    await assert.rejects(
      certifiedWindowsCaptureRetry(
        owner,
        () => {
          calls++;
          return Promise.reject(error);
        },
        () => Promise.resolve(owner),
        () => Promise.resolve(),
        45,
        () => 1
      )()
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(
    certifiedWindowsCaptureRetry(
      owner,
      () => {
        calls++;
        return Promise.resolve('stale');
      },
      () => Promise.resolve(owner),
      () => Promise.resolve(),
      45,
      () => 45
    )()
  );
  assert.equal(calls, 0);
});
