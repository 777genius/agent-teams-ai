import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { capturedQueryableWitness } from './nativeGateContext';
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

beforeEach(() => {
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, undefined, 'No ambient vendor admission');
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation((file, args, options) => {
    assert.equal(file, 'TEST-closed-witness-actor');
    assert.ok(Array.isArray(args));
    const child = childProcess.spawn(process.execPath, ['--input-type=commonjs', '--eval', actor, '--', ...args], options);
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
