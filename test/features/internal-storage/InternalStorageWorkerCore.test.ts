import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { getTableColumns, getTableName } from 'drizzle-orm';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { INTERNAL_STORAGE_SCHEMA_VERSION } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import * as schema from '@features/internal-storage/main/infrastructure/worker/internalStorageSchema';

import type {
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '@features/internal-storage/contracts/internalStorageContracts';

function makeCore(databasePath: string): InternalStorageWorkerCore {
  return new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
}

function makeRecord(overrides: Partial<StallJournalEntryRecord> = {}): StallJournalEntryRecord {
  return {
    epochKey: 'task-a:epoch-1',
    teamName: 'demo',
    taskId: 'task-a',
    memberName: null,
    branch: 'work',
    signal: 'turn_ended_after_touch',
    state: 'suspected',
    consecutiveScans: 1,
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    alertedAt: null,
    ...overrides,
  };
}

describe('InternalStorageWorkerCore', () => {
  let tmpDir: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  async function makeTmpDbPath(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'internal-storage-'));
    return path.join(tmpDir, 'storage', 'app.db');
  }

  function track(core: InternalStorageWorkerCore): InternalStorageWorkerCore {
    cores.push(core);
    return core;
  }

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // already closed
      }
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('ping opens the database, migrates schema and reports backend info', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    const info = core.handle('ping', {}) as InternalStorageBackendInfo;

    expect(info.driver).toBe('better-sqlite3');
    expect(info.databasePath).toBe(dbPath);
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(info.integrity).toBe('ok');
  });

  it('replace + load round-trips records including nullable fields and unicode team names', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    const teamName = 'команда-демо';
    const records = [
      makeRecord({ teamName, epochKey: 'e-1' }),
      makeRecord({
        teamName,
        epochKey: 'e-2',
        memberName: 'алиса',
        state: 'alerted',
        alertedAt: '2026-07-07T11:00:00.000Z',
      }),
    ];

    core.handle('stallJournal.replace', { teamName, entries: records });
    const loaded = core.handle('stallJournal.load', { teamName }) as StallJournalEntryRecord[];

    expect(loaded).toHaveLength(2);
    expect(loaded.find((r) => r.epochKey === 'e-2')).toEqual(records[1]);
    expect(core.handle('stallJournal.load', { teamName: 'other' })).toEqual([]);
  });

  it('replace fully overwrites the previous team rows without touching other teams', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    core.handle('stallJournal.replace', {
      teamName: 'demo',
      entries: [makeRecord({ epochKey: 'old-1' }), makeRecord({ epochKey: 'old-2' })],
    });
    core.handle('stallJournal.replace', {
      teamName: 'neighbor',
      entries: [makeRecord({ teamName: 'neighbor', epochKey: 'n-1' })],
    });
    core.handle('stallJournal.replace', {
      teamName: 'demo',
      entries: [makeRecord({ epochKey: 'new-1' })],
    });

    const demo = core.handle('stallJournal.load', {
      teamName: 'demo',
    }) as StallJournalEntryRecord[];
    const neighbor = core.handle('stallJournal.load', {
      teamName: 'neighbor',
    }) as StallJournalEntryRecord[];
    expect(demo.map((r) => r.epochKey)).toEqual(['new-1']);
    expect(neighbor.map((r) => r.epochKey)).toEqual(['n-1']);
  });

  it.each([
    {
      op: 'stallJournal.replace' as const,
      entry: makeRecord({ teamName: 'neighbor' }),
    },
    {
      op: 'commentJournal.replace' as const,
      entry: {
        key: 'task-a:comment-1',
        teamName: 'neighbor',
        taskId: 'task-a',
        commentId: 'comment-1',
        author: 'alice',
        commentCreatedAt: null,
        messageId: null,
        state: 'pending',
        createdAt: '2026-07-07T10:00:00.000Z',
        updatedAt: '2026-07-07T10:00:00.000Z',
        sentAt: null,
      },
    },
  ])('rejects cross-team rows for $op before opening the database', ({ op, entry }) => {
    let openAttempts = 0;
    const core = new InternalStorageWorkerCore({
      databasePath: '/not-opened/app.db',
      createDatabase: () => {
        openAttempts += 1;
        throw new Error('database should not open');
      },
    });

    expect(() => core.handle(op, { teamName: 'demo', entries: [entry] })).toThrow(
      /entries\[0\]\.teamName must match payload teamName/
    );
    expect(openAttempts).toBe(0);
  });

  it('persists across close and reopen (WAL survives)', async () => {
    const dbPath = await makeTmpDbPath();
    const first = track(makeCore(dbPath));
    first.handle('stallJournal.replace', { teamName: 'demo', entries: [makeRecord()] });
    first.close();

    const second = track(makeCore(dbPath));
    const loaded = second.handle('stallJournal.load', {
      teamName: 'demo',
    }) as StallJournalEntryRecord[];
    expect(loaded).toHaveLength(1);
  });

  it('re-running migrations on an already-migrated database is a no-op', async () => {
    const dbPath = await makeTmpDbPath();
    const first = track(makeCore(dbPath));
    first.handle('ping', {});
    first.close();

    const second = track(makeCore(dbPath));
    const info = second.handle('ping', {}) as InternalStorageBackendInfo;
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(info.integrity).toBe('ok');
  });

  it('keeps the raw migration DDL in sync with the drizzle schema', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    core.handle('ping', {});

    const db = new Database(dbPath, { readonly: true });
    try {
      for (const table of Object.values(schema)) {
        const tableName = getTableName(table);
        const actual = (db.pragma(`table_info(${tableName})`) as { name: string }[])
          .map((column) => column.name)
          .sort((a, b) => a.localeCompare(b));
        const expected = Object.values(getTableColumns(table))
          .map((column) => column.name)
          .sort((a, b) => a.localeCompare(b));
        expect(actual, `columns of ${tableName}`).toEqual(expected);
      }
    } finally {
      db.close();
    }
  });

  it('propagates transient open failures without touching the database file', async () => {
    const dbPath = await makeTmpDbPath();
    const healthy = track(makeCore(dbPath));
    healthy.handle('stallJournal.replace', { teamName: 'demo', entries: [makeRecord()] });
    healthy.close();

    // A non-corruption failure (driver init, permissions) must NOT trigger
    // the backup-and-recreate path — that would discard a healthy database.
    const broken = new InternalStorageWorkerCore({
      databasePath: dbPath,
      createDatabase: () => {
        throw new Error('EPERM: operation not permitted');
      },
    });
    expect(() => broken.handle('ping', {})).toThrow(/EPERM/);

    const siblings = await fs.readdir(path.dirname(dbPath));
    expect(siblings.some((name) => name.includes('.corrupt-'))).toBe(false);
    const reopened = track(makeCore(dbPath));
    expect(reopened.handle('stallJournal.load', { teamName: 'demo' })).toHaveLength(1);
  });

  it('backs up a corrupt database file and recreates a working one', async () => {
    const dbPath = await makeTmpDbPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, 'this is definitely not a sqlite file', 'utf8');

    const core = track(makeCore(dbPath));
    const info = core.handle('ping', {}) as InternalStorageBackendInfo;

    expect(info.integrity).toBe('recovered');
    core.handle('stallJournal.replace', { teamName: 'demo', entries: [makeRecord()] });
    expect(core.handle('stallJournal.load', { teamName: 'demo' })).toHaveLength(1);

    const siblings = await fs.readdir(path.dirname(dbPath));
    expect(siblings.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('records store imports idempotently (upsert by store + team)', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));

    core.handle('storeImports.record', {
      storeId: 'stall-monitor-journal',
      teamName: 'demo',
      entryCount: 3,
    });
    core.handle('storeImports.record', {
      storeId: 'stall-monitor-journal',
      teamName: 'demo',
      entryCount: 5,
    });

    // No throw on the duplicate key is the contract; the row is an audit trail.
    expect(core.handle('ping', {})).toBeTruthy();
  });

  it('rejects unknown ops', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    expect(() => core.handle('nope' as never, {} as never)).toThrow(/Unknown internal-storage op/);
  });

  it('migrates a v1 database (pilot release) to the current schema in place', async () => {
    const dbPath = await makeTmpDbPath();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    // Reproduce the exact on-disk state the pilot release left behind.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`CREATE TABLE stall_journal_entries (
      team_name TEXT NOT NULL,
      epoch_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      member_name TEXT,
      branch TEXT NOT NULL,
      signal TEXT NOT NULL,
      state TEXT NOT NULL,
      consecutive_scans INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      alerted_at TEXT,
      PRIMARY KEY (team_name, epoch_key)
    )`);
    legacyDb.exec(`CREATE TABLE store_imports (
      store_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      PRIMARY KEY (store_id, team_name)
    )`);
    legacyDb
      .prepare(`INSERT INTO stall_journal_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'demo',
        'task-a:epoch-1',
        'task-a',
        null,
        'work',
        'turn_ended_after_touch',
        'suspected',
        1,
        '2026-07-07T10:00:00.000Z',
        '2026-07-07T10:00:00.000Z',
        null
      );
    legacyDb.pragma('user_version = 1');
    legacyDb.close();

    const core = track(makeCore(dbPath));
    const info = core.handle('ping', {}) as InternalStorageBackendInfo;
    expect(info.schemaVersion).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
    expect(info.integrity).toBe('ok');

    // Existing v1 data survives, and the new v2 tables are usable.
    expect(core.handle('stallJournal.load', { teamName: 'demo' })).toHaveLength(1);
    expect(core.handle('commentJournal.exists', { teamName: 'demo' })).toBe(false);
    core.handle('commentJournal.ensureInitialized', { teamName: 'demo' });
    expect(core.handle('commentJournal.exists', { teamName: 'demo' })).toBe(true);
  });

  it('comment journal replace round-trips records and marks the team initialized', async () => {
    const dbPath = await makeTmpDbPath();
    const core = track(makeCore(dbPath));
    const record = {
      key: 'task-a:comment-1',
      teamName: 'команда-демо',
      taskId: 'task-a',
      commentId: 'comment-1',
      author: 'алиса',
      commentCreatedAt: null,
      messageId: 'msg-1',
      state: 'sent',
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
      sentAt: '2026-07-07T10:01:00.000Z',
    };

    expect(core.handle('commentJournal.exists', { teamName: record.teamName })).toBe(false);
    core.handle('commentJournal.replace', { teamName: record.teamName, entries: [record] });

    expect(core.handle('commentJournal.load', { teamName: record.teamName })).toEqual([record]);
    expect(core.handle('commentJournal.exists', { teamName: record.teamName })).toBe(true);
    expect(core.handle('commentJournal.load', { teamName: 'other' })).toEqual([]);

    // Replacing with an empty set keeps the initialization marker.
    core.handle('commentJournal.replace', { teamName: record.teamName, entries: [] });
    expect(core.handle('commentJournal.load', { teamName: record.teamName })).toEqual([]);
    expect(core.handle('commentJournal.exists', { teamName: record.teamName })).toBe(true);
  });
});
