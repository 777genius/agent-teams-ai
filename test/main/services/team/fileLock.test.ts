import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import {
  buildFileLockV3Record,
  classifyFileLockRecord,
  FILE_LOCK_V3_BRAND,
  FILE_LOCK_V3_LEGACY_TIMESTAMP,
  type FileLockNativeAcquireResult,
  type FileLockNativePort,
} from '@main/services/infrastructure/file-lock';
import { createFileLockApi, type FileLockTarget } from '@main/services/team/fileLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_BASE = path.resolve('.test-tmp-r811');
const workerPath = path.resolve('test/fixtures/fileLockProcessWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/loader.mjs');

interface LeaseState {
  marker: string;
  ownerKey: string;
}

class FakeNativePort implements FileLockNativePort {
  readonly calls: string[] = [];
  readonly relativeTargets: string[] = [];
  readonly leases = new Map<bigint, LeaseState>();
  nextAcquire: FileLockNativeAcquireResult | undefined;
  acquireHook: (() => void) | undefined;
  ownerKey = 'native-owner';
  failAbandon: unknown;
  failRelease: unknown;
  failPublish: unknown;
  failClose: unknown;
  private nextLease = 1n;

  captureScope(authorityRoot: string): bigint {
    this.calls.push(`capture:${authorityRoot}`);
    return 10n;
  }

  tryAcquire(
    _scopeId: bigint,
    relativeTarget: string,
    marker: string
  ): FileLockNativeAcquireResult {
    this.calls.push('tryAcquire');
    this.relativeTargets.push(relativeTarget);
    this.acquireHook?.();
    const configured = this.nextAcquire;
    if (configured) return configured;
    const leaseId = this.nextLease++;
    this.leases.set(leaseId, { marker, ownerKey: this.ownerKey });
    return { status: 'acquired', leaseId, ownerKey: this.ownerKey };
  }

  assertOwned(leaseId: bigint): void {
    this.calls.push('assertOwned');
    this.required(leaseId);
  }

  publishRelease(leaseId: bigint, record: string): void {
    this.calls.push('publishRelease');
    expect(record).toBe(this.required(leaseId).marker);
    if (this.failPublish !== undefined) throw this.failPublish;
  }

  release(leaseId: bigint): void {
    this.calls.push('release');
    this.required(leaseId);
    if (this.failRelease !== undefined) throw this.failRelease;
    this.leases.delete(leaseId);
  }

  abandon(leaseId: bigint): void {
    this.calls.push('abandon');
    this.required(leaseId);
    if (this.failAbandon !== undefined) throw this.failAbandon;
  }

  closeScope(): void {
    this.calls.push('closeScope');
    if (this.failClose !== undefined) throw this.failClose;
  }

  private required(leaseId: bigint): LeaseState {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error('missing fake lease');
    return lease;
  }
}

function target(root: string, relative = 'state/data.json'): FileLockTarget {
  return { authorityRoot: root, targetPath: path.join(root, relative) };
}

function waitForBarrier(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('acquired\n')) resolve(output);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('close', (code) =>
      reject(new Error(`worker exited before barrier ${code}: ${output}`))
    );
  });
}

function launchWorker(
  mode: 'hold' | 'acquire',
  root: string,
  targetPath: string,
  tracePath: string,
  home: string
): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', tsxPath, workerPath, mode, root, targetPath, tracePath],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
}

describe('file-lock V3 boundary', () => {
  let root: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_BASE, { recursive: true });
    root = fs.mkdtempSync(path.join(TEST_BASE, 'case-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('acquires, asserts immediately before entry, publishes, and releases exact authority', async () => {
    const port = new FakeNativePort();
    const api = createFileLockApi(port);
    const value = await api.withFileLock(target(root), async () => {
      port.calls.push('callback');
      return 42;
    });

    expect(value).toBe(42);
    expect(port.calls.slice(1)).toEqual([
      'tryAcquire',
      'assertOwned',
      'callback',
      'publishRelease',
      'release',
      'closeScope',
    ]);
  });

  it('keeps authority when the target inode is replaced while held', () => {
    const port = new FakeNativePort();
    const api = createFileLockApi(port);
    const lockTarget = target(root);
    fs.mkdirSync(path.dirname(lockTarget.targetPath), { recursive: true });
    fs.writeFileSync(lockTarget.targetPath, 'before');

    expect(
      api.withFileLockSync(lockTarget, () => {
        fs.renameSync(lockTarget.targetPath, `${lockTarget.targetPath}.old`);
        fs.writeFileSync(lockTarget.targetPath, 'after');
        return fs.readFileSync(lockTarget.targetPath, 'utf8');
      })
    ).toBe('after');
    expect(port.calls).toContain('publishRelease');
  });

  it('does not derive authority from HOME', async () => {
    const originalHome = process.env.HOME;
    const port = new FakeNativePort();
    const api = createFileLockApi(port);
    try {
      process.env.HOME = path.join(root, 'home-a');
      await api.withFileLock(target(root, 'one'), async () => undefined);
      process.env.HOME = path.join(root, 'home-b');
      await api.withFileLock(target(root, 'two'), async () => undefined);
    } finally {
      process.env.HOME = originalHome;
    }
    expect(port.calls.filter((call) => call === `capture:${root}`)).toHaveLength(2);
  });

  it('does not scan a scope containing more than 5000 entries', () => {
    const crowded = path.join(root, 'crowded');
    fs.mkdirSync(crowded);
    for (let index = 0; index < 5_001; index += 1) {
      fs.writeFileSync(path.join(crowded, String(index)), '');
    }
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
    const readdir = vi.spyOn(mutableFs, 'readdirSync');
    const port = new FakeNativePort();
    const value = createFileLockApi(port).withFileLockSync(target(root), () => 'ok');
    expect(value).toBe('ok');
    expect(readdir).not.toHaveBeenCalled();
    expect(port.relativeTargets).toEqual([path.join('state', 'data.json')]);
  }, 20_000);

  it('delegates case and Unicode identity to the native ownerKey', async () => {
    const port = new FakeNativePort();
    port.ownerKey = 'native-canonical-case-unicode-key';
    const api = createFileLockApi(port);
    const first = target(root, 'Café/State.json');
    const alias = target(root, 'CAFÉ/state.json');

    await expect(
      api.withFileLock(first, async () =>
        api.withFileLock(alias, async () => 'unexpected', { acquireTimeoutMs: 5 })
      )
    ).rejects.toThrow('already held by this process');
    expect(port.relativeTargets).toEqual([
      path.join('Café', 'State.json'),
      path.join('CAFÉ', 'state.json'),
    ]);
  });

  it('rejects outside targets before native scope capture', () => {
    const port = new FakeNativePort();
    expect(() =>
      createFileLockApi(port).withFileLockSync(
        { authorityRoot: path.join(root, 'inside'), targetPath: path.join(root, 'outside') },
        () => undefined
      )
    ).toThrow('outside its authority root');
    expect(port.calls).toEqual([]);
  });

  it('fails closed when the captured root is substituted', () => {
    const original = path.join(root, 'authority');
    const moved = path.join(root, 'authority-old');
    fs.mkdirSync(original);
    const port = new FakeNativePort();
    port.acquireHook = () => {
      fs.renameSync(original, moved);
      fs.mkdirSync(original);
      port.nextAcquire = { status: 'uncertain' };
    };
    expect(() =>
      createFileLockApi(port).withFileLockSync(target(original), () => undefined)
    ).toThrow('ownership is uncertain');
    expect(port.calls).toContain('closeScope');
  });

  it('preserves legacy and unknown artifacts when native ownership is uncertain', () => {
    const lockTarget = target(root);
    fs.mkdirSync(path.dirname(lockTarget.targetPath), { recursive: true });
    const artifacts = [
      `1\n${FILE_LOCK_V3_LEGACY_TIMESTAMP}\nagent-teams-legacy-authoritative-v1\n12345678-1234-4123-8123-123456789abc\n`,
      `1\n${FILE_LOCK_V3_LEGACY_TIMESTAMP}\nagent-teams-legacy-authoritative-v2\n12345678-1234-4123-8123-123456789abc\n`,
      'unknown\n',
    ];
    for (const artifact of artifacts) {
      fs.writeFileSync(`${lockTarget.targetPath}.lock`, artifact);
      const port = new FakeNativePort();
      port.nextAcquire = { status: 'uncertain' };
      expect(() => createFileLockApi(port).withFileLockSync(lockTarget, () => undefined)).toThrow(
        'mutation denied'
      );
      expect(fs.readFileSync(`${lockTarget.targetPath}.lock`, 'utf8')).toBe(artifact);
      expect(port.calls).not.toContain('publishRelease');
    }
  });

  it('denies mutation when native capability is unsupported', () => {
    const port = new FakeNativePort();
    port.nextAcquire = { status: 'unsupported' };
    let entered = false;
    expect(() =>
      createFileLockApi(port).withFileLockSync(target(root), () => {
        entered = true;
      })
    ).toThrow('unsupported; mutation denied');
    expect(entered).toBe(false);
  });

  it('rejects same-lineage async re-entry without entering the nested callback', async () => {
    const port = new FakeNativePort();
    const api = createFileLockApi(port);
    const callback = vi.fn(async () => 'nested');
    await expect(
      api.withFileLock(target(root), async () => api.withFileLock(target(root), callback))
    ).rejects.toThrow('already held by this async lineage');
    expect(callback).not.toHaveBeenCalled();
  });

  it('times out on native contention and closes the scope', async () => {
    const port = new FakeNativePort();
    port.nextAcquire = { status: 'contended' };
    await expect(
      createFileLockApi(port).withFileLock(target(root), async () => undefined, {
        acquireTimeoutMs: 10,
        retryIntervalMs: 1,
      })
    ).rejects.toThrow('File lock timeout');
    expect(port.calls.at(-1)).toBe('closeScope');
  });

  it('abandons without publishing when the callback rejects with undefined', async () => {
    const port = new FakeNativePort();
    await expect(
      createFileLockApi(port).withFileLock(target(root), async () => await Promise.reject())
    ).rejects.toMatchObject({ message: 'File lock operation failed by throwing undefined' });
    expect(port.calls).toContain('abandon');
    expect(port.calls).not.toContain('publishRelease');
  });

  it('abandons and releases exact authority when release-record publication fails', async () => {
    const port = new FakeNativePort();
    const publishError = new Error('publication failed');
    port.failPublish = publishError;
    await expect(
      createFileLockApi(port).withFileLock(target(root), async () => 'completed')
    ).rejects.toBe(publishError);
    expect(port.calls.slice(-4)).toEqual(['publishRelease', 'abandon', 'release', 'closeScope']);
  });

  it('aggregates callback-first cleanup failures, including undefined callback errors', async () => {
    const port = new FakeNativePort();
    const abandonError = new Error('abandon failed');
    const releaseError = new Error('release failed');
    const closeError = new Error('close failed');
    port.failAbandon = abandonError;
    port.failRelease = releaseError;
    port.failClose = closeError;
    const failure = await createFileLockApi(port)
      .withFileLock(target(root), async () => await Promise.reject())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'File lock operation failed by throwing undefined' }),
      abandonError,
      releaseError,
      closeError,
    ]);
    expect((failure as AggregateError).cause).toBe((failure as AggregateError).errors[0]);
  });

  it('reacquires after a SIGKILL holder using deterministic child-process barriers', async () => {
    const lockTarget = target(root);
    const trace = path.join(root, 'trace.txt');
    const holder = launchWorker(
      'hold',
      root,
      lockTarget.targetPath,
      trace,
      path.join(root, 'home-a')
    );
    await waitForBarrier(holder);
    const holderClosed = once(holder, 'close');
    holder.kill('SIGKILL');
    await holderClosed;

    const successor = launchWorker(
      'acquire',
      root,
      lockTarget.targetPath,
      trace,
      path.join(root, 'home-b')
    );
    const successorClosed = once(successor, 'close');
    await waitForBarrier(successor);
    const [code] = await successorClosed;
    expect(code).toBe(0);
    expect(fs.readFileSync(trace, 'utf8')).toContain(
      `acquire:acquired:${path.join(root, 'home-b')}`
    );
  }, 60_000);
});

describe('bounded V3 record policy', () => {
  it('emits a permanent maximum-safe branded marker and recognizes only canonical V3', () => {
    const nonce = '12345678-1234-4123-8123-123456789abc';
    const record = buildFileLockV3Record(123, nonce);
    expect(record).toBe(`123\n${Number.MAX_SAFE_INTEGER}\n${FILE_LOCK_V3_BRAND}\n${nonce}\n`);
    expect(classifyFileLockRecord(record)).toEqual({ kind: 'v3', pid: 123, nonce });
    expect(classifyFileLockRecord(record.replace('v3', 'v2'))).toEqual({
      kind: 'legacy-or-unknown',
    });
    expect(classifyFileLockRecord('x'.repeat(257))).toEqual({ kind: 'legacy-or-unknown' });
  });
});
