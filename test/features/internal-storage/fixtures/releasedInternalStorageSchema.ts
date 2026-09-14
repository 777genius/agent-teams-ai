import { createHash } from 'node:crypto';

import { readRetainedPromotionObjects } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionMigrationAdmission';
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
  version: 6 | 7 | 8 | 9 | 10 | 17 | 18 | 20 | 21 | 22 | 24 | 25 | 27 | 28 | 29
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
  if (version < 29) expectReleasedIdentitySchema(db);
}

// Test-only current-to-released projection. Check every v30 object before
// removing it, then compare the COMPLETE remaining schema with a real v29
// migration prefix. Never relabel current DDL as a historical fixture.
export function restoreReleasedV29Schema(db: Database): void {
  expect(readSchemaVersion(db)).toBe(30);
  const reference = new DatabaseFixture(':memory:');
  try {
    createReleasedInternalStorageSchema(reference, 29);
    db.transaction(() => {
      const schema = (namespace: 'main' | 'temp') =>
        `SELECT type, name, tbl_name, sql FROM ${namespace}.sqlite_schema ORDER BY type, name, tbl_name`;
      // Validate the complete main/TEMP schema and data graph BEFORE any drop.
      const retained = readRetainedPromotionObjects(db);
      expect(retained.length).toBeGreaterThan(0);
      runTeamDraftPublicationMigrationAdmission(db, true);
      expect(db.prepare('SELECT * FROM main.hosted_team_configuration_promotions').all()).toEqual([]);
      const names = new Set(retained.map((object) => object.name));
      const main = db.prepare(schema('main')).all() as { name: string }[];
      expect(main.filter((object) => !names.has(object.name)))
        .toEqual(reference.prepare(schema('main')).all());
      expect(db.prepare(schema('temp')).all()).toEqual(reference.prepare(schema('temp')).all());
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
      expect(db.prepare(schema('main')).all()).toEqual(reference.prepare(schema('main')).all());
      expect(db.prepare(schema('temp')).all()).toEqual(reference.prepare(schema('temp')).all());
    })();
  } finally {
    reference.close();
  }
  expect(readSchemaVersion(db)).toBe(29);
}

// Only v29 changes v27/v28 DDL: remove its table (and attached triggers/indexes),
// then restore the exact released identity trigger. v28 itself is admission-only.
export function restorePrePublicationSchema(db: Database, version: 27 | 28): void {
  if (readSchemaVersion(db) === 30) restoreReleasedV29Schema(db);
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
