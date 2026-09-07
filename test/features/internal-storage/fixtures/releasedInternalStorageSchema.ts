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
  version: 6 | 18 | 24 | 25 | 27 | 28
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
}
