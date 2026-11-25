import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import './desktop-native-quit-command-snapshot.test.mjs';
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

const originalSource = (file: string) => stripTypeScriptTypes(
  readFileSync(new URL(file, import.meta.url), 'utf8'), { mode: 'strip' });
function originalDeclaration(source: string, name: string): string {
  const found = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\b[\\s\\S]*?^}`, 'm'));
  assert.ok(found, `original ${name} declaration`);
  return found[0].replace(/^export /, '');
}

/** Execute the original Launch body, caller options and cleanup body with finite
 * observations. No replacement UI flow, process, signal or native provider exists. */
async function failedLaunchHostHandoff(captureFails: boolean, descendantRemains = false) {
  const source = originalSource('./desktop-launch-ui-smoke.ts');
  const backend = originalSource('./desktop-backend-smoke.ts');
  const call = backend.match(/await runDesktopLaunchUiSmoke\(cdp, \{[\s\S]*?^ {6}\}\);/m)?.[0];
  const cleanupCall = backend.match(/await cleanupCapturedDesktopApp\(\{[^\n]+\}\)/)?.[0];
  assert.ok(call && cleanupCall, 'original caller-to-Launch and finally-to-cleanup handoffs');
  const observations = originalSource('./desktop-backend-observations.ts');
  const capturedApp = originalSource('./desktop-captured-app.ts');
  const group = 8062, host = 9614, descendant = { pid: 8090, ppid: 1, pgid: group };
  const failure = new Error(captureFails ? 'TEST original metadata refusal' : 'TEST original UI refusal');
  const fixture = { root: '/TEST', node: '/TEST/node', hostEntry: '/TEST/host',
    uiSeed: { taskId: 'TEST-task', subject: 'TEST-subject', commandId: 'TEST-command' },
    openCodeV2: { model: 'test-local/TEST-model', displayName: 'TEST-model' } };
  const captured = Object.freeze({ captured: Object.freeze({ host: Object.freeze({ pid: host }) }) });
  const evidence: Record<string, unknown> = { mode: 'native-resume-ui', quitRequested: true };
  const counts = { captures: 0, uiReads: 0, tableReads: 0, commands: 0, signals: 0, cleanup: 0 };
  let now = 0, cleanupInput: Parameters<typeof cleanupCapturedDesktopApp>[0] | undefined;
  const processTable = () => {
    counts.tableReads++;
    return descendantRemains || counts.tableReads === 1 ? [descendant] : [];
  };
  const cleanup = new Function('env', `
    const { assert, Date, tick, setTimeout, processTable, command, process, execFileSync } = env;
    ${originalDeclaration(observations, 'groupMembers')}
    ${originalDeclaration(observations, 'settledGroupMembers')}
    ${originalDeclaration(observations, 'observeExitedAppGroup')}
    ${originalDeclaration(capturedApp, 'cleanupCapturedDesktopApp')}
    return cleanupCapturedDesktopApp;
  `)({ assert, Date: { now: () => now }, tick: async () => { now += 100; },
    setTimeout: (done: () => void, ms: number) => { now += ms; queueMicrotask(done); },
    processTable,
    command: (pid: number) => { counts.commands++; assert.equal(pid, descendant.pid); return '/TEST/esbuild'; },
    process: { kill: () => { counts.signals++; assert.fail('no signal authority after original leader exit'); } },
    execFileSync: () => assert.fail('no new process identity capture or PID adoption'),
  }) as typeof cleanupCapturedDesktopApp;
  const launch = new Function('env', `
    const { assert, join, process, createDesktopUiControls, createDesktopOriginalActionReadTiming,
      captureDesktopOpenCodeGlobalMetadata } = env;
    ${originalDeclaration(source, 'runDesktopLaunchUiSmoke')}
    return runDesktopLaunchUiSmoke;
  `)({ assert, join, process: { env: {} },
    createDesktopUiControls: () => ({ observeInput: async () => { counts.uiReads++; throw failure; } }),
    createDesktopOriginalActionReadTiming: () => ({ data: {} }),
    captureDesktopOpenCodeGlobalMetadata: async () => {
      counts.captures++;
      if (captureFails) throw failure;
      return captured;
    },
  }) as (cdp: unknown, options: Record<string, unknown>) => Promise<void>;
  const invoke = new Function('env', `
    const { runDesktopLaunchUiSmoke, cleanupCapturedDesktopApp, fixture, evidence, group } = env;
    return async () => {
      let hostPid, thrown, cleanup;
      const cdp = {}, app = { pid: group, exitCode: 0, signalCode: null }, appIdentity = 'TEST original child';
      const packedRelaunchMode = false, checkpointUpgrade = undefined, conversationModel = undefined;
      const codexResumeModel = undefined, openCodeLifecycleModel = { observations: [], failures: [] };
      const mode = 'native-resume-ui', extensionsUiMode = false;
      try { ${call} } catch (error) { thrown = error; }
      finally { cleanup = ${cleanupCall}; }
      return { thrown, cleanup };
    };
  `)({ runDesktopLaunchUiSmoke: launch,
    cleanupCapturedDesktopApp: (input: Parameters<typeof cleanupCapturedDesktopApp>[0]) => {
      counts.cleanup++; cleanupInput = input; return cleanup(input);
    }, fixture, evidence, group,
  }) as () => Promise<{ thrown: unknown; cleanup: Awaited<ReturnType<typeof cleanupCapturedDesktopApp>> }>;
  const result = await invoke();
  assert.equal(result.thrown, failure, 'the original UI/capture error survives the finally path');
  assert.equal(counts.captures, 1); assert.equal(counts.cleanup, 1); assert.equal(counts.signals, 0);
  return { ...result, cleanupInput, counts, evidence, captured, host, descendant, now };
}

test('Launch Host observation reaches cleanup after a later UI refusal', async () => {
  const f = await failedLaunchHostHandoff(false);
  assert.equal(f.cleanupInput?.hostPid, f.host, 'retain the already validated Host before the flow can reject');
  assert.equal((f.evidence.launchDialogProof as Record<string, unknown>).originalGlobalMetadata, f.captured);
  assert.equal(f.counts.uiReads, 1); assert.equal(f.counts.commands, 0);
  assert.equal(f.cleanup.cleanupFailure, undefined); assert.deepEqual(f.cleanup.remaining, []);
  assert.equal(f.cleanup.capturedHostAbsent, true);
  assert.equal((f.evidence.originalExitedGroup as Record<string, unknown>).settled, true);
  assert.equal(f.now, 100, 'existing observation can settle without a new wait');
});

test('Launch Host observation is never invented when the original capture refuses', async () => {
  const f = await failedLaunchHostHandoff(true);
  assert.equal(f.cleanupInput?.hostPid, undefined); assert.equal(f.counts.uiReads, 0);
  assert.equal((f.evidence.launchDialogProof as Record<string, unknown>).originalGlobalMetadata, undefined);
  assert.equal(f.evidence.originalExitedGroup, undefined);
  assert.equal(f.cleanup.capturedHostAbsent, null);
  assert.deepEqual(f.cleanup.remaining, [f.descendant]);
  assert.equal(f.cleanup.cleanupFailure, 'captured leader absent; retain cleanup debt without signaling');
});

test('Launch Host observation cannot clear a remaining descendant or renew the original cleanup deadline', async () => {
  const f = await failedLaunchHostHandoff(false, true);
  assert.equal(f.cleanupInput?.hostPid, f.host);
  assert.equal((f.evidence.originalExitedGroup as Record<string, unknown>).reason, 'original-observation-deadline');
  assert.equal(f.now, 3100, '100ms original yield plus the unchanged 3000ms shared observation allowance');
  assert.deepEqual(f.cleanup.remaining, [f.descendant]);
  assert.equal(f.cleanup.cleanupFailure, 'captured leader absent; retain cleanup debt without signaling');
});
