import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { encodeFrame, encodeLaunch, FrameDecoder, Op, type Frame } from '../../src/main/utils/ownedProcess/codec';
import { connectPrivateBroker, createWindowsOwnedLaunchPort } from '../../src/main/utils/ownedProcess/windowsBroker';
import type { PendingOwnedProcess, Preparation, ProcessOwner, ResolvedLaunchSpec } from '../../src/main/utils/ownedProcess/contract';

function timeout<T>(promise: Promise<T>, ms = 10000): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Native gate deadline')), ms);
    void promise.then((value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error('Native gate operation failed')); });
  });
}
async function waitFor(check: () => boolean, ms = 10000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Native readiness deadline');
    await new Promise<void>((done) => setTimeout(done, 5));
  }
}
async function capturedWitness(fixture: string, pid: number, birth: string, track: (child: ChildProcess) => void): Promise<{ process: ChildProcess; exit: Promise<number | null> }> {
  const process = spawn(fixture, ['wait', String(pid), birth], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  track(process);
  const exit = new Promise<number | null>((resolveExit, reject) => { process.on('exit', resolveExit); process.on('error', reject); });
  void exit.catch(() => undefined); // capture failure is separately surfaced below, including spawn errors
  await timeout(new Promise<void>((resolveCaptured, reject) => {
    process.stdout.once('data', (data: Buffer) => data.toString().includes('captured') ? resolveCaptured() : reject(new Error('Witness not captured')));
    process.once('exit', () => reject(new Error('Witness exited before capture')));
    process.once('error', reject);
  }));
  return { process, exit };
}
function preparationError(failure: Extract<Preparation, { kind: 'failed' }>): Error {
  console.error(JSON.stringify({ gateFailure: 'prepare', creation: failure.creation, diagnostics: failure.cleanup.diagnostics() }));
  return new Error(failure.reason);
}
async function brokerReleased(pending: PendingOwnedProcess): Promise<void> {
  await waitFor(() => pending.diagnostics().brokerExit !== undefined, 3000);
  assert.deepEqual(pending.diagnostics().brokerExit, { code: 0, signal: null }, 'Original broker exits0 after full Released ACK');
}
interface StartMarker { path: string; nonce: string }
interface GateContext {
  broker: string;
  fixture: string;
  birthFailureBroker: string;
  accountingFailureBroker: string;
  readonly track: (child: ChildProcess) => void;
  readonly retain: (pending: PendingOwnedProcess) => void;
  readonly marker: () => StartMarker;
  readonly spec: (mode: string, start: StartMarker) => ResolvedLaunchSpec;
  readonly owner: () => ProcessOwner;
}

async function preResumeCancellation(context: GateContext): Promise<void> {
  const { broker, fixture, owner, marker, spec, track, retain } = context;
  const identity = owner(); const port = createWindowsOwnedLaunchPort(broker); const pending = port.allocate(identity);
  retain(pending); const start = marker();
  const preparation = await port.prepare(pending, spec('tree', start));
  if (preparation.kind !== 'prepared') throw preparationError(preparation);
  assert.equal(existsSync(start.path), false, 'No target instruction effect before resume');
  preparation.process.stdout.resume(); preparation.process.stderr.resume();
  const witness = await capturedWitness(fixture, preparation.process.root.pid, preparation.process.root.birth, track);
  const stopped = await pending.stop({ expectedOwner: identity, attemptId: 'pre-resume-cancel', mode: 'force', deadlineMs: performance.now() + 10000 });
  assert.equal(stopped.kind, 'confirmed'); assert.equal(await timeout(witness.exit), 0);
  assert.equal(existsSync(start.path), false, 'Pre-resume cancelled target never executed marker');
  assert.equal((await preparation.process.drain(performance.now() + 3000)).kind, 'complete');
  if (stopped.kind !== 'confirmed') throw new Error('Pre-resume cleanup lacks native proof');
  await pending.release(stopped.receipt, 'job-membership'); await brokerReleased(pending);
}

async function treeScenario(context: GateContext, mode: 'tree' | 'root-first', sentinel: ChildProcess): Promise<void> {
  const { broker, fixture, owner, marker, spec, track, retain } = context;
  const port = createWindowsOwnedLaunchPort(broker); const identity = owner(); const pending = port.allocate(identity);
  retain(pending);
  const start = marker(); const prepared = await port.prepare(pending, spec(mode, start));
  if (prepared.kind !== 'prepared') throw preparationError(prepared);
  const target = prepared.process; let output = ''; const children: { pid: number; birth: string }[] = [];
  let releaseChildren!: () => void;
  const childLines = new Promise<void>((done) => { releaseChildren = done; });
  target.stdout.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > 65536) throw new Error('Fixture output exceeds bounded JSON-tail gate');
    output += chunk.toString();
    for (const line of output.split('\n')) {
      if (line.startsWith('{"children"') && line.endsWith('}')) {
        const parsed = JSON.parse(line) as { children: { pid: number; birth: string }[] };
        for (const entry of parsed.children) if (!children.some((value) => value.pid === entry.pid)) children.push(entry);
      }
    }
    if (children.length === 4) releaseChildren(); // child + grandchild + two sibling leaves
  });
  target.stderr.resume();
  const root = await capturedWitness(fixture, target.root.pid, target.root.birth, track);
  assert.equal(existsSync(start.path), false, 'Suspended target must not execute its first marker');
  const rootExit = new Promise<void>((done) => target.observeRootExit(() => done()));
  let installed = false;
  await target.resume(identity, () => { installed = true; return Promise.resolve(); }); assert.ok(installed);
  await timeout(childLines);
  assert.equal(readFileSync(start.path, 'utf8'), start.nonce, 'Exact target nonce appears only after resume');
  const descendants = await Promise.all(children.map((entry) => capturedWitness(fixture, entry.pid, entry.birth, track)));
  if (mode === 'root-first') {
    await timeout(rootExit);
    assert.ok(output.includes('{"final":true}\n'), 'Queued final JSON tail retained');
    assert.equal((await target.drain(performance.now() + 100)).kind, 'incomplete', 'Descendant-held pipe is distinct from root exit');
  }
  const result = await pending.stop({ expectedOwner: identity, attemptId: randomUUID(), mode: 'force', deadlineMs: performance.now() + 10000 });
  assert.equal(result.kind, 'confirmed');
  assert.equal((await target.drain(performance.now() + 3000)).kind, 'complete');
  assert.deepEqual(await timeout(Promise.all([root, ...descendants].map((value) => value.exit))), [0, 0, 0, 0, 0]);
  if (result.kind !== 'confirmed') throw new Error('Native accounting proof missing');
  await pending.release(result.receipt, 'job-membership'); await brokerReleased(pending);
  assert.equal(sentinel.exitCode, null, 'Unrelated original sentinel remains alive');
}

async function ioScenario(context: GateContext, mode: 'flood' | 'breakaway', sentinel: ChildProcess): Promise<void> {
  const { broker, owner, marker, spec, retain } = context;
  const port = createWindowsOwnedLaunchPort(broker); const identity = owner();
  const pending = port.allocate(identity); retain(pending);
  const start = marker(); const prepared = await port.prepare(pending, spec(mode, start));
  if (prepared.kind !== 'prepared') throw preparationError(prepared);
  const target = prepared.process; let output = '';
  target.stderr.resume();
  if (mode === 'breakaway') target.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  const pausedReadiness = (): void => undefined; // observes buffering without consuming target bytes
  if (mode === 'flood') { target.stdout.pause(); target.stdout.on('readable', pausedReadiness); }
  const rootExit = new Promise<number>((done) => target.observeRootExit((value) => done(value.code)));
  assert.equal(existsSync(start.path), false);
  await target.resume(identity, () => Promise.resolve());
  if (mode === 'flood') {
    const stream = target.stdout; let progress = 0;
    await waitFor(() => {
      if (!existsSync(start.path) || !existsSync(`${start.path}.progress`)) return false;
      const bytes = readFileSync(`${start.path}.progress`);
      if (bytes.length !== 40 || bytes.toString('ascii', 0, 36) !== start.nonce) return false;
      progress = bytes.readUInt32LE(36);
      return stream.isPaused() && stream.readableLength >= stream.readableHighWaterMark && progress > 0;
    });
    assert.equal(readFileSync(start.path, 'utf8'), start.nonce);
    assert.equal(stream.readableDidRead, false, 'No flood target bytes consumed before Stop');
    assert.equal(stream.readableFlowing, false, 'Flood output remains in paused readable mode');
    assert.ok(progress < 8 * 1024 * 1024, 'Flood has actual incomplete pipe-write progress before Stop');
    assert.ok(stream.readableLength <= stream.readableHighWaterMark + 65536,
      'Paused unconsumed fixture output remains bounded');
  }
  if (mode === 'breakaway') {
    assert.equal(await timeout(rootExit), 0); assert.ok(output.includes('breakaway-denied'));
  }
  const result = await pending.stop({ expectedOwner: identity, attemptId: mode, mode: 'force', deadlineMs: performance.now() + 10000 });
  if (mode === 'breakaway') assert.equal(readFileSync(start.path, 'utf8'), start.nonce);
  assert.equal(result.kind, 'confirmed', 'Blocked target output must not block independent Stop/accounting');
  target.stdout.off('readable', pausedReadiness);
  target.stdout.resume(); assert.equal((await target.drain(performance.now() + 3000)).kind, 'complete');
  if (result.kind !== 'confirmed') throw new Error('Native negative gate lacks proof');
  await pending.release(result.receipt, 'job-membership'); await brokerReleased(pending); assert.equal(sentinel.exitCode, null);
}

async function birthFailureScenario(context: GateContext): Promise<void> {
  const { birthFailureBroker, owner, marker, spec, retain } = context;
  // A real contained target plus forced original-birth query failure must retain cleanup authority,
  // forbid resume, and remain unknown even when Job force termination succeeds.
  const faultPort = createWindowsOwnedLaunchPort(birthFailureBroker, 'job-membership', {
    available: (path) => process.platform === 'win32' && path === birthFailureBroker,
    connect: connectPrivateBroker,
  }); const faultOwner = owner(); // explicit separately compiled fault transport, never staged production admission
  const fault = faultPort.allocate(faultOwner); retain(fault);
  const faultStart = marker(); const failure = await faultPort.prepare(fault, spec('tree', faultStart));
  assert.equal(failure.kind, 'failed');
  if (failure.kind !== 'failed') throw new Error('Fault binary unexpectedly prepared');
  assert.equal(failure.cleanup, fault); assert.equal(failure.creation, 'contained-suspended');
  const faultResult = await fault.stop({ expectedOwner: faultOwner, attemptId: 'birth-failure', mode: 'force', deadlineMs: performance.now() + 500 });
  assert.equal(faultResult.kind, 'unknown');
  assert.equal(existsSync(faultStart.path), false, 'Birth query failure forbids target execution');
  fault.abandonControl(faultOwner); // containment only; no receipt or destructive metadata release
}

async function accountingFailureScenario(context: GateContext): Promise<void> {
  const { accountingFailureBroker, fixture, owner, marker, spec, track, retain } = context;
  const identity = owner(); const port = createWindowsOwnedLaunchPort(accountingFailureBroker, 'job-membership', {
    available: (path) => process.platform === 'win32' && path === accountingFailureBroker, connect: connectPrivateBroker,
  });
  const pending = port.allocate(identity); retain(pending); const start = marker();
  const prepared = await port.prepare(pending, spec('tree', start));
  if (prepared.kind !== 'prepared') throw preparationError(prepared);
  const target = prepared.process; target.stdout.resume(); target.stderr.resume();
  const witness = await capturedWitness(fixture, target.root.pid, target.root.birth, track);
  const request = { expectedOwner: identity, attemptId: 'accounting-failed-attempt', mode: 'force' as const, deadlineMs: performance.now() + 10000 };
  const unknown = await pending.stop(request);
  assert.equal(unknown.kind, 'unknown', 'Injected query failure cannot be erased by subsequent actual zero accounting');
  assert.equal(await timeout(witness.exit), 0); assert.equal(existsSync(start.path), false);
  assert.equal(await pending.stop(request), unknown, 'Original failed attempt remains identical and unknown');
  const reconciled = await pending.stop({ ...request, attemptId: 'fresh-accounting-reconciliation', deadlineMs: performance.now() + 10000 });
  if (reconciled.kind !== 'confirmed') throw new Error('Fresh distinct accounting reconciliation did not confirm');
  assert.equal((await target.drain(performance.now() + 3000)).kind, 'complete');
  await pending.release(reconciled.receipt, 'job-membership'); await brokerReleased(pending);
}

async function nativeReleaseScenario(context: GateContext, releaseBroker: string, terminalRace = false): Promise<void> {
  const { fixture, owner, marker, spec, track } = context;
  const identity = owner(); const raw = spawn(releaseBroker, [], { stdio: ['pipe', 'pipe', 'pipe', 'overlapped'], windowsHide: true,
    env: { ...process.env, OWNED_PROCESS_TEST_TERMINAL_RACE: terminalRace ? '1' : '0' } });
  track(raw); raw.stdout.resume(); raw.stderr.resume();
  const exited = new Promise<number | null>((done, reject) => { raw.once('exit', done); raw.once('error', reject); });
  const pipe = raw.stdio[3]; assert.ok(pipe instanceof Duplex); const decoder = new FrameDecoder(identity.processGeneration);
  const replies = new Map<number, (frame: Frame) => void>();
  pipe.on('data', (data: Buffer) => decoder.push(data, (frame) => { replies.get(frame.opcode)?.(frame); }));
  let id = 0n;
  const request = (opcode: number, response: number, payload: Buffer): Promise<Frame> => {
    const reply = new Promise<Frame>((done) => { replies.set(response, done); });
    pipe.write(encodeFrame({ opcode, requestId: ++id, generation: identity.processGeneration, payload })); return timeout(reply);
  };
  const start = marker(); const prepared = await request(Op.launch, Op.prepared, encodeLaunch(spec('tree', start)));
  const witness = await capturedWitness(fixture, prepared.payload.readUInt32LE(0), prepared.payload.readBigUInt64LE(4).toString(16).padStart(16, '0'), track);
  const budget = Buffer.alloc(5); budget.writeUInt32LE(10000); budget[4] = 1;
  const stopped = await request(Op.stop, Op.stopped, budget);
  assert.equal(stopped.payload.length, 26); assert.equal(stopped.payload.readUInt32LE(2), 0); assert.equal(stopped.payload[1], 1);
  assert.equal(stopped.payload.readUInt32LE(18), 0); assert.equal(stopped.payload.readUInt32LE(22), 0);
  assert.equal(await timeout(witness.exit), 0); assert.equal(existsSync(start.path), false);
  await waitFor(() => raw.stdout.readableEnded && raw.stderr.readableEnded, 3000);
  const released = await request(Op.release, Op.released, Buffer.alloc(0)); assert.equal(released.payload.length, 0);
  pipe.end(); const originalExit = await timeout(exited);
  if (terminalRace) {
    assert.equal(originalExit, 74, 'Observed native failure winner cannot become exit0 after complete ACK');
    console.log(JSON.stringify({ nativeNegative: 'failure-winner-after-complete-ack', completeAck: true, brokerExit: originalExit }));
  } else assert.equal(originalExit, 0, 'Genuine Released ACK followed by owner EOF exits normally, including scheduling window');
}

async function nativeLossScenario(context: GateContext, faultMode: 'owner-eof' | 'broker-crash' | 'wrong-generation' | 'lost-prepared' | 'malformed' | 'truncated', sentinel: ChildProcess): Promise<void> {
  const { broker, fixture, owner, marker, spec, track } = context;
  const identity = owner(); const raw = spawn(broker, [], { stdio: ['pipe', 'pipe', 'pipe', 'overlapped'], windowsHide: true });
  track(raw); raw.stdout.resume(); raw.stderr.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    raw.once('exit', (code, signal) => done({ code, signal })); raw.once('error', reject);
  });
  const pipe = raw.stdio[3]; assert.ok(pipe instanceof Duplex);
  pipe.on('error', () => undefined); // deliberate loss gate still requires original exit + independent root witness
  const decoder = new FrameDecoder(identity.processGeneration);
  let preparedReply!: (frame: Frame) => void;
  let stoppedReply!: (frame: Frame) => void;
  const nativePrepared = new Promise<Frame>((done) => { preparedReply = done; });
  const nativeStopped = new Promise<Frame>((done) => { stoppedReply = done; });
  const start = marker();
  pipe.on('data', (data: Buffer) => decoder.push(data, (frame) => {
    if (frame.opcode === Op.prepared) { preparedReply(frame); }
    if (frame.opcode === Op.stopped) { stoppedReply(frame); }
  }));
  pipe.write(encodeFrame({ opcode: Op.launch, requestId: 1n, generation: identity.processGeneration, payload: encodeLaunch(spec('tree', start)) }));
  const frame = await timeout(nativePrepared);
  const witness = await capturedWitness(fixture, frame.payload.readUInt32LE(0), frame.payload.readBigUInt64LE(4).toString(16).padStart(16, '0'), track);
  assert.equal(existsSync(start.path), false);
  if (faultMode === 'broker-crash') raw.kill();
  else if (faultMode === 'lost-prepared') {
    // Gate inspector captures native identity; admission deliberately publishes no prepared port/resume.
    const budget = Buffer.alloc(5); budget.writeUInt32LE(3000); budget[4] = 1;
    pipe.write(encodeFrame({ opcode: Op.stop, requestId: 2n, generation: identity.processGeneration, payload: budget }));
    const stopped = await timeout(nativeStopped); assert.equal(stopped.payload.readUInt32LE(2), 0); assert.equal(stopped.payload[1], 1);
    pipe.destroy();
  }
  else if (faultMode === 'malformed') {
    const invalid = encodeFrame({ opcode: Op.resume, requestId: 2n, generation: identity.processGeneration, payload: Buffer.alloc(0) });
    invalid.writeUInt16LE(99, 4); pipe.write(invalid);
  } else if (faultMode === 'truncated') { pipe.write(Buffer.alloc(8)); pipe.end(); }
  else if (faultMode === 'wrong-generation') pipe.write(encodeFrame({ opcode: Op.resume,
    requestId: 2n, generation: randomUUID(), payload: Buffer.alloc(0) }));
  else pipe.destroy();
  assert.equal(await timeout(witness.exit), 0, 'Original suspended target exits on broker/control loss');
  assert.equal(existsSync(start.path), false, 'Unacknowledged/cancelled target never executes first nonce');
  const exit = await timeout(exited);
  assert.ok(exit.code !== 0 || exit.signal !== null, 'Loss/malformed control never exits as successful release');
  console.log(JSON.stringify({ nativeNegative: faultMode, brokerExit: exit }));
  assert.equal(sentinel.exitCode, null);
}

export async function runNativeGate(broker: string, fixture: string, birthFailureBroker: string,
  accountingFailureBroker: string, releaseDelayBroker: string, sandbox: string): Promise<void> {
  assert.equal(process.platform, 'win32', 'Native gate must execute on Windows');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  assert.ok(resolve(sandbox).startsWith(`${resolve(tmpdir())}${sep}`) && /^opg[0-9a-f]+\.tmp$/i.test(basename(sandbox)),
    'Gate requires its independent controller-created disposable sandbox');
  const testChildren = new Set<ChildProcess>();
  const pendingCapabilities = new Set<PendingOwnedProcess>();
  const helperExits = new Map<ChildProcess, Promise<void>>();
  const track = (child: ChildProcess): void => {
    if (helperExits.has(child)) return;
    testChildren.add(child);
    helperExits.set(child, new Promise<void>((done) => { child.once('close', () => done()); child.once('error', () => done()); }));
  };
  const marker = (): StartMarker => ({ path: join(sandbox, `${randomUUID()}.started`), nonce: randomUUID() });
  const spec = (mode: string, start: StartMarker): ResolvedLaunchSpec => ({ executable: fixture,
    commandLine: `"${fixture}" ${mode} "${start.path}" ${start.nonce}`, cwd: sandbox, environment: [] });
  const owner = (): ProcessOwner => ({ teamIncarnation: randomUUID(), runId: randomUUID(), laneId: 'sandbox', processGeneration: randomUUID() });
  const context: GateContext = { broker, fixture, birthFailureBroker, accountingFailureBroker, track,
    retain: (pending) => { pendingCapabilities.add(pending); }, marker, spec, owner };
  try {
    const sentinel = spawn(fixture, ['sentinel'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track(sentinel);
    await timeout(new Promise<void>((done) => { sentinel.stdout.once('data', () => done()); }));
    await preResumeCancellation(context);
    for (const mode of ['tree', 'root-first'] as const) await treeScenario(context, mode, sentinel);
    for (const mode of ['flood', 'breakaway'] as const) await ioScenario(context, mode, sentinel);
    await birthFailureScenario(context);
    await accountingFailureScenario(context);
    // Each real ACK/EOF gate captures target-handle exit and zero Job accounting before release.
    for (const releaseBroker of [broker, releaseDelayBroker]) await nativeReleaseScenario(context, releaseBroker);
    await nativeReleaseScenario(context, releaseDelayBroker, true); // unstaged compile-guarded failure, never product release PASS
    // Containment fallback is independently witnessed; it never counts as a bridge receipt.
    for (const mode of ['owner-eof', 'broker-crash', 'wrong-generation', 'lost-prepared', 'malformed', 'truncated'] as const) {
      await nativeLossScenario(context, mode, sentinel);
    }
    console.log(JSON.stringify({ gate: 'owned-process-native-scenarios-only', platform: process.platform, arch: process.arch,
      versions: process.versions, results: ['tree', 'root-first-tail-held-pipe', 'blocked-output-independent-stop',
        'breakaway-denied', 'pre-resume-cancel-first-nonce', 'birth-failure-unknown-first-nonce', 'owner-eof',
        'accounting-failure-latched-unknown-distinct-reconciliation', 'post-launch-pending-read-genuine-prepared', 'released-ack-eof-exit-zero',
        'failure-winner-after-complete-ack-exit-74',
        'broker-crash', 'wrong-generation', 'malformed', 'truncated', 'lost-prepared-no-resume-first-nonce', 'sentinel-isolation'] }));
  } finally {
    // Only children created by this disposable gate. No scans, taskkill, shared or product runtimes.
    for (const pending of pendingCapabilities) pending.abandonControl(pending.owner);
    for (const child of testChildren) if (child.exitCode === null) child.kill();
    await timeout(Promise.all(helperExits.values()), 10000);
    // No sandbox removal here. Independent native controller must witness its whole outer Job
    // at zero after this Node process exits; emergency cleanup is a distinct failed gate.
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [broker, fixture, fault, accountingFault, releaseDelay, flag, sandbox] = process.argv.slice(2);
  if (!broker || !fixture || !fault || !accountingFault || !releaseDelay || flag !== '--controller-sandbox' || !sandbox) {
    throw new Error('Run only through owned-process-gate-controller with explicit broker/fixture/fault paths');
  }
  await runNativeGate(resolve(broker), resolve(fixture), resolve(fault), resolve(accountingFault), resolve(releaseDelay), resolve(sandbox));
}
