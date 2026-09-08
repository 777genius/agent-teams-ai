import { createHash } from 'node:crypto';

import {
  readSchemaVersion,
  runInternalStorageMigrations,
} from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import { expect } from 'vitest';

import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

// Run the real migration prefix, stopping BEFORE the next transaction begins.
// No copied DDL, rewritten versions, swallowed migration errors or production hooks.
export function createReleasedInternalStorageSchema(
  db: Database,
  version: 6 | 7 | 8 | 9 | 10 | 17 | 18 | 20 | 21 | 22 | 24 | 25 | 27 | 28
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
  expectReleasedIdentitySchema(db);
}

// Only v29 changes v27/v28 DDL: remove its table (and attached triggers/indexes),
// then restore the exact released identity trigger. v28 itself is admission-only.
export function restorePrePublicationSchema(db: Database, version: 27 | 28): void {
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
