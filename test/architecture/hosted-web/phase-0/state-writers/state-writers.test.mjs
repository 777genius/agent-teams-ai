import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runExternalWriterNegativeFixture } from '../../../../../scripts/hosted-web/phase-0/state-writers/external-writer-negative-fixture.mjs';
import {
  onlineBackup,
  runWalDemo,
} from '../../../../../scripts/hosted-web/phase-0/state-writers/sqlite-online-backup-spike.mjs';
import { verifyEvidence } from '../../../../../scripts/hosted-web/phase-0/state-writers/verify-evidence.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../../..');

test('validates the checked-in catalog and all W3 evidence records', async () => {
  const result = await verifyEvidence();
  assert.deepEqual(result, { evidenceFiles: 6, stateFamilies: 17, operations: 12 });
});

test('rejects a catalog family that omits schema, atomicity, corruption and backup policy', async () => {
  const invalid = JSON.parse(
    await readFile(join(testDir, 'fixtures/invalid-state-family-catalog.json'), 'utf8')
  );
  await assert.rejects(
    () => verifyEvidence({ overrideCatalog: invalid }),
    /missing implementationStatus/
  );
});

test('negative fixture proves an app-only lock cannot coordinate an external process', async () => {
  const result = await runExternalWriterNegativeFixture();
  assert.equal(result.markerOwned, true);
  assert.equal(result.externalWriteCompleted, true);
  assert.equal(result.lostExternalUpdate, true);
  assert.equal(result.finalState.appValue, 'written-by-app');
  assert.equal(result.finalState.externalValue, 'before');
});

test('online backup runs with an active WAL and independently reopens the result', async () => {
  const result = await runWalDemo();
  assert.equal(result.method, 'better-sqlite3#backup');
  assert.equal(String(result.journalMode).toLowerCase(), 'wal');
  assert.equal(result.walActiveAtBackup, true);
  assert.equal(result.integrity, 'ok');
  assert.equal(result.independentRowCount, 2_000);
  assert.ok(result.destinationBytes > 0);
  assert.equal(existsSync(result.fixtureRoot), false, 'marker-owned fixture must be cleaned');
});

test('SQLITE_BUSY is typed and removes the partial destination without raw copy fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-w3-busy-'));
  const destinationPath = join(root, 'backup.db');
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  const source = {
    pragma: () => 'ok',
    backup: async (destination) => {
      writeFileSync(destination, 'partial');
      throw busy;
    },
  };
  try {
    await assert.rejects(
      () => onlineBackup({ source, destinationPath }),
      (error) => error?.code === 'backup_busy'
    );
    assert.equal(existsSync(destinationPath), false);
    assert.equal(existsSync(`${destinationPath}-wal`), false);
    assert.equal(existsSync(`${destinationPath}-shm`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt SQLite source fails before destination publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-w3-corrupt-'));
  const sourcePath = join(root, 'corrupt.db');
  const destinationPath = join(root, 'backup.db');
  writeFileSync(sourcePath, 'this is not a sqlite database');
  const source = new Database(sourcePath);
  try {
    await assert.rejects(
      () => onlineBackup({ source, destinationPath }),
      (error) => error?.code === 'source_corrupt'
    );
    assert.equal(existsSync(destinationPath), false);
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup deadline aborts and removes partial output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-w3-deadline-'));
  const destinationPath = join(root, 'backup.db');
  let clock = 0;
  const source = {
    pragma: () => 'ok',
    backup: async (destination, options) => {
      writeFileSync(destination, 'partial');
      clock = 10;
      options.progress({ totalPages: 10, remainingPages: 9 });
    },
  };
  try {
    await assert.rejects(
      () => onlineBackup({ source, destinationPath, deadlineMs: 5, now: () => clock }),
      (error) => error?.code === 'backup_deadline'
    );
    assert.equal(existsSync(destinationPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the executable spike never addresses a user CLAUDE_ROOT', async () => {
  const sources = await Promise.all([
    readFile(
      join(repoRoot, 'scripts/hosted-web/phase-0/state-writers/sqlite-online-backup-spike.mjs'),
      'utf8'
    ),
    readFile(
      join(
        repoRoot,
        'scripts/hosted-web/phase-0/state-writers/external-writer-negative-fixture.mjs'
      ),
      'utf8'
    ),
    readFile(
      join(
        repoRoot,
        'test/architecture/hosted-web/phase-0/state-writers/team-backup-service-faults.test.mjs'
      ),
      'utf8'
    ),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /\.claude|homedir\s*\(/);
    assert.match(source, /tmpdir\s*\(/);
  }
});
