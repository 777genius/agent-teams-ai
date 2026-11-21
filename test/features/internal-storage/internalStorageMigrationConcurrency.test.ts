import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';
import { expect, it } from 'vitest';

function racer(databasePath: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.resolve('test/fixtures/internalStorageMigrationRacer.ts'),
      databasePath,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let readyResolve!: () => void;
  let resultResolve!: () => void;
  let reject!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, fail) => {
    readyResolve = resolve;
    reject = fail;
  });
  const result = new Promise<void>((resolve, fail) => {
    resultResolve = resolve;
    child.once('error', fail);
    child.once('exit', (code) => {
      if (code !== 0) fail(new Error(`migration process failed (${String(code)}): ${stderr}`));
    });
  });
  // Avoid an unhandled rejection if a child fails before its result is awaited.
  result.catch(() => undefined);
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code !== 0) reject(new Error(stderr));
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === 'ready') readyResolve();
    if (line === 'complete') resultResolve();
  });
  return { ready, result, go: () => child.stdin.end('g'), stop: () => child.kill() };
}

it('serializes competing v5 to v7 migrations across two processes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-migration-race-'));
  const databasePath = path.join(directory, 'app.db');
  const db = new Database(databasePath);
  runInternalStorageMigrations(db);
  db.exec('DROP TABLE custom_team_templates; PRAGMA user_version = 5');
  db.close();
  const first = racer(databasePath);
  const second = racer(databasePath);
  try {
    await Promise.all([first.ready, second.ready]);
    first.go();
    second.go();
    await Promise.all([first.result, second.result]);
    const reopened = new Database(databasePath);
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(7);
      expect(
        reopened.pragma('table_info(custom_team_templates)') as { name: string }[]
      ).toContainEqual(expect.objectContaining({ name: 'revision' }));
      runInternalStorageMigrations(reopened);
    } finally {
      reopened.close();
    }
  } finally {
    first.stop();
    second.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}, 15_000);
