import assert from 'node:assert/strict';
import { once } from 'node:events';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeNativeHostInput, startHost } from './fixtures/native-host.ts';
import { readOriginalHostCpuProfile } from './fixtures/native-opencode-team/passive-diagnostics.ts';

test('a failed original Node child retains CPU evidence and bounded file refusals stay distinguishable', {
  timeout: 10000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-cpu-exit1-')));
  const entry = join(root, 'TEST-exit1.mjs');
  // Finite sampler consumer only: no provider, native Runtime or claimed vendor failure is simulated.
  writeFileSync(entry, 'const end = Date.now() + 50; while (Date.now() < end) Math.sqrt(Date.now()); process.exit(1);\n', { mode: 0o600 });
  const host = startHost({ node: process.execPath, entry, root, profile: join(root, 'TEST-profile.json'),
    profileHash: 'a'.repeat(64), testCpuProfile: true });
  try {
    const [code, signal] = await once(host.child, 'exit');
    assert.equal(code, 1); assert.equal(signal, null);
    await assert.rejects(host.close(), /Host exit zero confirms/);
    const path = host.testCpuProfilePath!;
    assert.equal(host.testCpuProfileIntervalUs, 10000);
    assert.ok(host.child.spawnargs.includes('--cpu-prof-interval=10000'));
    const result = await readOriginalHostCpuProfile(path, true, host.testCpuProfileIntervalUs);
    assert.equal(result.status, 'available');
    assert.equal(result.samplingIntervalUs, 10000);
    assert.equal(result.rawDiscarded, true);
    assert.equal(result.fileOverLimit, false);
    assert.ok(result.fileBytes !== undefined && result.fileBytes > 0 && result.fileBytes <= 16 * 1024 * 1024);
    assert.equal(JSON.stringify(result).includes(root), false, 'closed evidence has no source URLs or paths');
    assert.equal(existsSync(path), false);
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'missing', rawDiscarded: true,
    });
    writeFileSync(path, '', { mode: 0o600 });
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'empty-profile', rawDiscarded: true, fileBytes: 0, fileOverLimit: false,
    });
    const fd = openSync(path, 'w', 0o600);
    try { ftruncateSync(fd, 32 * 1024 * 1024); } finally { closeSync(fd); }
    assert.deepEqual(await readOriginalHostCpuProfile(path, true), {
      status: 'unavailable', reason: 'profile-over-limit', rawDiscarded: true,
      fileBytes: 16 * 1024 * 1024 + 1, fileOverLimit: true,
    });
    assert.equal(existsSync(path), false);
  } finally {
    if (host.child.exitCode === null && host.child.signalCode === null) await host.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('native fixture observes advertised disposal before signaling the original child', async () => {
  const original = { now: 0, endCalls: 0, signals: [] as number[], waits: [] as number[] };
  // Runtime may already be closed; final backup is still allowed to finish at 45 s.
  await closeNativeHostInput(
    {
      endInput() {
        original.endCalls++;
      },
      async waitExit(timeoutMs) {
        original.waits.push(timeoutMs);
        const deadline = original.now + timeoutMs;
        if (deadline >= 45_000) {
          original.now = 45_000;
          return true;
        }
        original.now = deadline;
        return false;
      },
      terminate() {
        original.signals.push(original.now);
      },
    },
    60_000
  );
  assert.equal(original.endCalls, 1);
  assert.equal(original.now, 45_000);
  assert.deepEqual(original.waits, [62_000]);
  assert.deepEqual(
    original.signals,
    [],
    'same original child finishes naturally within its contract'
  );
});

test('native fixture retains failure after one bounded original-child fallback', async () => {
  let now = 0,
    endCalls = 0;
  const signals: number[] = [];
  await assert.rejects(
    closeNativeHostInput(
      {
        endInput() {
          endCalls++;
        },
        async waitExit(timeoutMs) {
          now += timeoutMs;
          return false;
        },
        terminate() {
          signals.push(now);
        },
      },
      60_000
    ),
    /captured Host must confirm provider cleanup before exiting/
  );
  assert.equal(endCalls, 1);
  assert.deepEqual(signals, [62_000]);
  assert.equal(now, 74_000, 'unconfirmed exit remains a bounded failure');
});

test('native fixture refuses invalid disposal budgets before touching the original child', async () => {
  const effects: string[] = [];
  for (const invalid of [60_001, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    await assert.rejects(
      closeNativeHostInput(
        {
          endInput() {
            effects.push('end');
          },
          async waitExit() {
            effects.push('wait');
            return true;
          },
          terminate() {
            effects.push('signal');
          },
        },
        invalid
      ),
      /within the captured TeamHost contract/
    );
  }
  assert.deepEqual(effects, []);
});
