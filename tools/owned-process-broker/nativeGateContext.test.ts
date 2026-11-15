import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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
    for (const state of ['alive', 'absent', 'alive', 'absent']) assert.equal(await witness.observe(), state);
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

  it('requires fresh retained target facts even while all survivor witness children remain alive', async () => {
    // Exercise the actual gate block without importing its vendor fixture or invoking a CLI.
    const source = readFileSync(new URL('./nativeVendorGate.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const begin = '        scopedProof = await tap.stopService(service);';
    const end = "        phase('same-native-session-continuation');";
    const from = source.indexOf(begin), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    assert.equal(source.indexOf(begin, from + begin.length), -1);
    assert.equal(source.indexOf(end, to + end.length), -1);
    const body = source.slice(from, to + end.length);
    const exercise = (absent: string | null, refusal?: Error) => {
      const calls: string[] = [];
      let continued = false;
      const witness = (name: string) => ({
        process: { exitCode: null }, exit: Promise.resolve(0),
        wait: async () => { calls.push('wait:' + name); return 0; },
        observe: async () => {
          calls.push('observe:' + name);
          if (refusal && name === 'background') throw refusal;
          return name === absent ? 'absent' : 'alive';
        },
      });
      const service = Object.freeze({ original: true });
      const promise = runInNewContext('(async () => { ' + body + ' })()', {
        assert, service, scopedProof: undefined, cleanupProof: false,
        tap: { stopService: async (target: unknown) => {
          assert.equal(target, service); calls.push('stop'); return Object.freeze({ original: true });
        } },
        timeout: (operation: Promise<unknown>) => operation,
        events: { wait: (operation: Promise<unknown>) => operation },
        providerWitness: witness('provider'), backgroundWitness: witness('background'),
        serviceWitness: witness('service'), firstLeaf: witness('first'), secondLeaf: witness('second'),
        adjacent: witness('neighbor'), sentinel: { exitCode: null }, facade: { exitCode: null },
        phase: (value: string) => { assert.equal(value, 'same-native-session-continuation'); continued = true; },
      }) as Promise<void>;
      return { promise, calls, continued: () => continued };
    };
    const expected = ['stop', 'wait:service', 'wait:first', 'wait:second',
      'observe:provider', 'observe:background', 'observe:neighbor'];
    for (const absent of ['provider', 'background', 'neighbor']) {
      const sample = exercise(absent);
      await assert.rejects(sample.promise, assert.AssertionError);
      assert.deepEqual(sample.calls, expected); assert.equal(sample.continued(), false);
    }
    const alive = exercise(null);
    await alive.promise; assert.deepEqual(alive.calls, expected); assert.equal(alive.continued(), true);
    const refusal = new Error('TEST original HANDLE observation unavailable');
    const unavailable = exercise(null, refusal);
    await assert.rejects(unavailable.promise, error => error === refusal);
    assert.deepEqual(unavailable.calls, expected); assert.equal(unavailable.continued(), false);
  });

});
