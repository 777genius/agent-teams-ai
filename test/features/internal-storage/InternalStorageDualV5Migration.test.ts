import {
  INTERNAL_STORAGE_SCHEMA_VERSION,
  readSchemaVersion,
  runInternalStorageMigrations,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleasedInternalStorageSchema } from './fixtures/releasedInternalStorageSchema';

const databases: Database.Database[] = [];

function openDatabase(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
}

function migrateThrough(db: Database.Database, version: 4 | 5): void {
  const complete = new Error('migration-prefix-complete');
  const prefix = new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (operation: () => void) => {
          if (readSchemaVersion(target) === version) throw complete;
          return target.transaction(operation);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    runInternalStorageMigrations(prefix);
  } catch (error) {
    if (error !== complete) throw error;
  }
  expect(readSchemaVersion(db)).toBe(version);
}

function createMainV5(db: Database.Database): void {
  // Main's independent v5 starts from the genuine released v4 prefix.
  // Do not manufacture it by altering a later/current schema.
  createReleasedInternalStorageSchema(db, 4);
  db.exec('ALTER TABLE member_work_sync_report_intents ADD COLUMN journal_json TEXT');
  db.pragma('user_version = 5');
  db.prepare(`INSERT INTO member_work_sync_report_intents (
    team_name, id, member_key, member_name, status, reason, recorded_at,
    request_json, journal_json
  ) VALUES ('sandbox', 'intent-1', 'lead', 'lead', 'pending', 'test',
    '2026-09-15T00:00:00.000Z', '{}', '{"entries":["retained"]}')`).run();
}

function expectConverged(db: Database.Database): void {
  expect(readSchemaVersion(db)).toBe(INTERNAL_STORAGE_SCHEMA_VERSION);
  expect(db.prepare(
    'SELECT component, schema_version FROM team_identity_storage_metadata'
  ).all()).toEqual([{ component: 'team-identity', schema_version: 1 }]);
  expect((db.pragma('table_info(member_work_sync_report_intents)') as { name: string }[])
    .some(({ name }) => name === 'journal_json')).toBe(true);
  expect(db.pragma('foreign_key_check')).toEqual([]);
}

function schema(db: Database.Database): unknown[] {
  return db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name"
  ).all();
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('internal-storage dual-v5 migration admission', () => {
  it('creates both v5 lineages for a fresh database', () => {
    const db = openDatabase();
    runInternalStorageMigrations(db);
    expectConverged(db);
  });

  it('upgrades Product v5 and adds main v5 journal storage', () => {
    const db = openDatabase();
    migrateThrough(db, 5);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'team_identity_records'").get())
      .toEqual({ name: 'team_identity_records' });
    expect((db.pragma('table_info(member_work_sync_report_intents)') as { name: string }[])
      .some(({ name }) => name === 'journal_json')).toBe(false);

    runInternalStorageMigrations(db);
    expectConverged(db);
  });

  it('upgrades main v5 without relabeling it early or changing journal data', () => {
    const db = openDatabase();
    createMainV5(db);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'team_identity_records'").get())
      .toBeUndefined();

    runInternalStorageMigrations(db);

    expectConverged(db);
    expect(db.prepare(
      'SELECT id, request_json, journal_json FROM member_work_sync_report_intents'
    ).all()).toEqual([{
      id: 'intent-1', request_json: '{}', journal_json: '{"entries":["retained"]}',
    }]);
  });

  it('re-admits an already-v31 database idempotently without changing schema or data', () => {
    const db = openDatabase();
    runInternalStorageMigrations(db);
    db.prepare(`INSERT INTO member_work_sync_report_intents (
      team_name, id, member_key, member_name, status, reason, recorded_at,
      request_json, journal_json
    ) VALUES ('sandbox', 'intent-31', 'lead', 'lead', 'pending', 'test',
      '2026-09-15T00:00:00.000Z', '{}', '{"retained":true}')`).run();
    const before = schema(db);

    runInternalStorageMigrations(db);

    expectConverged(db);
    expect(schema(db)).toEqual(before);
    expect(db.prepare('SELECT journal_json FROM member_work_sync_report_intents').pluck().get())
      .toBe('{"retained":true}');
  });

  it('rejects a tampered v31 journal definition without advancing or repairing it', () => {
    const db = openDatabase();
    runInternalStorageMigrations(db);
    db.exec(`ALTER TABLE member_work_sync_report_intents RENAME COLUMN journal_json TO journal_json_old;
      ALTER TABLE member_work_sync_report_intents ADD COLUMN journal_json INTEGER`);
    const before = schema(db);

    expect(() => runInternalStorageMigrations(db))
      .toThrow('internal-storage-v31-report-journal-schema-incompatible');
    expect(readSchemaVersion(db)).toBe(34);
    expect(schema(db)).toEqual(before);
  });

  it('rejects a partial Product identity component without advancing or repairing it', () => {
    const db = openDatabase();
    createMainV5(db);
    db.exec(`CREATE TABLE team_identity_storage_metadata (
      component TEXT PRIMARY KEY CHECK (component = 'team-identity'),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1)
    )`);
    db.prepare('INSERT INTO team_identity_storage_metadata VALUES (?, ?)')
      .run('team-identity', 1);
    const before = schema(db);

    expect(() => runInternalStorageMigrations(db))
      .toThrow('internal-storage-v31-team-identity-schema-incompatible');
    expect(readSchemaVersion(db)).toBe(5);
    expect(schema(db)).toEqual(before);
    expect(db.prepare('SELECT journal_json FROM member_work_sync_report_intents').pluck().get())
      .toBe('{"entries":["retained"]}');
  });

  it('rolls back an interrupted main-v5 identity replay atomically', () => {
    const db = openDatabase();
    createMainV5(db);
    const before = schema(db);
    const injected = new Error('injected-identity-replay-failure');
    const failing = new Proxy(db, {
      get(target, property) {
        if (property === 'exec') {
          return (statement: string) => {
            if (statement.includes('CREATE TABLE IF NOT EXISTS team_identity_records')) throw injected;
            return target.exec(statement);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    expect(() => runInternalStorageMigrations(failing)).toThrow(injected);
    expect(readSchemaVersion(db)).toBe(5);
    expect(schema(db)).toEqual(before);
    expect(db.prepare('SELECT journal_json FROM member_work_sync_report_intents').pluck().get())
      .toBe('{"entries":["retained"]}');
  });
});
