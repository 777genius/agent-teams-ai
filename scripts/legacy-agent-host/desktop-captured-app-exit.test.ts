import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { cleanupCapturedDesktopApp } from './desktop-captured-app.ts';

test('requested Quit lets the original child report its natural exit before the cleanup census', {
  skip: process.platform === 'win32' ? 'The original Desktop group observer is POSIX-only' : false,
  timeout: 10_000,
}, async (t) => {
  const app = spawn(process.execPath, ['--input-type=module', '-e', `
    process.send('TEST-ready');
    process.once('message', message => {
      if (message !== 'TEST-original-quit') process.exit(2);
      setTimeout(() => process.exit(0), 450);
    });
  `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(app, 'exit');
  const ready = await once(app, 'message');
  assert.equal(ready[0], 'TEST-ready');
  assert.ok(app.pid);
  const identity = execFileSync('/bin/ps', ['-p', String(app.pid), '-o', 'lstart=,command='], {
    encoding: 'utf8', timeout: 3000,
  }).trim();
  assert.ok(identity.includes('--input-type=module'));
  const signal = t.mock.method(process, 'kill', () => {
    assert.fail('requested natural Quit must be observed without a harness signal');
  });
  const evidence: Record<string, unknown> = { quitRequested: true };
  app.send('TEST-original-quit');
  try {
    const result = await cleanupCapturedDesktopApp({
      app, group: app.pid, fixture: { node: process.execPath, hostEntry: 'TEST-no-host-allocation' },
      evidence, appIdentity: identity, hostPid: undefined, packedRelaunchMode: false,
    });
    assert.equal(result.cleanupFailure, undefined);
    assert.deepEqual(result.remaining, []);
    assert.equal(result.capturedHostAbsent, null, 'this check allocates no Host');
    assert.equal(app.exitCode, 0);
    assert.equal(app.signalCode, null);
    assert.equal(signal.mock.callCount(), 0);
  } finally {
    // The same original child finishes its bounded requested Quit even on a failing check.
    assert.deepEqual(await exited, [0, null]);
  }
});
