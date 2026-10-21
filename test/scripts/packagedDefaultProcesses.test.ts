// @vitest-environment node
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DefaultProcessLedger } from '../../scripts/e2e/anthropic-compatible-status/packaged-default-processes';

interface NativeIdentity {
  pid: number;
  state: string;
  birth: string;
}
interface Fixture {
  child: ChildProcess;
  identity: NativeIdentity;
  terms: number;
  closed: boolean;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function nativeIdentity(pid: number): NativeIdentity | undefined {
  assert(Number.isSafeInteger(pid) && pid > 0);
  let output: string;
  try {
    output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,stat=,lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 1000,
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string | Buffer };
    if (failure.status === 1 && !String(failure.stdout ?? '').trim()) return undefined;
    throw error;
  }
  const match = /^(\d+)[ \t]+([^ \t]+)[ \t]+(\S.*)$/.exec(output.trim());
  assert(match, 'Native fixture process metadata must be readable');
  assert.equal(Number(match[1]), pid);
  return { pid, state: match[2], birth: match[3] };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Process fixture deadline expired')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startFixture(role: 'owned' | 'sentinel'): Promise<Fixture> {
  const child = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, 'fixtures/packaged-default-process-TEST.ts'), role],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  let closed = false;
  let terms = 0;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    }
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message: unknown) => {
      const event = message as { event?: string; role?: string; pid?: number };
      if (event.role !== role || event.pid !== child.pid) return;
      if (event.event === 'term') terms++;
      if (event.event === 'ready') resolve();
    });
    child.once('exit', () => reject(new Error('Fixture exited before becoming ready')));
  });
  assert(child.pid);
  const identity = nativeIdentity(child.pid);
  assert(identity && !/^[ZX]/.test(identity.state));
  try {
    await within(ready, 5000);
  } catch (error) {
    const current = nativeIdentity(identity.pid);
    if (current?.birth === identity.birth && !/^[ZX]/.test(current.state)) child.kill('SIGKILL');
    await within(completion, 2000);
    throw error;
  }
  return {
    child,
    identity,
    get terms() {
      return terms;
    },
    get closed() {
      return closed;
    },
    completion,
  };
}

function sameLiveFixture(fixture: Fixture): NativeIdentity {
  assert(!fixture.closed, 'Fixture must still own its native process');
  const current = nativeIdentity(fixture.identity.pid);
  assert(current);
  assert.equal(current.birth, fixture.identity.birth);
  assert(!/^[ZX]/.test(current.state));
  return current;
}

async function retireFixture(fixture: Fixture): Promise<void> {
  if (!fixture.closed) {
    const current = nativeIdentity(fixture.identity.pid);
    if (current && !/^[ZX]/.test(current.state)) {
      assert.equal(current.birth, fixture.identity.birth, 'Refusing cleanup after PID reuse');
      fixture.child.kill('SIGKILL');
    }
  }
  await within(fixture.completion, 2000);
}

describe.skipIf(process.platform === 'win32')('packaged default process ledger cleanup', () => {
  it('preserves natural-only rejection, then escalates an owned TERM-resistant child and leaves an unrelated sentinel alive', async () => {
    const fixtures: Fixture[] = [];
    try {
      const owned = await startFixture('owned');
      fixtures.push(owned);
      const sentinel = await startFixture('sentinel');
      fixtures.push(sentinel);
      const ledger = new DefaultProcessLedger();
      const registered = await ledger.register(owned.child);
      expect(registered.pid).toBe(owned.identity.pid);
      expect(registered.birth).toBe(owned.identity.birth);

      await expect(ledger.stop({ requireQuiet: true })).rejects.toThrow('did not settle naturally');
      sameLiveFixture(owned);
      sameLiveFixture(sentinel);
      expect(owned.terms).toBe(0);
      expect(sentinel.terms).toBe(0);

      let result: Awaited<ReturnType<DefaultProcessLedger['stop']>> | undefined;
      let failure: unknown;
      try {
        result = await ledger.stop();
      } catch (error) {
        failure = error;
      }
      const after = nativeIdentity(owned.identity.pid);
      console.info(
        JSON.stringify({
          scenario: 'owned-term-escalation',
          ownedPid: owned.identity.pid,
          ownedBirth: owned.identity.birth,
          terms: owned.terms,
          closed: owned.closed,
          ownedStillLive: after?.birth === owned.identity.birth && !/^[ZX]/.test(after.state),
          sentinelStillLive: sameLiveFixture(sentinel).birth === sentinel.identity.birth,
          stopError: failure instanceof Error ? failure.message : null,
        })
      );
      expect(failure).toBeUndefined();
      expect(result?.remaining).toEqual([]);
      expect(await within(owned.completion, 2000)).toEqual({ code: null, signal: 'SIGKILL' });
      expect(owned.terms).toBe(1);
      expect(nativeIdentity(owned.identity.pid)).toBeUndefined();
      sameLiveFixture(sentinel);
      expect(sentinel.terms).toBe(0);
    } finally {
      const cleanup = await Promise.allSettled(fixtures.map(retireFixture));
      const failures = cleanup.filter((result) => result.status === 'rejected');
      expect(failures).toEqual([]);
      console.info(
        JSON.stringify({
          scenario: 'owned-term-escalation-fixture-cleanup',
          processes: fixtures.map((fixture) => ({
            pid: fixture.identity.pid,
            birth: fixture.identity.birth,
            closed: fixture.closed,
            absent: nativeIdentity(fixture.identity.pid) === undefined,
          })),
        })
      );
    }
  }, 25_000);
});
