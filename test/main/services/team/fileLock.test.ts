import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', { spy: true });

const workerPath = path.resolve('test/fixtures/fileLockProcessWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

interface Worker {
  ready: Promise<void>;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

function launchWorker(args: string[]): Worker {
  const child = spawn(process.execPath, [tsxPath, workerPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
    if (output.includes('ready\n') || output.includes('acquired\n')) markReady();
  });
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const result = once(child, 'close').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    output: `${output}${stderr}`,
  }));
  return { ready, result };
}

describe('withFileLock SQLite transaction ownership', () => {
  let temporaryRoot: string;
  let testFile: string;
  let displacedRoot: string | null = null;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filelock-test-'));
    testFile = path.join(temporaryRoot, 'test.json');
    displacedRoot = null;
    fs.writeFileSync(testFile, '[]', 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (displacedRoot) fs.rmSync(displacedRoot, { recursive: true, force: true });
  });

  it('acquires around async and synchronous operations and retains the lock database', async () => {
    const asyncResult = await withFileLock(testFile, async () => 42);
    const syncResult = withFileLockSync(testFile, () => 43);

    expect(asyncResult).toBe(42);
    expect(syncResult).toBe(43);
    expect(fs.statSync(`${testFile}.lock.sqlite3`).isFile()).toBe(true);
  });

  it('rolls back ownership after callback failure', async () => {
    await expect(
      withFileLock(testFile, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(withFileLock(testFile, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('serializes same-process access without wall-clock stale stealing', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withFileLock(
      testFile,
      async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        order.push('first:end');
      },
      { staleTimeoutMs: 1 }
    );
    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    const second = withFileLock(testFile, async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('fences same-PID legacy uncertainty and ignores inert stale tombstones', async () => {
    const legacyPath = `${testFile}.lock`;
    fs.mkdirSync(legacyPath);
    fs.writeFileSync(
      path.join(legacyPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'reused-token', processStartIdentity: 'unknown' })
    );
    fs.mkdirSync(`${legacyPath}.abandoned.reused-token`);
    const legacyCallback = vi.fn(async () => undefined);
    await expect(withFileLock(testFile, legacyCallback)).rejects.toThrow(
      `Legacy file lock ownership is uncertain: ${testFile}`
    );
    expect(legacyCallback).not.toHaveBeenCalled();
    fs.rmSync(legacyPath, { recursive: true });

    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;

    await expect(
      withFileLock(testFile, async () => 'stolen', { acquireTimeoutMs: 20, retryIntervalMs: 1 })
    ).rejects.toThrow(`File lock timeout: ${testFile}`);
    release();
    await owner;
    expect(fs.existsSync(`${legacyPath}.abandoned.reused-token`)).toBe(true);
  });

  it('recovers after the owning process crashes without a reclaim rename/delete phase', async () => {
    const crashed = launchWorker(['crash', testFile]);
    await crashed.ready;
    const result = await crashed.result;
    expect(result.signal === 'SIGKILL' || result.code === 137, result.output).toBe(true);

    await expect(withFileLock(testFile, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('serializes two post-crash reclaimers and a successor writer behind one barrier', async () => {
    const tracePath = path.join(temporaryRoot, 'trace');
    const activePath = path.join(temporaryRoot, 'active');
    const startPath = path.join(temporaryRoot, 'start');
    const crashed = launchWorker(['crash', testFile]);
    await crashed.ready;
    await crashed.result;

    const workers = ['reclaimer-a', 'reclaimer-b', 'successor'].map((label) =>
      launchWorker(['barrier', testFile, label, startPath, tracePath, activePath])
    );
    await Promise.all(workers.map((worker) => worker.ready));
    fs.writeFileSync(startPath, 'go\n', 'utf8');
    const results = await Promise.all(workers.map((worker) => worker.result));

    for (const result of results) expect(result.code, result.output).toBe(0);
    const events = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
    expect(events).toHaveLength(6);
    for (let index = 0; index < events.length; index += 2) {
      const label = events[index]!.slice('start:'.length);
      expect(events[index + 1]).toBe(`end:${label}`);
    }
    expect(events).toContain('start:successor');
    expect(fs.existsSync(activePath)).toBe(false);
  });

  it('fences malformed databases and symlink lock paths before the callback', async () => {
    const callback = vi.fn(async () => undefined);
    fs.writeFileSync(`${testFile}.lock.sqlite3`, 'not a sqlite database', 'utf8');
    await expect(withFileLock(testFile, callback)).rejects.toThrow(/database/i);
    expect(callback).not.toHaveBeenCalled();

    fs.rmSync(`${testFile}.lock.sqlite3`, { force: true });
    fs.symlinkSync(testFile, `${testFile}.lock.sqlite3`);
    await expect(withFileLock(testFile, callback)).rejects.toThrow('Unsafe lock database');
    expect(callback).not.toHaveBeenCalled();
  });

  it('detects a database replacement before protected effects', async () => {
    await withFileLock(testFile, async () => undefined);
    const databasePath = `${testFile}.lock.sqlite3`;
    const lstatSync = fs.lstatSync;
    let databaseStatsReads = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
      if (String(target) === databasePath && ++databaseStatsReads === 2) {
        fs.renameSync(databasePath, `${databasePath}.malicious`);
        fs.writeFileSync(databasePath, 'replacement', 'utf8');
      }
      return lstatSync(target, options as never);
    }) as typeof fs.lstatSync);
    const callback = vi.fn(async () => undefined);

    await expect(withFileLock(testFile, callback)).rejects.toThrow(/identity changed|database/i);
    expect(callback).not.toHaveBeenCalled();
  });

  it('detects a lock-root swap before protected effects', async () => {
    const databasePath = `${testFile}.lock.sqlite3`;
    await withFileLock(testFile, async () => undefined);
    const lstatSync = fs.lstatSync;
    let databaseStatsReads = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
      if (String(target) === databasePath && ++databaseStatsReads === 2) {
        displacedRoot = `${temporaryRoot}.displaced`;
        fs.renameSync(temporaryRoot, displacedRoot);
        fs.mkdirSync(temporaryRoot);
        fs.writeFileSync(testFile, 'replacement', 'utf8');
        fs.writeFileSync(databasePath, '', 'utf8');
      }
      return lstatSync(target, options as never);
    }) as typeof fs.lstatSync);
    const callback = vi.fn(async () => undefined);

    await expect(withFileLock(testFile, callback)).rejects.toThrow(
      /identity changed|ownership was lost/
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('creates missing parents and keeps Windows directory-sync limitations compatible', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const nested = path.join(temporaryRoot, 'nested', 'deep', 'data.json');
    await expect(withFileLock(nested, async () => 'ok')).resolves.toBe('ok');
    expect(fs.existsSync(`${nested}.lock.sqlite3`)).toBe(true);
  });
});
