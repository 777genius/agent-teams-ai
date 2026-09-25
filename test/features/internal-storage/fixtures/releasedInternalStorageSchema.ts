import { createHash } from 'node:crypto';

import { readRetainedPromotionObjects } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionMigrationAdmission';
import { HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION, runHostedPromotionRosterBindingMigrationAdmission } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionRosterBindingMigration';
import { HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION, runHostedLifecycleRunReservationMigrationAdmission } from '@features/internal-storage/main/infrastructure/worker/hostedLifecycleRunReservationMigration';
import { HOSTED_PROMOTION_STORAGE_MIGRATION } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageMigration';
import {
  readSchemaVersion,
  runInternalStorageMigrations,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { runTeamDraftPublicationMigrationAdmission } from '@features/internal-storage/main/infrastructure/worker/teamDraftPublicationMigrationAdmission';
import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import DatabaseFixture from 'better-sqlite3-node';
import { expect } from 'vitest';

import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

// Run the real migration prefix, stopping BEFORE the next transaction begins.
// No copied DDL, rewritten versions, swallowed migration errors or production hooks.
export function createReleasedInternalStorageSchema(
  db: Database,
  version: 4 | 6 | 7 | 8 | 9 | 10 | 17 | 18 | 20 | 21 | 22 | 24 | 25 | 27 | 28 | 29 | 30 | 31 | 32
): void {
  expect(readSchemaVersion(db)).toBe(0);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
  const prefixComplete = new Error('released-schema-prefix-complete');
  const prefix = new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (operation: () => void) => {
          if (readSchemaVersion(target) === version) throw prefixComplete;
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
    if (error !== prefixComplete) throw error;
  }
  expect(readSchemaVersion(db)).toBe(version);
  if (version >= 5 && version < 29) expectReleasedIdentitySchema(db);
}

const schema = (namespace: 'main' | 'temp') =>
  `SELECT type, name, tbl_name, sql FROM ${namespace}.sqlite_schema ORDER BY type, name, tbl_name`;
const REPORT_INTENTS = 'member_work_sync_report_intents';
const JOURNAL_COLUMN_SQL = ' journal_json TEXT,';

/**
 * SQLite's ADD COLUMN inserts at the delimiter immediately before the first
 * table constraint, retaining every surrounding byte. Locate that structural
 * anchor instead of assuming the formatting of a released CREATE TABLE.
 */
function journalColumnAnchor(sql: string): number {
  let depth = 0;
  let opening = -1;
  const anchors: number[] = [];
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote) {
        if ((quote === "'" || quote === '"') && sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') {
      quote = ']';
      continue;
    }
    if (character === '(') {
      if (depth === 0) opening = index;
      depth += 1;
      continue;
    }
    if (character === ',' && depth === 1 && /^\s*PRIMARY\s+KEY\b/iu.test(sql.slice(index + 1))) {
      anchors.push(index + 1);
      continue;
    }
    if (character !== ')') continue;
    depth -= 1;
    if (depth === 0 && opening >= 0 && /^\s*$/u.test(sql.slice(index + 1))) break;
  }
  if (anchors.length === 1) return anchors[0]!;
  throw new Error('released-v30-report-intents-schema-missing-unambiguous-journal-anchor');
}

export function addExpectedV31JournalColumnSql(releasedSql: string): string {
  const anchor = journalColumnAnchor(releasedSql);
  return `${releasedSql.slice(0, anchor)}${JOURNAL_COLUMN_SQL}${releasedSql.slice(anchor)}`;
}

export function removeExpectedV31JournalColumnSql(currentSql: string): string {
  const anchor = journalColumnAnchor(currentSql);
  const journalStart = anchor - JOURNAL_COLUMN_SQL.length;
  if (currentSql.slice(journalStart, anchor) !== JOURNAL_COLUMN_SQL) {
    throw new Error('current-v31-report-intents-schema-missing-exact-journal-column');
  }
  // journalColumnAnchor points just after the journal segment in v31. Remove
  // that exact added segment only, leaving the released prefix/suffix bytes
  // (including their historical whitespace) untouched.
  return `${currentSql.slice(0, journalStart)}${currentSql.slice(anchor)}`;
}

/** The sole v31 schema difference is an appended nullable report journal. */
function assertExactV31JournalProjection(db: Database, reference: Database): void {
  const current = db.prepare(schema('main')).all() as { name: string; sql: string | null }[];
  const released = reference.prepare(schema('main')).all() as { name: string; sql: string | null }[];
  const currentReport = current.filter(({ name }) => name === REPORT_INTENTS);
  const releasedReport = released.filter(({ name }) => name === REPORT_INTENTS);
  expect(current.filter(({ name }) => name !== REPORT_INTENTS))
    .toEqual(released.filter(({ name }) => name !== REPORT_INTENTS));
  expect(currentReport).toHaveLength(1);
  expect(releasedReport).toHaveLength(1);
  const releasedSql = releasedReport[0]?.sql;
  if (typeof releasedSql !== 'string') {
    throw new Error('released-v30-report-intents-schema-missing');
  }
  const expectedV31Sql = addExpectedV31JournalColumnSql(releasedSql);
  // The transforms are deliberately inverse byte edits: all historical DDL
  // bytes, including whitespace and newlines, survive the v31 projection.
  expect(removeExpectedV31JournalColumnSql(expectedV31Sql)).toBe(releasedSql);
  expect(currentReport[0]).toEqual({
    ...releasedReport[0],
    sql: expectedV31Sql,
  });
  expect(db.prepare(schema('temp')).all()).toEqual(reference.prepare(schema('temp')).all());
}

function restoreReleasedV30SchemaInTransaction(db: Database, reference: Database): void {
  const journalColumn = (db.pragma('table_info(member_work_sync_report_intents)') as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[]).find(({ name }) => name === 'journal_json');
  // v9 appended team_key at cid 10; v31 appends journal_json at cid 11.
  expect(journalColumn).toEqual({
    cid: 11,
    name: 'journal_json',
    type: 'TEXT',
    notnull: 0,
    dflt_value: null,
    pk: 0,
  });
  assertExactV31JournalProjection(db, reference);
  const v31Sql = db.prepare(
    "SELECT sql FROM main.sqlite_schema WHERE name = 'member_work_sync_report_intents'"
  ).get() as { sql: string } | undefined;
  if (typeof v31Sql?.sql !== 'string') throw new Error('current-v31-report-intents-schema-missing');
  expect(db.prepare(
    'SELECT COUNT(*) AS count FROM member_work_sync_report_intents WHERE journal_json IS NOT NULL'
  ).get()).toEqual({ count: 0 });
  db.exec('ALTER TABLE member_work_sync_report_intents DROP COLUMN journal_json');
  db.pragma('user_version = 30');
  const restoredSql = db.prepare(
    "SELECT sql FROM main.sqlite_schema WHERE name = 'member_work_sync_report_intents'"
  ).get() as { sql: string } | undefined;
  expect(restoredSql?.sql).toBe(removeExpectedV31JournalColumnSql(v31Sql.sql));
  expect(db.prepare(schema('main')).all()).toEqual(reference.prepare(schema('main')).all());
  expect(db.prepare(schema('temp')).all()).toEqual(reference.prepare(schema('temp')).all());
}

function restoreReleasedV31SchemaInTransaction(db: Database, reference: Database): void {
  expect(readSchemaVersion(db)).toBe(32);
  runHostedPromotionRosterBindingMigrationAdmission(db);
  expect(db.prepare('SELECT * FROM hosted_promotion_roster_bindings').all()).toEqual([]);
  const names = new Set(HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION.statements.map((sql) =>
    /^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/u.exec(sql)?.[1]));
  names.add('sqlite_autoindex_hosted_promotion_roster_bindings_1');
  const current = db.prepare(schema('main')).all() as { name: string }[];
  expect(current.filter(({ name }) => !names.has(name))).toEqual(reference.prepare(schema('main')).all());
  expect(db.prepare(schema('temp')).all()).toEqual(reference.prepare(schema('temp')).all());
  for (const sql of [...HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION.statements].reverse()) {
    const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql);
    if (!match) throw new Error('unexpected-roster-binding-schema-object');
    db.exec(`DROP ${match[1]} main.${match[2]}`);
  }
  db.pragma('user_version = 31');
  expect(db.prepare(schema('main')).all()).toEqual(reference.prepare(schema('main')).all());
}

function restoreReleasedV32SchemaInTransaction(db: Database, reference: Database): void {
  expect(readSchemaVersion(db)).toBe(33);
  runHostedLifecycleRunReservationMigrationAdmission(db, true);
  expect(db.prepare('SELECT * FROM hosted_lifecycle_run_reservations').all()).toEqual([]);
  const names = new Set(HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION.statements.map((sql) =>
    /^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/u.exec(sql)?.[1]));
  for (let index = 1; index <= 4; index += 1)
    names.add(`sqlite_autoindex_hosted_lifecycle_run_reservations_${index}`);
  const current = db.prepare(schema('main')).all() as { name: string }[];
  expect(current.filter(({ name }) => !names.has(name))).toEqual(reference.prepare(schema('main')).all());
  expect(db.prepare(schema('temp')).all()).toEqual(reference.prepare(schema('temp')).all());
  for (const sql of [...HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION.statements].reverse()) {
    const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql);
    if (!match) throw new Error('unexpected-run-reservation-schema-object');
    db.exec(`DROP ${match[1]} main.${match[2]}`);
  }
  db.pragma('user_version = 32');
  expect(db.prepare(schema('main')).all()).toEqual(reference.prepare(schema('main')).all());
}

/**
 * Test-only projection of the current v31 schema to the exact released v30
 * snapshot. v31's nullable journal column must be empty and byte-for-byte
 * compatible before it is removed; no unknown current state is discarded.
 */
export function restoreReleasedV30Schema(db: Database): void {
  expect([31, 32, 33]).toContain(readSchemaVersion(db));
  const reference = new DatabaseFixture(':memory:');
  const v31Reference = readSchemaVersion(db) >= 32 ? new DatabaseFixture(':memory:') : null;
  const v32Reference = readSchemaVersion(db) === 33 ? new DatabaseFixture(':memory:') : null;
  try {
    createReleasedInternalStorageSchema(reference, 30);
    if (v31Reference) createReleasedInternalStorageSchema(v31Reference, 31);
    if (v32Reference) createReleasedInternalStorageSchema(v32Reference, 32);
    db.transaction(() => {
      if (v32Reference) restoreReleasedV32SchemaInTransaction(db, v32Reference);
      if (v31Reference) restoreReleasedV31SchemaInTransaction(db, v31Reference);
      restoreReleasedV30SchemaInTransaction(db, reference);
    })();
  } finally {
    v32Reference?.close();
    v31Reference?.close();
    reference.close();
  }
  expect(readSchemaVersion(db)).toBe(30);
}

// Test-only current-to-released projection. Check every v30 object before
// removing it, then compare the COMPLETE remaining schema with a real v29
// migration prefix. Never relabel current DDL as a historical fixture.
export function restoreReleasedV29Schema(db: Database): void {
  const current = readSchemaVersion(db);
  expect(current === 30 || current === 31 || current === 32 || current === 33).toBe(true);
  const v29Reference = new DatabaseFixture(':memory:');
  const v30Reference = current >= 31 ? new DatabaseFixture(':memory:') : null;
  const v31Reference = current >= 32 ? new DatabaseFixture(':memory:') : null;
  const v32Reference = current === 33 ? new DatabaseFixture(':memory:') : null;
  try {
    createReleasedInternalStorageSchema(v29Reference, 29);
    if (v30Reference) createReleasedInternalStorageSchema(v30Reference, 30);
    if (v31Reference) createReleasedInternalStorageSchema(v31Reference, 31);
    if (v32Reference) createReleasedInternalStorageSchema(v32Reference, 32);
    db.transaction(() => {
      // Keep v31 -> v30 -> v29 validation and both marker changes inside this
      // single transaction. A v30 rejection must not leave a partial v30 projection.
      if (v32Reference) restoreReleasedV32SchemaInTransaction(db, v32Reference);
      if (v31Reference) restoreReleasedV31SchemaInTransaction(db, v31Reference);
      if (v30Reference) restoreReleasedV30SchemaInTransaction(db, v30Reference);
      expect(readSchemaVersion(db)).toBe(30);
      // Validate the complete main/TEMP schema and data graph BEFORE any drop.
      const retained = readRetainedPromotionObjects(db);
      expect(retained.length).toBeGreaterThan(0);
      runTeamDraftPublicationMigrationAdmission(db, true);
      expect(db.prepare('SELECT * FROM main.hosted_team_configuration_promotions').all()).toEqual([]);
      const names = new Set(retained.map((object) => object.name));
      const main = db.prepare(schema('main')).all() as { name: string }[];
      expect(main.filter((object) => !names.has(object.name)))
        .toEqual(v29Reference.prepare(schema('main')).all());
      expect(db.prepare(schema('temp')).all()).toEqual(v29Reference.prepare(schema('temp')).all());
      const objects = HOSTED_PROMOTION_STORAGE_MIGRATION.statements.map((statement) => {
        const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(statement);
        if (!match) throw new Error('unexpected-promotion-schema-object');
        const [, type, name] = match;
        expect(db.prepare('SELECT sql FROM main.sqlite_schema WHERE name = ?').get(name))
          .toEqual({ sql: statement });
        return { type, name };
      });
      for (const { type, name } of [...objects].reverse()) db.exec(`DROP ${type} main.${name}`);
      db.pragma('user_version = 29');
      expect(db.prepare(schema('main')).all()).toEqual(v29Reference.prepare(schema('main')).all());
      expect(db.prepare(schema('temp')).all()).toEqual(v29Reference.prepare(schema('temp')).all());
    })();
  } finally {
    v32Reference?.close();
    v30Reference?.close();
    v31Reference?.close();
    v29Reference.close();
  }
  expect(readSchemaVersion(db)).toBe(29);
}

// Only v29 changes v27/v28 DDL: remove its table (and attached triggers/indexes),
// then restore the exact released identity trigger. v28 itself is admission-only.
export function restorePrePublicationSchema(db: Database, version: 27 | 28): void {
  if ([30, 31, 32, 33].includes(readSchemaVersion(db))) restoreReleasedV29Schema(db);
  expect(readSchemaVersion(db)).toBe(29);
  const oldTrigger = TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS.find((statement) =>
    statement.startsWith('CREATE TRIGGER IF NOT EXISTS trg_team_identity_transition\n')
  );
  if (!oldTrigger) throw new Error('released-identity-transition-missing');
  db.transaction(() => {
    db.exec('DROP TABLE hosted_team_configuration_publications');
    db.exec('DROP TRIGGER trg_team_identity_transition');
    db.exec(oldTrigger);
    db.pragma(`user_version = ${version}`);
  })();
  expect(readSchemaVersion(db)).toBe(version);
  expectReleasedIdentitySchema(db);
}

function expectReleasedIdentitySchema(db: Database): void {
  const oldTrigger = TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS.find((statement) =>
    statement.startsWith('CREATE TRIGGER IF NOT EXISTS trg_team_identity_transition\n')
  );
  if (!oldTrigger) throw new Error('released-identity-transition-missing');
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name = 'hosted_team_configuration_publications'").all()).toEqual([]);
  expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'trg_team_identity_transition'").get()).toEqual({
    sql: oldTrigger.replace(' IF NOT EXISTS', ''),
  });
  const identityObjects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE tbl_name IN ('legacy_team_key_reservations', 'team_adoption_intents',
      'team_identity_records', 'team_identity_storage_metadata')
    ORDER BY type, name, tbl_name`).all();
  // Pin the complete retained v5 component, including autoindexes and trigger bytes.
  expect(identityObjects).toHaveLength(23);
  expect(createHash('sha256').update(JSON.stringify(identityObjects)).digest('hex'))
    .toBe('570be2f0773d8768848f2bef11c3cd70129199ac86730b055980fc46b90fdf36');
  expect(db.prepare('SELECT component, schema_version FROM team_identity_storage_metadata').all())
    .toEqual([{ component: 'team-identity', schema_version: 1 }]);
}
