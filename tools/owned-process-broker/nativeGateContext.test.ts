import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { capturedGateSentinel, capturedQueryableWitness } from './nativeGateContext';
import { createNativeGateEvents } from './nativeGateEvents';

vi.mock('node:child_process', async (original) => {
  const childProcess = await original<typeof import('node:child_process')>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

const childProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const birth = '0123456789abcdef';
// A finite Node protocol actor tests the observer boundary, not Windows HANDLE custody.
// In particular the vendor-only mode refuses the same missing admission as the C++ actor.
const actor = String.raw`
  const [mode, pid, birth] = process.argv.slice(1);
  if (mode === 'vendor-query-wait-gated' && process.env.OWNED_PROCESS_VENDOR_TEST_GO !== '1') process.exit(51);
  if (mode !== 'query-wait-gated' && mode !== 'vendor-query-wait-gated') process.exit(52);
  if (pid !== '42' || birth !== '0123456789abcdef') process.exit(24);
  setTimeout(() => process.exit(70), 2000).unref();
  const states = ['alive', 'absent', 'alive', 'absent'];
  let queries = 0, waiting = false;
  process.stdin.on('data', bytes => {
    for (const byte of bytes) {
      if (byte === 81 && !waiting && queries < 4) process.stdout.write(states[queries++] + '\n');
      else if (byte === 87 && !waiting) {
        waiting = true;
        process.stdout.end(() => process.exit(0));
      } else process.exit(56);
    }
  });
  process.stdin.on('end', () => { if (!waiting) process.exit(55); });
  process.stdout.write('cap', () => process.stdout.write('tured\r\n'));
`;
const children: ChildProcess[] = [];
// Finite original-pipe actor; the inherited stdout tail proves exit is not close.
const sentinelActor = String.raw`
  if (process.argv[1] !== 'source-sentinel') process.exit(58);
  setTimeout(() => process.exit(70), 2000).unref();
  process.stdin.on('data', () => process.exit(60));
  process.stdin.on('end', () => {
    const { spawn } = require('node:child_process');
    const tail = spawn(process.execPath, ['--eval', 'setTimeout(() => process.exit(0), 100)'],
      { stdio: ['ignore', 1, 2] });
    tail.unref();
    process.exit(0);
  });
  process.stdout.write('sentinel\n');
`;

beforeEach(() => {
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, undefined, 'No ambient vendor admission');
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation((file, args, options) => {
    assert.ok(file === 'TEST-closed-witness-actor' || file === 'TEST-closed-gate-sentinel');
    assert.ok(Array.isArray(args));
    const source = file === 'TEST-closed-gate-sentinel' ? sentinelActor : actor;
    const child = childProcess.spawn(process.execPath, ['--input-type=commonjs', '--eval', source, '--', ...args], options);
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill(); // Only this test's original child object, never a numeric PID.
    await exited;
  }));
});

describe('original query witness protocol', () => {
  it('admits the finite source observer without vendor opt-in and preserves exact Q/W bounds', async () => {
    const tracked: ChildProcess[] = [];
    const witness = await capturedQueryableWitness('TEST-closed-witness-actor', 42, birth,
      child => tracked.push(child), createNativeGateEvents(), 'query-wait-gated');
    assert.deepEqual(vi.mocked(spawn).mock.calls[0]?.[1], ['query-wait-gated', '42', birth]);
    assert.equal(vi.mocked(spawn).mock.calls[0]?.[2]?.env, undefined);
    assert.deepEqual(tracked, [witness.process]);
    for (const state of ['alive', 'absent', 'alive', 'absent']) {
      assert.equal(await witness.observe(), state);
      if (state === 'absent') assert.equal(witness.process.exitCode, null,
        'The gated witness staying alive is not evidence that its original target survived');
    }
    await assert.rejects(witness.observe(), /Finite sequential original HANDLE observations/);
    const stopped = witness.wait();
    assert.equal(witness.wait(), stopped, 'The original wait is never replayed');
    assert.equal(await stopped, 0);
  });

  it('keeps the original vendor mode as the default and refuses its missing admission before capture', async () => {
    const tracked: ChildProcess[] = [];
    await assert.rejects(capturedQueryableWitness('TEST-closed-witness-actor', 42, birth,
      child => tracked.push(child), createNativeGateEvents()), /Original HANDLE witness unavailable/);
    assert.deepEqual(vi.mocked(spawn).mock.calls[0]?.[1], ['vendor-query-wait-gated', '42', birth]);
    assert.equal(vi.mocked(spawn).mock.calls[0]?.[2]?.env, undefined);
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0]!.exitCode, 51);
  });

  it('propagates original identity refusal without returning an observer', async () => {
    await assert.rejects(capturedQueryableWitness('TEST-closed-witness-actor', 42, 'fedcba9876543210',
      () => {}, createNativeGateEvents(), 'query-wait-gated'), /Original HANDLE witness unavailable/);
    assert.equal(children[0]!.exitCode, 24);
  });
});

describe('original gate sentinel lifetime', () => {
  it('holds the same original child until EOF and requires child close after exit without replaying cleanup', async () => {
    const owner = capturedGateSentinel('TEST-closed-gate-sentinel');
    await owner.ready;
    assert.deepEqual(vi.mocked(spawn).mock.calls[0]?.[1], ['source-sentinel']);
    assert.deepEqual(vi.mocked(spawn).mock.calls[0]?.[2]?.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(owner.process.exitCode, null);
    const exited = once(owner.process, 'exit');
    let confirmed = false;
    const closing = owner.close();
    assert.equal(owner.close(), closing, 'original cleanup cannot be replayed');
    void closing.then(() => { confirmed = true; });
    await exited;
    assert.equal(owner.process.exitCode, 0);
    assert.equal(confirmed, false, 'original exit alone is insufficient while stdout remains open');
    await closing;
    assert.equal(confirmed, true);
  });

  it('does not qualify an unrelated early exit or protocol byte as owned cleanup', async () => {
    const owner = capturedGateSentinel('TEST-closed-gate-sentinel');
    await owner.ready;
    const exited = once(owner.process, 'exit');
    owner.process.stdin.write('X');
    await exited;
    assert.equal(owner.process.exitCode, 60);
    await assert.rejects(owner.close(), /Original gate sentinel remains alive until owned EOF/);
  });
});
