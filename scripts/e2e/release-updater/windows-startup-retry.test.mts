import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lastSelectedStartupProbes,
  retryCompletedSelectedDotnetCrash,
  runStartupProbeAttempts,
} from './windows-startup-retry.mts';
import type { StartupProbeAttempt, StartupProbeResult } from './windows-startup-retry.mts';

// Authenticated W11 ARM selected-ps7 dotnet-file receipt: script completed, CLR crashed at exit.
const crash: StartupProbeResult = {
  variant: 'selected-ps7',
  probe: 'dotnet-file',
  pid: 1592,
  elapsedMs: 518,
  code: 3221225477,
  signal: null,
  killed: false,
  stdout: '{"scope":"startup-only","value":17}\r\n',
  stderr: 'Fatal error.\r\nInternal CLR error. (0x80131506)\r\n',
  error: 'Command failed: selected installed PS7',
  phases: ['script-entry', 'complete'],
  startupHealthy: false,
  processClosed: true,
};
const healthy: StartupProbeResult = {
  ...crash,
  pid: 1593,
  code: 0,
  stderr: '',
  error: null,
  startupHealthy: true,
};
void test('full selected health requires final results of all three probes while retaining failed attempts', () => {
  const history: StartupProbeAttempt[] = [
    { ...healthy, probe: 'command-entry', attempt: 1 },
    { ...crash, attempt: 1 },
    { ...healthy, attempt: 2 },
    { ...healthy, probe: 'cmdlet-discovery', attempt: 1 },
    { ...crash, variant: 'current-minimal', attempt: 1 },
  ];
  const final = lastSelectedStartupProbes(history);
  assert.deepEqual(
    final.map((item) => item.probe),
    ['command-entry', 'dotnet-file', 'cmdlet-discovery']
  );
  assert(final.every((item) => item.startupHealthy));
  assert.equal(final.find((item) => item.probe === 'dotnet-file')?.attempt, 2);
  assert.equal(history.length, 5);
  assert.equal(history[1]?.startupHealthy, false);
  const discovery = history.find((item) => item.probe === 'cmdlet-discovery');
  assert(discovery);
  discovery.startupHealthy = false;
  assert.equal(
    lastSelectedStartupProbes(history).every((item) => item.startupHealthy),
    false
  );
});
void test('actual completed CLR crash retries once only after its closed attempt is persisted', async () => {
  const saved: StartupProbeAttempt[] = [];
  const calls: number[] = [];
  const attempts = await runStartupProbeAttempts(
    (attempt) => {
      if (attempt === 2) assert.equal(saved.length, 1);
      calls.push(attempt);
      return Promise.resolve(attempt === 1 ? crash : healthy);
    },
    (attempt) => {
      saved.push(structuredClone(attempt));
      return Promise.resolve();
    }
  );
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(
    saved.map((item) => item.attempt),
    [1, 2]
  );
  assert.equal(attempts[0]?.startupHealthy, false);
  assert.equal(attempts.at(-1)?.startupHealthy, true);
  assert.equal(saved[0]?.code, 3221225477);
  assert.equal(saved[0]?.stderr, crash.stderr);
});
for (const [name, change] of Object.entries({
  'unclosed process': { processClosed: false },
  'missing PID': { pid: null },
  'PS5 baseline': { variant: 'test-profile' },
  'cmdlet probe': { probe: 'cmdlet-discovery' },
  'command entry': { probe: 'command-entry' },
  'unknown exit': { code: 1 },
  'string exit': { code: '3221225477' },
  signal: { signal: 'SIGTERM' },
  'timeout/kill': { killed: true },
  'deadline reached': { elapsedMs: 20_000 },
  'incomplete script': { phases: ['script-entry'] },
  'different stdout': { stdout: 'unexpected' },
  'different fatal error': { stderr: 'Fatal error. Other crash' },
  'unexpected stderr': { stderr: crash.stderr + 'other error' },
})) {
  void test(`startup retry rejects ${name}`, async () => {
    const observed = { ...crash, ...change };
    assert.equal(retryCompletedSelectedDotnetCrash(observed), false);
    let calls = 0;
    const attempts = await runStartupProbeAttempts(
      () => {
        calls++;
        return Promise.resolve(observed);
      },
      () => Promise.resolve()
    );
    assert.equal(calls, 1);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.startupHealthy, false);
  });
}
void test('healthy probe stays single-shot and repeated recognized crashes never obtain a third attempt', async () => {
  let calls = 0;
  const success = await runStartupProbeAttempts(
    () => {
      calls++;
      return Promise.resolve(healthy);
    },
    () => Promise.resolve()
  );
  assert.equal(calls, 1);
  assert.equal(success.at(-1)?.startupHealthy, true);
  calls = 0;
  const failed = await runStartupProbeAttempts(
    () => {
      calls++;
      return Promise.resolve(crash);
    },
    () => Promise.resolve()
  );
  assert.equal(calls, 2);
  assert.equal(failed.length, 2);
  assert.equal(failed.at(-1)?.startupHealthy, false);
});
void test('failed attempt persistence blocks retry rather than discarding the original failure', async () => {
  let calls = 0;
  await assert.rejects(
    runStartupProbeAttempts(
      () => {
        calls++;
        return Promise.resolve(crash);
      },
      () => Promise.reject(new Error('TEST evidence write failed'))
    ),
    /TEST evidence write failed/u
  );
  assert.equal(calls, 1);
});
