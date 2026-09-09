import { HOSTED_PROMOTION_STORAGE_MIGRATION } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageMigration';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import Database from 'better-sqlite3-node';
import { describe, expect, it } from 'vitest';

import { seedCurrentPublicationRestore } from './fixtures/currentPublicationRestore';
import {
  createReleasedInternalStorageSchema,
  restoreReleasedV29Schema,
} from './fixtures/releasedInternalStorageSchema';

function snapshot(db: InstanceType<typeof Database>) {
  return ['main', 'temp'].map((schema) => ({
    objects: db.prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema ORDER BY name`).all(),
    rows: (db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[]).map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT * FROM ${schema}."${name.replace(/"/g, '""')}" ORDER BY rowid`).all(),
    })),
  }));
}

const corruptions = [
  ['missing guard', 'DROP TRIGGER hosted_promotions_no_update'],
  ['changed guard', `DROP TRIGGER hosted_promotions_no_update;
    CREATE TRIGGER hosted_promotions_no_update BEFORE UPDATE ON hosted_team_configuration_promotions
    BEGIN SELECT RAISE(ABORT, 'different bytes'); END`],
  ['extra index', 'CREATE INDEX extra_promotion_index ON hosted_team_configuration_promotions(actor_id)'],
  ['ASCII reserved name', `CREATE TABLE unrelated (value TEXT);
    CREATE INDEX HoStEd_PrOmOtIoNs_unexpected ON unrelated(value)`],
  ['TEMP shadow', 'CREATE TEMP VIEW HOSTED_TEAM_CONFIGURATION_PROMOTIONS AS SELECT 1 AS value'],
  ['TEMP dependency', 'CREATE TEMP TABLE HoStEd_TeAm_CoNfIgUrAtIoN_DrAfTs (value TEXT)'],
  ['TEMP trigger', `CREATE TEMP TRIGGER unexpected BEFORE UPDATE ON main.hosted_team_configuration_publications
    BEGIN SELECT RAISE(ABORT, 'unexpected'); END`],
  ['main foreign key graph', `PRAGMA foreign_keys = OFF;
    CREATE TABLE parent_probe (id INTEGER PRIMARY KEY);
    CREATE TABLE child_probe (parent_id INTEGER REFERENCES parent_probe(id));
    INSERT INTO child_probe VALUES (1)`],
  ['TEMP foreign key graph', `PRAGMA foreign_keys = OFF;
    CREATE TEMP TABLE parent_probe (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE child_probe (parent_id INTEGER REFERENCES parent_probe(id));
    INSERT INTO temp.child_probe VALUES (1)`],
  ['stored CHECK graph', `PRAGMA ignore_check_constraints = ON;
    CREATE TABLE check_probe (value INTEGER CHECK (value > 0));
    INSERT INTO check_probe VALUES (-1);
    PRAGMA ignore_check_constraints = OFF`],
  ['disabled CHECK enforcement', 'PRAGMA ignore_check_constraints = ON'],
] as const;

describe('strict composed v30 restore', () => {
  it('projects only validated empty v30 additions back to the genuine v29 prefix', () => {
    const db = new Database(':memory:');
    const reference = new Database(':memory:');
    try {
      runInternalStorageMigrations(db);
      seedCurrentPublicationRestore(db);
      createReleasedInternalStorageSchema(reference, 29);
      seedCurrentPublicationRestore(reference);
      restoreReleasedV29Schema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(29);
      expect(snapshot(db)).toEqual(snapshot(reference));
      runInternalStorageMigrations(db);
      expect(db.pragma('user_version', { simple: true })).toBe(30);
    } finally { reference.close(); db.close(); }
  });

  it.each(corruptions)('rejects %s without changing main/TEMP state or marker', (_label, sql) => {
    const db = new Database(':memory:');
    try {
      runInternalStorageMigrations(db);
      seedCurrentPublicationRestore(db);
      db.exec(sql);
      const before = snapshot(db);
      expect(() => restoreReleasedV29Schema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(30);
      expect(snapshot(db)).toEqual(before);
      for (const marker of [28, 29]) {
        db.pragma(`user_version = ${marker}`);
        expect(() => runInternalStorageMigrations(db)).toThrow();
        expect(db.pragma('user_version', { simple: true })).toBe(marker);
        expect(snapshot(db)).toEqual(before);
      }
    } finally { db.close(); }
  });

  it.each(HOSTED_PROMOTION_STORAGE_MIGRATION.statements.map((sql, index) => ({
    name: /^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/u.exec(sql)?.[1], index,
  })))('requires exact retained SQL for $name', ({ index }) => {
    const db = new Database(':memory:');
    try {
      runInternalStorageMigrations(db);
      for (const sql of [...HOSTED_PROMOTION_STORAGE_MIGRATION.statements].reverse()) {
        const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql)!;
        db.exec(`DROP ${match[1]} main.${match[2]}`);
      }
      HOSTED_PROMOTION_STORAGE_MIGRATION.statements.forEach((sql, current) => {
        db.exec(current !== index ? sql : sql.replace('2097152', '2097153').replace('RAISE(ABORT', 'RAISE(FAIL'));
      });
      const before = snapshot(db);
      expect(() => restoreReleasedV29Schema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(30);
      for (const marker of [28, 29]) {
        db.pragma(`user_version = ${marker}`);
        expect(() => runInternalStorageMigrations(db)).toThrow();
        expect(db.pragma('user_version', { simple: true })).toBe(marker);
        expect(snapshot(db)).toEqual(before);
      }
    } finally { db.close(); }
  });

  it('keeps the v30 backup fence ahead of graph admission and DDL', () => {
    const db = new Database(':memory:');
    try {
      createReleasedInternalStorageSchema(db, 29);
      db.exec(`INSERT INTO coordination_backup_runs
        (backup_run_id, deployment_id, state, revision, fence_completion_status, record_json, requested_at, updated_at)
        VALUES ('backup', 'deployment', 'sqlite_snapshot', 1, NULL, '{}', 'now', 'now');
        INSERT INTO coordination_backup_writer_fences
        (deployment_id, generation, admitted_run_id, lease_id, status, disposition, acquired_at, completed_at)
        VALUES ('deployment', 1, 'backup', 'lease', 'active', NULL, 'now', NULL)`);
      const before = snapshot(db);
      expect(() => runInternalStorageMigrations(db)).toThrow('internal-storage-v30-migration-backup-fenced');
      expect(db.pragma('user_version', { simple: true })).toBe(29);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });

  it('rejects an invalid identity graph even with exact schema and valid SQL constraints', () => {
    const db = new Database(':memory:');
    try {
      runInternalStorageMigrations(db);
      seedCurrentPublicationRestore(db);
      const trigger = TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.find(
        ({ name }) => name === 'trg_legacy_team_key_transition'
      )!.sql!;
      db.exec('DROP TRIGGER main.trg_legacy_team_key_transition');
      db.exec("UPDATE main.legacy_team_key_reservations SET reserved_at = '2026-08-03T18:00:00.000Z'");
      db.exec(trigger);
      const before = snapshot(db);
      expect(() => restoreReleasedV29Schema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(30);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });

  it.each(['main', 'temp'])('refuses an unknown %s object in the historical projection', (schema) => {
    const db = new Database(':memory:');
    try {
      runInternalStorageMigrations(db);
      db.exec(`CREATE TABLE ${schema}.unknown_projection_object (value TEXT)`);
      const before = snapshot(db);
      expect(() => restoreReleasedV29Schema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(30);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });

  it('never deletes a retained promotion to manufacture a historical fixture', () => {
    const db = new Database(':memory:');
    try {
      runInternalStorageMigrations(db);
      seedCurrentPublicationRestore(db);
      db.exec(`INSERT INTO hosted_team_configuration_promotions
        SELECT operation_id, workspace_id, team_id, actor_id, deployment_id, 'key', '{}'
        FROM hosted_team_configuration_publications`);
      const before = snapshot(db);
      expect(() => restoreReleasedV29Schema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(30);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });

  it('rolls back v30 DDL and marker when the final guard creation fails', () => {
    const db = new Database(':memory:');
    try {
      createReleasedInternalStorageSchema(db, 29);
      const before = snapshot(db);
      const failure = new Error('injected-v30-last-guard-failure');
      const observed = new Proxy(db, { get(target, property) {
        if (property === 'exec') return (sql: string) => {
          if (sql === HOSTED_PROMOTION_STORAGE_MIGRATION.statements.at(-1)) throw failure;
          return target.exec(sql);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      expect(() => runInternalStorageMigrations(observed)).toThrow(failure);
      expect(db.pragma('user_version', { simple: true })).toBe(29);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });
});
