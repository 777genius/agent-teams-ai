#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export class SqliteBackupFault extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'SqliteBackupFault';
    this.code = code;
  }
}

function removePartialDestination(destinationPath) {
  rmSync(destinationPath, { force: true });
  rmSync(`${destinationPath}-wal`, { force: true });
  rmSync(`${destinationPath}-shm`, { force: true });
}

function classifyBackupError(error) {
  if (error instanceof SqliteBackupFault) {
    return error;
  }
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new SqliteBackupFault(
      'backup_busy',
      'SQLite online backup was busy; no fallback copy was attempted',
      error
    );
  }
  return new SqliteBackupFault(
    'backup_failed',
    `SQLite online backup failed: ${error instanceof Error ? error.message : String(error)}`,
    error
  );
}

/**
 * Minimal ADR-32 feasibility primitive. The caller supplies an already-open source so the
 * production worker can retain single-request ownership. No DB/WAL/SHM copy fallback exists.
 */
export async function onlineBackup({
  source,
  destinationPath,
  deadlineMs = 5_000,
  now = () => Date.now(),
  pagesPerIteration = 64,
}) {
  if (!source || typeof source.backup !== 'function' || typeof source.pragma !== 'function') {
    throw new TypeError('source must expose better-sqlite3 backup() and pragma()');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError('deadlineMs must be a positive safe integer');
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  removePartialDestination(destinationPath);

  let integrity;
  try {
    integrity = source.pragma('integrity_check', { simple: true });
  } catch (error) {
    throw new SqliteBackupFault(
      'source_corrupt',
      'Source integrity check could not complete; backup was not started',
      error
    );
  }
  if (integrity !== 'ok') {
    throw new SqliteBackupFault(
      'source_corrupt',
      `Source integrity check failed: ${String(integrity)}`
    );
  }

  const startedAt = now();
  let progressCalls = 0;
  try {
    const progress = await source.backup(destinationPath, {
      progress() {
        progressCalls += 1;
        if (now() - startedAt >= deadlineMs) {
          throw new SqliteBackupFault(
            'backup_deadline',
            'SQLite online backup exceeded its bounded deadline'
          );
        }
        return pagesPerIteration;
      },
    });

    const reopened = new Database(destinationPath, { readonly: true, fileMustExist: true });
    try {
      const copiedIntegrity = reopened.pragma('integrity_check', { simple: true });
      if (copiedIntegrity !== 'ok') {
        throw new SqliteBackupFault(
          'destination_corrupt',
          `Destination integrity check failed: ${String(copiedIntegrity)}`
        );
      }
      return {
        method: 'better-sqlite3#backup',
        pages: progress.totalPages,
        progressCalls,
        destinationBytes: statSync(destinationPath).size,
        integrity: copiedIntegrity,
      };
    } finally {
      reopened.close();
    }
  } catch (error) {
    removePartialDestination(destinationPath);
    throw classifyBackupError(error);
  }
}

export async function runWalDemo() {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-w3-sqlite-backup-'));
  const markerPath = join(root, '.agent-teams-phase-0-w3-fixture');
  writeFileSync(markerPath, 'marker-owned\n', { mode: 0o600 });
  const sourcePath = join(root, 'source.db');
  const destinationPath = join(root, 'backup.db');
  const source = new Database(sourcePath);

  try {
    const journalMode = source.pragma('journal_mode = WAL', { simple: true });
    source.pragma('wal_autocheckpoint = 0');
    source.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = source.prepare('INSERT INTO items(value) VALUES (?)');
    const seed = source.transaction(() => {
      for (let index = 0; index < 2_000; index += 1)
        insert.run(`fixture-${index}-${'x'.repeat(256)}`);
    });
    seed();
    if (!existsSync(`${sourcePath}-wal`))
      throw new Error('WAL sidecar was not active during the probe');

    const result = await onlineBackup({ source, destinationPath });
    const independent = new Database(destinationPath, { readonly: true, fileMustExist: true });
    const rowCount = independent.prepare('SELECT count(*) AS count FROM items').get().count;
    independent.close();
    return {
      fixtureRoot: root,
      markerOwned: existsSync(markerPath),
      journalMode,
      walActiveAtBackup: existsSync(`${sourcePath}-wal`),
      independentRowCount: rowCount,
      ...result,
    };
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWalDemo()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ code: error?.code ?? 'unexpected', message: error instanceof Error ? error.message : String(error) })}\n`
      );
      process.exitCode = 1;
    });
}
