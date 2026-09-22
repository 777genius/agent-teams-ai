import { createHash } from 'node:crypto';

import { normalizeCurrentTeamIdentitySchema } from '@features/internal-storage/main/infrastructure/normalizeCurrentTeamIdentitySchema';
import { HOSTED_PROMOTION_STORAGE_MIGRATION } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageMigration';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';
import { describe, expect, it } from 'vitest';

import {
  addExpectedV31JournalColumnSql,
  removeExpectedV31JournalColumnSql,
} from './fixtures/releasedInternalStorageSchema';

const RELEASED_V30_REPORT_INTENTS_SQL = `CREATE TABLE member_work_sync_report_intents (
        team_name TEXT NOT NULL,
        id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        member_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        processed_at TEXT,
        result_code TEXT,
        request_json TEXT NOT NULL, team_key TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (team_name, id)
      )`;
const EXPECTED_V31_REPORT_INTENTS_SQL = `CREATE TABLE member_work_sync_report_intents (
        team_name TEXT NOT NULL,
        id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        member_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        processed_at TEXT,
        result_code TEXT,
        request_json TEXT NOT NULL, team_key TEXT NOT NULL DEFAULT '', journal_json TEXT,
        PRIMARY KEY (team_name, id)
      )`;
const EXPECTED_PROMOTION_DDL_ORDER = [
  'hosted_team_configuration_promotions',
  'hosted_promotions_no_replace',
  'hosted_promotions_freeze_replace',
  'hosted_promotions_publication_no_replace',
  'hosted_promotions_create_key_no_replace',
  'hosted_promotions_freeze_update_collision',
  'hosted_promotions_publication_update_collision',
  'hosted_promotions_create_key_update_collision',
  'hosted_promotions_create_key_no_update',
  'hosted_promotions_create_key_no_delete',
  'hosted_promotions_no_update',
  'hosted_promotions_no_delete',
  'hosted_promotions_freeze_update',
  'hosted_promotions_freeze_delete',
  'hosted_promotions_publication_tombstone',
] as const;

function releasedThrough(db: InstanceType<typeof Database>, version: 29 | 30) {
  const stop = new Error('prefix-complete');
  const proxy = new Proxy(db, { get(target, property) {
    if (property === 'transaction') return (operation: () => void) => {
      if (target.pragma('user_version', { simple: true }) === version) throw stop;
      return target.transaction(operation);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try { runInternalStorageMigrations(proxy); } catch (error) { if (error !== stop) throw error; }
  expect(db.pragma('user_version', { simple: true })).toBe(version);
}
const identitySchema = (db: InstanceType<typeof Database>) => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE tbl_name IN ('team_identity_records', 'legacy_team_key_reservations', 'team_adoption_intents', 'team_identity_storage_metadata')
  ORDER BY type, name, tbl_name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];

describe('promotion v30 append-only admission', () => {
  it('round-trips the pinned released v30 report SQL through its sole v31 addition', () => {
    expect(addExpectedV31JournalColumnSql(RELEASED_V30_REPORT_INTENTS_SQL))
      .toBe(EXPECTED_V31_REPORT_INTENTS_SQL);
    expect(removeExpectedV31JournalColumnSql(EXPECTED_V31_REPORT_INTENTS_SQL))
      .toBe(RELEASED_V30_REPORT_INTENTS_SQL);
  });

  it.each(['shared', 'distinct'] as const)('preserves every v29/v30 object and permits only the v31 journal SQL change in %s topology', (topology) => {
    const drafts = new Database(':memory:');
    const canonical = topology === 'shared' ? drafts : new Database(':memory:');
    const v30 = new Database(':memory:');
    try {
      releasedThrough(drafts, 29);
      if (canonical !== drafts) releasedThrough(canonical, 29);
      releasedThrough(v30, 30);
      const schemaBefore = drafts.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name').all();
      const v30Schema = v30.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name')
        .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
      const normalizedBefore = normalizeCurrentTeamIdentitySchema(identitySchema(canonical), 29);
      expect(normalizedBefore).toHaveLength(23);
      expect(createHash('sha256').update(JSON.stringify(normalizedBefore)).digest('hex'))
        .toBe('570be2f0773d8768848f2bef11c3cd70129199ac86730b055980fc46b90fdf36');
      expect(() => normalizeCurrentTeamIdentitySchema(identitySchema(canonical).map((object) =>
        object.name === 'trg_team_identity_transition' ? { ...object, sql: `${object.sql} ` } : object
      ), 29)).toThrow('incompatible');
      runInternalStorageMigrations(drafts);
      if (canonical !== drafts) runInternalStorageMigrations(canonical);
      const schemaAfter = drafts.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name')
        .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
      // Compare the complete v30 projection, rather than merely checking that
      // v29 objects are contained. The report table's exact appended v31
      // journal column is the only permitted SQL difference.
      const report = v30Schema.find(({ name }) => name === 'member_work_sync_report_intents');
      if (typeof report?.sql !== 'string') {
        throw new Error('released-v30-report-intents-schema-missing');
      }
      // This pins sqlite_master's released bytes, including the unusual ADD
      // COLUMN whitespace that must remain untouched by the fixture transform.
      expect(report.sql).toBe(RELEASED_V30_REPORT_INTENTS_SQL);
      expect(addExpectedV31JournalColumnSql(report.sql)).toBe(EXPECTED_V31_REPORT_INTENTS_SQL);
      expect(schemaAfter).toEqual(v30Schema.map((object) =>
        object.name === 'member_work_sync_report_intents'
          ? { ...object, sql: addExpectedV31JournalColumnSql(report.sql) }
          : object
      ));
      expect(schemaAfter.find(({ name }) => name === 'member_work_sync_report_intents')?.sql)
        .toBe(EXPECTED_V31_REPORT_INTENTS_SQL);
      // The explicit complete v30 comparison above retains every v29 object too.
      expect(v30Schema).toEqual(expect.arrayContaining(schemaBefore));
      expect(drafts.pragma('user_version', { simple: true })).toBe(31);
      expect((drafts.pragma('table_info(member_work_sync_report_intents)') as { cid: number; name: string }[])
        .find(({ name }) => name === 'journal_json')).toMatchObject({ cid: 11, name: 'journal_json' });
      expect(normalizeCurrentTeamIdentitySchema(identitySchema(canonical), 31)).toEqual(normalizedBefore);
      expect(drafts.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
      expect(drafts.pragma('foreign_key_check')).toEqual([]);
      const trigger = identitySchema(canonical).find(
        (object) => object.name === 'trg_team_identity_transition'
      );
      if (trigger === undefined || trigger.sql === null) {
        throw new Error('team-identity-transition-trigger-schema-missing');
      }
      expect(() =>
        normalizeCurrentTeamIdentitySchema(
          identitySchema(canonical).map((object) =>
            object.name === trigger.name ? { ...object, sql: `${trigger.sql} ` } : object
          ),
          31
        )
      ).toThrow('incompatible');
    } finally { v30.close(); if (canonical !== drafts) canonical.close(); drafts.close(); }
  });
  it('adds only focused promotion objects and retains historical migration numbering', () => {
    expect(HOSTED_PROMOTION_STORAGE_MIGRATION.version).toBe(30);
    expect(HOSTED_PROMOTION_STORAGE_MIGRATION.statements.every((sql) => sql.startsWith('CREATE '))).toBe(true);
    expect(
      HOSTED_PROMOTION_STORAGE_MIGRATION.statements.map((sql) =>
        /^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/u.exec(sql)?.[1]
      )
    ).toEqual(EXPECTED_PROMOTION_DDL_ORDER);
  });
});
