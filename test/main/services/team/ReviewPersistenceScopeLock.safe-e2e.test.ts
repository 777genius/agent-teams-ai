import { spawn } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

interface WorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

const temporaryRoots: string[] = [];
const workerPath = path.resolve('test/fixtures/reviewPersistenceScopeLockWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

function runWorker(
  mode: 'run' | 'crash',
  root: string,
  logPath: string,
  counterPath: string,
  workerId: string,
  delayMs: number
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxPath, workerPath, mode, root, logPath, counterPath, workerId, String(delayMs)],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function waitForLog(logPath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(logPath, 'utf8')).includes(expected)) return;
    } catch {
      // The first worker has not entered the lock yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

describe('review persistence scope lock process safety', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('serializes divergent writers in independent Node processes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-lock-processes-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'order.log');
    const counterPath = path.join(root, 'counter.txt');

    const first = runWorker('run', root, logPath, counterPath, 'first', 350);
    await waitForLog(logPath, 'first:enter');
    const second = runWorker('run', root, logPath, counterPath, 'second', 0);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.code, firstResult.stderr).toBe(0);
    expect(secondResult.code, secondResult.stderr).toBe(0);
    await expect(readFile(counterPath, 'utf8')).resolves.toBe('2');
    await expect(readFile(logPath, 'utf8')).resolves.toBe(
      'first:enter\nfirst:exit\nsecond:enter\nsecond:exit\n'
    );
  });

  it('takes over a crash-left lease only after its owner process dies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-lock-crash-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'order.log');
    const counterPath = path.join(root, 'counter.txt');

    const crashed = await runWorker('crash', root, logPath, counterPath, 'crashed', 0);
    expect(crashed.signal === 'SIGKILL' || crashed.code === 137, crashed.stderr).toBe(true);
    const recovered = await runWorker('run', root, logPath, counterPath, 'recovered', 0);

    expect(recovered.code, recovered.stderr).toBe(0);
    await expect(readFile(counterPath, 'utf8')).resolves.toBe('1');
    await expect(readFile(logPath, 'utf8')).resolves.toBe(
      'crashed:enter\nrecovered:enter\nrecovered:exit\n'
    );
  });
});
