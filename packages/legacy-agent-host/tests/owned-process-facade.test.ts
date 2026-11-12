import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';

import { OwnedProcessFacade } from '../dist/owned-process/processFacade.js';

import type { PreparedOwnedProcess, ProcessOwner, RootExit } from '../dist/owned-process/contract.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Structural SDK contract only. No synthetic result is used as native cleanup evidence. */
function fixture() {
  const owner: ProcessOwner = Object.freeze({ teamIncarnation: 'TEST-team', runId: 'TEST-run',
    laneId: 'TEST-member', processGeneration: '00112233-4455-6677-8899-aabbccddeeff' });
  const calls: string[] = [], writes: Buffer[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) { calls.push('write'); writes.push(Buffer.from(chunk)); callback(); },
    final(callback) { calls.push('stdin-end'); callback(); },
  });
  let rootExit: (exit: RootExit) => void = () => { throw new Error('Missing root observer'); };
  let controlFailure: (reason: string) => void = () => { throw new Error('Missing control observer'); };
  let onResume = async () => {};
  const process: PreparedOwnedProcess = {
    owner, root: Object.freeze({ pid: 421, birth: '0000000000001234' }), stdin, stdout, stderr,
    diagnostics: () => ({ writeCompleted: false }),
    observeRootExit(callback) { rootExit = callback; return () => {}; },
    observeTransportFailure(callback) { controlFailure = callback; return () => {}; },
    async resume(expected, installOwner) {
      assert.deepEqual(expected, owner); calls.push('resume-enter');
      await installOwner(); calls.push('resume-native'); await onResume();
    },
    stop: async (request) => ({ kind: 'unknown', owner, attemptId: request.attemptId,
      reason: 'TEST is not native evidence', creation: 'uncertain', deadlineExpired: false }),
    abandonControl: () => {}, release: async () => { throw new Error('No genuine native receipt'); },
    drain: async () => ({ kind: 'incomplete', reason: 'No native drain proof' }),
  };
  return { owner, process, calls, writes, stdout, stderr, stdin,
    exit: (code: number) => rootExit({ code, birth: process.root.birth }),
    fail: () => controlFailure('TEST private diagnostic'),
    onResume: (callback: () => Promise<void>) => { onResume = callback; } };
}

test('early SDK write and EOF wait for native owner installation and resume, with backpressure', async () => {
  const f = fixture(), install = gate();
  const child = new OwnedProcessFacade({ owner: f.owner,
    prepare: async () => ({ kind: 'prepared', process: f.process }), current: () => true,
    installOwner: async () => { f.calls.push('install-enter'); await install.promise; f.calls.push('install-done'); },
    requestStop: () => { f.calls.push('stop-request'); return true; } });
  assert.equal(child.pid, undefined, 'No broker PID is exposed during async prepare');
  child.stdout.resume(); child.stderr.resume();
  const bytes = Buffer.alloc(64 * 1024, 0x41), inputFinished = once(child.stdin, 'finish');
  const writeFinished = new Promise<void>((resolve, reject) => {
    assert.equal(child.stdin.write(bytes, (error) => error ? reject(error) : resolve()), false);
  });
  child.stdin.end();
  await turn();
  assert.equal(child.pid, f.process.root.pid);
  assert.deepEqual(f.calls, ['resume-enter', 'install-enter']);
  assert.equal(f.writes.length, 0);
  install.release();
  await child.ready; await writeFinished; await inputFinished;
  assert.deepEqual(f.calls, ['resume-enter', 'install-enter', 'install-done', 'resume-native', 'write', 'stdin-end']);
  assert.deepEqual(f.writes, [bytes]);
  const closed = once(child, 'close');
  f.exit(0); f.stdout.end(); f.stderr.end();
  assert.deepEqual(await closed, [0, null]);
});

for (const boundary of ['abort-during-prepare', 'authority-loss-during-install'] as const) {
  test(`${boundary} never resumes native code or flushes queued input`, async () => {
    const f = fixture(), wait = gate(), abort = new AbortController();
    let current = true, callbacks = 0;
    const child = new OwnedProcessFacade({ owner: f.owner, signal: abort.signal,
      prepare: async () => {
        if (boundary === 'abort-during-prepare') await wait.promise;
        return { kind: 'prepared', process: f.process };
      }, current: () => current,
      installOwner: async () => { f.calls.push('install'); await wait.promise; },
      requestStop: () => { f.calls.push('stop-request'); return true; } });
    const writeFinished = new Promise<void>((resolve) => {
      child.stdin.write('TEST queued secret', (error) => { callbacks++; assert.ok(error); resolve(); });
    });
    await turn();
    if (boundary === 'abort-during-prepare') abort.abort();
    else current = false;
    wait.release();
    await assert.rejects(child.ready, /unavailable/);
    await writeFinished; await turn();
    assert.equal(callbacks, 1);
    assert.equal(f.calls.includes('resume-native'), false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.calls.filter((name) => name === 'stop-request').length, 1);
    assert.equal(child.exitCode, null, 'IO failure is not a target exit or custody proof');
  });
}

test('target exit before resume acknowledgement preserves its native code and final stdout/stderr', async () => {
  const f = fixture(), ack = gate();
  f.onResume(async () => {
    f.exit(7); f.stdout.end('TEST final output'); f.stderr.end('TEST final stderr'); await ack.promise;
  });
  const child = new OwnedProcessFacade({ owner: f.owner,
    prepare: async () => ({ kind: 'prepared', process: f.process }), current: () => true,
    installOwner: async () => {}, requestStop: () => { f.calls.push('stop-request'); return true; } });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const exited = once(child, 'exit'), closed = once(child, 'close');
  assert.deepEqual(await exited, [7, null]);
  assert.equal(child.exitCode, 7);
  await closed; ack.release(); await child.ready;
  assert.equal(Buffer.concat(output).toString(), 'TEST final output');
  assert.equal(Buffer.concat(errors).toString(), 'TEST final stderr');
  assert.equal(f.calls.includes('stop-request'), false);
  assert.equal(child.killed, false);
});

test('prepare/control failure requests original cleanup once and never invents target termination', async () => {
  for (const phase of ['prepare', 'control'] as const) {
    const f = fixture();
    const child = new OwnedProcessFacade({ owner: f.owner,
      prepare: async () => phase === 'prepare'
        ? { kind: 'failed', creation: 'uncertain', reason: 'TEST private launch secret', cleanup: f.process }
        : { kind: 'prepared', process: f.process },
      current: () => true, installOwner: async () => {},
      requestStop: () => { f.calls.push('stop-request'); return true; } });
    const observed: Error[] = [];
    child.on('error', (error: Error) => observed.push(error));
    if (phase === 'prepare') await assert.rejects(child.ready, /unavailable/);
    else { await child.ready; f.fail(); f.fail(); }
    await turn();
    assert.equal(observed.length, 1);
    assert.ok(observed.every((error) => !error.message.includes('TEST private')));
    assert.equal(f.calls.filter((name) => name === 'stop-request').length, 1);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(child.killed, true, 'Requested cleanup is separate from observed target exit');
    if (phase === 'control') {
      let lateExit = false;
      child.on('exit', () => { lateExit = true; });
      f.exit(8);
      assert.equal(child.exitCode, 8, 'Late native facts remain available to the retained owner');
      assert.equal(lateExit, false, 'No exit event is invented after SDK IO already closed');
    }
  }
});
