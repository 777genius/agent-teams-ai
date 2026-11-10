import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessCustody } from '../src/composition/processCustody.js';
import type { PackagedProcessArtifactSelection } from '../src/process/readPackagedProcessArtifact.js';

/** Explicit TEST actor only, never imported by production startup. Does not autorun.
 * Qualifies this packaged adapter against an owned Node spawn/session, NOT a signed
 * provider executable. Root must separately authorize this one native signal.
 */
export async function qualifyRegisteredProcessNative(input: {
  node: string;
  nodeSha256: string;
  workspace: string;
  evidenceDirectory: string;
  artifact: PackagedProcessArtifactSelection;
}) {
  assert.match(input.workspace, /^\/private\/tmp\/TEST-[^/]+(?:\/[^/]+)*$/);
  assert.equal(realpathSync(input.workspace), input.workspace);
  assert.equal(lstatSync(input.workspace).isDirectory(), true);
  assert.equal(realpathSync(input.node), input.node);
  assert.equal(
    createHash('sha256').update(readFileSync(input.node)).digest('hex'),
    input.nodeSha256
  );
  assert.equal(realpathSync(input.evidenceDirectory), input.evidenceDirectory);
  assert.ok(input.evidenceDirectory.startsWith(input.workspace + '/'));
  const retain = (name: string, value: unknown) =>
    writeFileSync(
      join(input.evidenceDirectory, name + '.json'),
      JSON.stringify(value, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  const native = createProcessCustody(input.artifact)!;
  const service = 'setTimeout(()=>process.exit(0),6500)';
  const rootSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(service)}],{stdio:'ignore'});process.stdout.write(String(child.pid));setTimeout(()=>process.exit(0),3000)`;
  const root = spawn(input.node, ['-e', rootSource], {
    cwd: input.workspace,
    env: { HOME: input.workspace },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sentinel = spawn(input.node, ['-e', service], {
    cwd: input.workspace,
    env: { HOME: input.workspace },
    detached: true,
    stdio: 'ignore',
  });
  const rootClosed = once(root, 'close'),
    sentinelClosed = once(sentinel, 'close');
  root.stderr.resume();
  let signalCalls = 0;
  try {
    const rootCapture = native.captureRoot(
      root,
      () => root.exitCode === null && root.signalCode === null
    );
    const data = await Promise.race([
      once(root.stdout, 'data'),
      delay(1500).then(() => {
        throw Error('TEST target announcement timeout');
      }),
    ]);
    const targetPid = Number(String(data[0]).trim());
    assert.ok(
      Number.isSafeInteger(targetPid) &&
        targetPid > 1 &&
        targetPid !== root.pid &&
        targetPid !== sentinel.pid
    );
    const registrar = {
      backendId: 'TEST-backend',
      teamId: 'TEST-team',
      runId: 'TEST-run',
      memberId: 'TEST-member',
      generation: '1',
    };
    const captured = rootCapture.capture(targetPid, registrar);
    retain('original-selection', {
      rootPid: root.pid,
      sentinelPid: sentinel.pid,
      targetPid,
      captured,
    });
    assert.equal(native.observe(captured), 'same-live');
    assert.throws(() => rootCapture.capture(sentinel.pid!, registrar));
    await rootClosed; // Original root naturally exits; cold observation never adopts a new root.
    assert.throws(() => rootCapture.capture(targetPid, registrar));
    assert.equal(native.observe(captured), 'same-live');
    retain('signal-requested', { signal: 'SIGTERM', captured, signalCallsBefore: signalCalls });
    signalCalls++;
    const signalled = native.signal(captured);
    retain('signal-result', { signalled, signalCalls });
    assert.equal(signalled, 'accepted');
    // Signal accepted is not reported as observed exit. Poll only the exact original token.
    let observed = native.observe(captured);
    for (let i = 0; i < 80 && observed !== 'absent'; i++) {
      await delay(20);
      observed = native.observe(captured);
    }
    assert.equal(observed, 'absent');
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);
    await sentinelClosed;
    assert.equal(sentinel.exitCode, 0);
    assert.equal(signalCalls, 1);
    retain('observed-closure', {
      rootPid: root.pid,
      rootExit: root.exitCode,
      rootSignal: root.signalCode,
      sentinelPid: sentinel.pid,
      sentinelExit: sentinel.exitCode,
      sentinelSignal: sentinel.signalCode,
      targetObservation: native.observe(captured),
      signalCalls,
    });
    return {
      qualifiedTuple: `darwin-arm64-${captured.target.osBuild}-owned-node-session-only`,
      signalCalls,
      rootExit: root.exitCode,
      sentinelExit: sentinel.exitCode,
      targetObserved: 'absent',
      providerNativeRootQualified: false,
    };
  } finally {
    // No PID/PGID cleanup fallback; every fixture has its own finite natural lifetime.
    root.stdout.resume();
    await Promise.allSettled([rootClosed, sentinelClosed]);
    await delay(3600);
    retain('final-owned-handle-closure', {
      rootPid: root.pid,
      rootExit: root.exitCode,
      rootSignal: root.signalCode,
      sentinelPid: sentinel.pid,
      sentinelExit: sentinel.exitCode,
      sentinelSignal: sentinel.signalCode,
      signalCalls,
    });
  }
}
