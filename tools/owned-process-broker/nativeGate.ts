import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  connectPrivateBroker,
  createWindowsOwnedLaunchPort,
} from '../../src/main/utils/ownedProcess/windowsBroker';
import type {
  PendingOwnedProcess,
  ProcessOwner,
  ResolvedLaunchSpec,
} from '../../src/main/utils/ownedProcess/contract';
import { createNativeGateDiagnostics } from './nativeGateDiagnostics';
import { createFixtureOutputCollector } from './nativeGateOutput';
import { createNativeGateEvents } from './nativeGateEvents';
import {
  brokerReleased,
  capturedWitness,
  preparationError,
  timeout,
  waitFor,
  type GateContext,
  type StartMarker,
} from './nativeGateContext';
import { nativeLossScenario, nativeReleaseScenario } from './nativeGateRawScenarios';
import { runNativePendingWriteGate } from './nativePendingWriteGate';

async function preResumeCancellation(context: GateContext): Promise<void> {
  const { broker, fixture, owner, marker, spec, track, retain, phase } = context;
  const identity = owner();
  const port = createWindowsOwnedLaunchPort(broker);
  const pending = port.allocate(identity);
  retain(pending);
  const start = marker();
  phase('prepare');
  const preparation = await context.events.wait(port.prepare(pending, spec('tree', start)));
  if (preparation.kind !== 'prepared') throw preparationError(preparation);
  assert.equal(existsSync(start.path), false, 'No target instruction effect before resume');
  preparation.process.stdout.resume();
  preparation.process.stderr.resume();
  phase('capture-root');
  const witness = await context.events.wait(
    capturedWitness(
      fixture,
      preparation.process.root.pid,
      preparation.process.root.birth,
      track,
      context.events
    )
  );
  phase('stop');
  const stopped = await context.events.wait(
    pending.stop({
      expectedOwner: identity,
      attemptId: 'pre-resume-cancel',
      mode: 'force',
      deadlineMs: performance.now() + 10000,
    })
  );
  assert.equal(stopped.kind, 'confirmed');
  phase('witness-exits');
  assert.equal(await timeout(context.events.wait(witness.exit)), 0);
  assert.equal(existsSync(start.path), false, 'Pre-resume cancelled target never executed marker');
  phase('target-drain');
  assert.equal(
    (await context.events.wait(preparation.process.drain(performance.now() + 3000))).kind,
    'complete'
  );
  if (stopped.kind !== 'confirmed') throw new Error('Pre-resume cleanup lacks native proof');
  phase('release-ack');
  await context.events.wait(pending.release(stopped.receipt, 'job-membership'));
  phase('broker-exit');
  await context.events.wait(brokerReleased(pending, context.events));
}

async function treeScenario(
  context: GateContext,
  mode: 'tree' | 'root-first',
  sentinel: ChildProcess
): Promise<void> {
  const { broker, fixture, owner, marker, spec, track, retain, phase } = context;
  const port = createWindowsOwnedLaunchPort(broker);
  const identity = owner();
  const pending = port.allocate(identity);
  retain(pending);
  phase('prepare');
  const start = marker();
  const prepared = await context.events.wait(port.prepare(pending, spec(mode, start)));
  if (prepared.kind !== 'prepared') throw preparationError(prepared);
  const target = prepared.process;
  const output = createFixtureOutputCollector();
  const { children } = output;
  let releaseChildren!: () => void;
  const childLines = new Promise<void>((done) => {
    releaseChildren = done;
  });
  target.stdout.on(
    'data',
    context.events.guard((chunk: Buffer) => {
      output.push(chunk);
      if (children.length === 4) releaseChildren(); // child + grandchild + two sibling leaves
    })
  );
  target.stderr.resume();
  phase('capture-root');
  const root = await context.events.wait(
    capturedWitness(fixture, target.root.pid, target.root.birth, track, context.events)
  );
  assert.equal(existsSync(start.path), false, 'Suspended target must not execute its first marker');
  const rootExit = new Promise<void>((done) => target.observeRootExit(() => done()));
  let installed = false;
  phase('resume');
  await context.events.wait(
    target.resume(identity, () => {
      installed = true;
      return Promise.resolve();
    })
  );
  assert.ok(installed);
  phase('child-lines');
  await timeout(context.events.wait(childLines));
  assert.equal(
    readFileSync(start.path, 'utf8'),
    start.nonce,
    'Exact target nonce appears only after resume'
  );
  phase('capture-descendants');
  const descendants = await context.events.wait(
    Promise.all(
      children.map((entry) =>
        capturedWitness(fixture, entry.pid, entry.birth, track, context.events)
      )
    )
  );
  if (mode === 'root-first') {
    phase('root-exit');
    await timeout(context.events.wait(rootExit));
    assert.ok(output.hasFinal(), 'Queued final JSON tail retained');
    phase('target-drain');
    assert.equal(
      (await context.events.wait(target.drain(performance.now() + 100))).kind,
      'incomplete',
      'Descendant-held pipe is distinct from root exit'
    );
  }
  phase('stop');
  const result = await context.events.wait(
    pending.stop({
      expectedOwner: identity,
      attemptId: randomUUID(),
      mode: 'force',
      deadlineMs: performance.now() + 10000,
    })
  );
  assert.equal(result.kind, 'confirmed');
  phase('target-drain');
  assert.equal(
    (await context.events.wait(target.drain(performance.now() + 3000))).kind,
    'complete'
  );
  phase('witness-exits');
  assert.deepEqual(
    await timeout(
      context.events.wait(Promise.all([root, ...descendants].map((value) => value.exit)))
    ),
    [0, 0, 0, 0, 0]
  );
  if (result.kind !== 'confirmed') throw new Error('Native accounting proof missing');
  phase('release-ack');
  await context.events.wait(pending.release(result.receipt, 'job-membership'));
  phase('broker-exit');
  await context.events.wait(brokerReleased(pending, context.events));
  assert.equal(sentinel.exitCode, null, 'Unrelated original sentinel remains alive');
}

async function ioScenario(
  context: GateContext,
  mode: 'flood' | 'breakaway',
  sentinel: ChildProcess
): Promise<void> {
  const { broker, owner, marker, spec, retain, phase } = context;
  const port = createWindowsOwnedLaunchPort(broker);
  const identity = owner();
  const pending = port.allocate(identity);
  retain(pending);
  phase('prepare');
  const start = marker();
  const prepared = await context.events.wait(port.prepare(pending, spec(mode, start)));
  if (prepared.kind !== 'prepared') throw preparationError(prepared);
  const target = prepared.process;
  let output = '';
  target.stderr.resume();
  if (mode === 'breakaway')
    target.stdout.on(
      'data',
      context.events.guard((data: Buffer) => {
        output += data.toString();
      })
    );
  const pausedReadiness = (): void => undefined; // observes buffering without consuming target bytes
  if (mode === 'flood') {
    target.stdout.pause();
    target.stdout.on('readable', pausedReadiness);
  }
  const rootExit = new Promise<number>((done) =>
    target.observeRootExit((value) => done(value.code))
  );
  assert.equal(existsSync(start.path), false);
  phase('resume');
  await context.events.wait(target.resume(identity, () => Promise.resolve()));
  if (mode === 'flood') {
    const stream = target.stdout;
    let progress = 0;
    phase('nonce-progress');
    await context.events.wait(
      waitFor(
        () => {
          if (!existsSync(start.path) || !existsSync(`${start.path}.progress`)) return false;
          const bytes = readFileSync(`${start.path}.progress`);
          if (bytes.length !== 40 || bytes.toString('ascii', 0, 36) !== start.nonce) return false;
          progress = bytes.readUInt32LE(36);
          return (
            stream.isPaused() &&
            stream.readableLength >= stream.readableHighWaterMark &&
            progress > 0
          );
        },
        10000,
        context.events
      )
    );
    assert.equal(readFileSync(start.path, 'utf8'), start.nonce);
    assert.equal(stream.readableDidRead, false, 'No flood target bytes consumed before Stop');
    assert.equal(stream.readableFlowing, false, 'Flood output remains in paused readable mode');
    assert.ok(
      progress < 8 * 1024 * 1024,
      'Flood has actual incomplete pipe-write progress before Stop'
    );
    assert.ok(
      stream.readableLength <= stream.readableHighWaterMark + 65536,
      'Paused unconsumed fixture output remains bounded'
    );
  }
  if (mode === 'breakaway') {
    phase('root-exit');
    assert.equal(await timeout(context.events.wait(rootExit)), 0);
    assert.ok(output.includes('breakaway-denied'));
  }
  phase('stop');
  const result = await context.events.wait(
    pending.stop({
      expectedOwner: identity,
      attemptId: mode,
      mode: 'force',
      deadlineMs: performance.now() + 10000,
    })
  );
  if (mode === 'breakaway') assert.equal(readFileSync(start.path, 'utf8'), start.nonce);
  assert.equal(
    result.kind,
    'confirmed',
    'Blocked target output must not block independent Stop/accounting'
  );
  target.stdout.off('readable', pausedReadiness);
  target.stdout.resume();
  phase('target-drain');
  assert.equal(
    (await context.events.wait(target.drain(performance.now() + 3000))).kind,
    'complete'
  );
  if (result.kind !== 'confirmed') throw new Error('Native negative gate lacks proof');
  phase('release-ack');
  await context.events.wait(pending.release(result.receipt, 'job-membership'));
  phase('broker-exit');
  await context.events.wait(brokerReleased(pending, context.events));
  assert.equal(sentinel.exitCode, null);
}

async function birthFailureScenario(context: GateContext): Promise<void> {
  const { birthFailureBroker, owner, marker, spec, retain, phase } = context;
  // A real contained target plus forced original-birth query failure must retain cleanup authority,
  // forbid resume, and remain unknown even when Job force termination succeeds.
  const faultPort = createWindowsOwnedLaunchPort(birthFailureBroker, 'job-membership', {
    available: (path) => process.platform === 'win32' && path === birthFailureBroker,
    connect: connectPrivateBroker,
  });
  const faultOwner = owner(); // explicit separately compiled fault transport, never staged production admission
  const fault = faultPort.allocate(faultOwner);
  retain(fault);
  phase('prepare');
  const faultStart = marker();
  const failure = await context.events.wait(faultPort.prepare(fault, spec('tree', faultStart)));
  assert.equal(failure.kind, 'failed');
  if (failure.kind !== 'failed') throw new Error('Fault binary unexpectedly prepared');
  assert.equal(failure.cleanup, fault);
  assert.equal(failure.creation, 'contained-suspended');
  phase('stop');
  const faultResult = await context.events.wait(
    fault.stop({
      expectedOwner: faultOwner,
      attemptId: 'birth-failure',
      mode: 'force',
      deadlineMs: performance.now() + 500,
    })
  );
  assert.equal(faultResult.kind, 'unknown');
  assert.equal(existsSync(faultStart.path), false, 'Birth query failure forbids target execution');
  phase('abandon-control');
  fault.abandonControl(faultOwner); // containment only; no receipt or destructive metadata release
}

async function accountingFailureScenario(context: GateContext): Promise<void> {
  const { accountingFailureBroker, fixture, owner, marker, spec, track, retain, phase } = context;
  const identity = owner();
  const port = createWindowsOwnedLaunchPort(accountingFailureBroker, 'job-membership', {
    available: (path) => process.platform === 'win32' && path === accountingFailureBroker,
    connect: connectPrivateBroker,
  });
  const pending = port.allocate(identity);
  retain(pending);
  const start = marker();
  phase('prepare');
  const prepared = await context.events.wait(port.prepare(pending, spec('tree', start)));
  if (prepared.kind !== 'prepared') throw preparationError(prepared);
  const target = prepared.process;
  target.stdout.resume();
  target.stderr.resume();
  phase('capture-root');
  const witness = await context.events.wait(
    capturedWitness(fixture, target.root.pid, target.root.birth, track, context.events)
  );
  const request = {
    expectedOwner: identity,
    attemptId: 'accounting-failed-attempt',
    mode: 'force' as const,
    deadlineMs: performance.now() + 10000,
  };
  phase('stop');
  const unknown = await context.events.wait(pending.stop(request));
  assert.equal(
    unknown.kind,
    'unknown',
    'Injected query failure cannot be erased by subsequent actual zero accounting'
  );
  phase('witness-exits');
  assert.equal(await timeout(context.events.wait(witness.exit)), 0);
  assert.equal(existsSync(start.path), false);
  assert.equal(
    await context.events.wait(pending.stop(request)),
    unknown,
    'Original failed attempt remains identical and unknown'
  );
  phase('reconcile');
  const reconciled = await context.events.wait(
    pending.stop({
      ...request,
      attemptId: 'fresh-accounting-reconciliation',
      deadlineMs: performance.now() + 10000,
    })
  );
  if (reconciled.kind !== 'confirmed')
    throw new Error('Fresh distinct accounting reconciliation did not confirm');
  phase('target-drain');
  assert.equal(
    (await context.events.wait(target.drain(performance.now() + 3000))).kind,
    'complete'
  );
  phase('release-ack');
  await context.events.wait(pending.release(reconciled.receipt, 'job-membership'));
  phase('broker-exit');
  await context.events.wait(brokerReleased(pending, context.events));
}

export async function runNativeGate(
  broker: string,
  fixture: string,
  birthFailureBroker: string,
  accountingFailureBroker: string,
  releaseDelayBroker: string,
  sandbox: string
): Promise<void> {
  assert.equal(process.platform, 'win32', 'Native gate must execute on Windows');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  assert.ok(
    resolve(sandbox).startsWith(`${resolve(tmpdir())}${sep}`) &&
      /^opg[0-9a-f]+\.tmp$/i.test(basename(sandbox)),
    'Gate requires its independent controller-created disposable sandbox'
  );
  const testChildren = new Set<ChildProcess>();
  const pendingCapabilities = new Set<PendingOwnedProcess>();
  const helperExits = new Map<ChildProcess, Promise<void>>();
  const events = createNativeGateEvents();
  const diagnostics = createNativeGateDiagnostics(
    testChildren,
    helperExits,
    pendingCapabilities,
    events
  );
  const { phase, runScenario, track, retain } = diagnostics;
  const marker = (): StartMarker => ({
    path: join(sandbox, `${randomUUID()}.started`),
    nonce: randomUUID(),
  });
  const spec = (mode: string, start: StartMarker): ResolvedLaunchSpec => ({
    executable: fixture,
    commandLine: `"${fixture}" ${mode} "${start.path}" ${start.nonce}`,
    cwd: sandbox,
    environment: [],
  });
  const owner = (): ProcessOwner => ({
    teamIncarnation: randomUUID(),
    runId: randomUUID(),
    laneId: 'sandbox',
    processGeneration: randomUUID(),
  });
  const context: GateContext = {
    broker,
    fixture,
    birthFailureBroker,
    accountingFailureBroker,
    track,
    retain,
    marker,
    spec,
    owner,
    phase,
    events,
  };
  try {
    diagnostics.selectScenario('sentinel');
    phase('start');
    const sentinel = spawn(fixture, ['sentinel'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    track(sentinel, 'sentinel');
    phase('sentinel-ready');
    await timeout(
      events.wait(
        new Promise<void>((done) => {
          sentinel.stdout.once(
            'data',
            events.guard(() => done())
          );
        })
      )
    );
    phase('complete');
    await runScenario('pre-resume-cancel', () => preResumeCancellation(context));
    for (const mode of ['tree', 'root-first'] as const)
      await runScenario(mode, () => treeScenario(context, mode, sentinel));
    for (const mode of ['flood', 'breakaway'] as const)
      await runScenario(mode, () => ioScenario(context, mode, sentinel));
    await runScenario('birth-failure', () => birthFailureScenario(context));
    await runScenario('accounting-failure', () => accountingFailureScenario(context));
    // Each real ACK/EOF gate captures target-handle exit and zero Job accounting before release.
    await runScenario('release', () => nativeReleaseScenario(context, broker));
    await runScenario('release-delay', () => nativeReleaseScenario(context, releaseDelayBroker));
    await runScenario('release-contention', () =>
      nativeReleaseScenario(context, releaseDelayBroker, false, true)
    );
    await runScenario('terminal-race', () =>
      nativeReleaseScenario(context, releaseDelayBroker, true)
    ); // never product release PASS
    // Containment fallback is independently witnessed; it never counts as a bridge receipt.
    for (const mode of [
      'owner-eof',
      'broker-crash',
      'wrong-generation',
      'lost-prepared',
      'malformed',
      'truncated',
    ] as const) {
      await runScenario(mode, () => nativeLossScenario(context, mode, sentinel));
    }
    for (const mode of ['complete', 'deadline'] as const) {
      await runScenario(`write-pending-${mode}`, () =>
        runNativePendingWriteGate(fixture, mode, track, events)
      );
    }
    console.log(
      JSON.stringify({
        gate: 'owned-process-native-scenarios-only',
        platform: process.platform,
        arch: process.arch,
        versions: process.versions,
        results: [
          'tree',
          'root-first-tail-held-pipe',
          'blocked-output-independent-stop',
          'breakaway-denied',
          'pre-resume-cancel-first-nonce',
          'birth-failure-unknown-first-nonce',
          'owner-eof',
          'accounting-failure-latched-unknown-distinct-reconciliation',
          'post-launch-pending-read-genuine-prepared',
          'released-ack-eof-exit-zero',
          'watcher-lock-contention-released-ack-exit-zero',
          'failure-winner-after-complete-ack-exit-74',
          'broker-crash',
          'wrong-generation',
          'malformed',
          'truncated',
          'lost-prepared-no-resume-first-nonce',
          'sentinel-isolation',
        ],
      })
    );
  } catch (error) {
    events.guard(diagnostics.failure)();
    throw error;
  } finally {
    // Only children created by this disposable gate. No scans, taskkill, shared or product runtimes.
    // Diagnostic logging must not bypass cleanup if its own callback failed.
    events.guard(diagnostics.beginCleanup)();
    for (const pending of pendingCapabilities)
      events.guard(() => pending.abandonControl(pending.owner))();
    for (const child of testChildren)
      if (child.exitCode === null) {
        diagnostics.cleanupRequested(child);
        events.guard(() => {
          child.kill();
        })(); // a dispatch observation, never a tree receipt
      }
    await diagnostics.observeHelperCleanup(() => timeout(Promise.all(helperExits.values()), 10000));
    await events.wait(Promise.resolve()); // asynchronous cleanup diagnostics also fail the gate
    // No sandbox removal here. Independent native controller must witness its whole outer Job
    // at zero after this Node process exits; emergency cleanup is a distinct failed gate.
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [broker, fixture, fault, accountingFault, releaseDelay, flag, sandbox] =
    process.argv.slice(2);
  if (
    !broker ||
    !fixture ||
    !fault ||
    !accountingFault ||
    !releaseDelay ||
    flag !== '--controller-sandbox' ||
    !sandbox
  ) {
    throw new Error(
      'Run only through owned-process-gate-controller with explicit broker/fixture/fault paths'
    );
  }
  await runNativeGate(
    resolve(broker),
    resolve(fixture),
    resolve(fault),
    resolve(accountingFault),
    resolve(releaseDelay),
    resolve(sandbox)
  );
}
