import { normalizeCurrentTeamIdentitySchema } from '@features/internal-storage/main/infrastructure/normalizeCurrentTeamIdentitySchema';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { createTeamLifecycleReadOnlyIdentitySource } from '@main/composition/hosted/teamLifecycleReadOnlyIdentitySource';
import Database from 'better-sqlite3-node';
import { describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => import('better-sqlite3-node'));

type SqliteDatabase = InstanceType<typeof Database>;

function migrateThrough(database: SqliteDatabase, version: 32 | 33 | 34 | 35): void {
  if (version === 35) {
    runInternalStorageMigrations(database);
    return;
  }
  const stop = new Error('v32-ready');
  const proxy = new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') return (operation: () => void) => {
        if (target.pragma('user_version', { simple: true }) === version) throw stop;
        return target.transaction(operation);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    runInternalStorageMigrations(proxy);
  } catch (error) {
    if (error !== stop) throw error;
  }
}

function identitySchema(database: SqliteDatabase) {
  return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE tbl_name IN ('team_identity_records', 'legacy_team_key_reservations',
      'team_adoption_intents', 'team_identity_storage_metadata')
    ORDER BY type, name, tbl_name`).all() as Array<{
      type: string; name: string; tbl_name: string; sql: string | null;
    }>;
}

describe('current team identity read admission', () => {
  it.each([32, 33, 34, 35] as const)('keeps the lifecycle identity source ready for a v%d writer snapshot', async (version) => {
    const writer = new Database(':memory:');
    try {
      migrateThrough(writer, version);
      const source = await createTeamLifecycleReadOnlyIdentitySource({
        appDataRoot: '/tmp/current-team-identity-read-test',
        currentWriter: {
          appDataRoot: '/tmp/current-team-identity-read-test',
          readSnapshot: async () => writer.serialize(),
        },
      });
      expect(source).not.toBeNull();
      expect(await source?.listTeamIdentities()).toEqual([]);
    } finally {
      writer.close();
    }
  });

  it.each([32, 33, 34, 35] as const)('admits the exact read-only v%d schema and rejects a changed migration trigger', (version) => {
    const writable = new Database(':memory:');
    try {
      migrateThrough(writable, version);
      expect(writable.pragma('user_version', { simple: true })).toBe(version);
      const snapshot = new Database(writable.serialize(), { readonly: true });
      try {
        expect(normalizeCurrentTeamIdentitySchema(identitySchema(snapshot), version, snapshot))
          .toHaveLength(23);
      } finally {
        snapshot.close();
      }
      writable.exec(version === 32
        ? 'DROP TRIGGER hosted_roster_bindings_no_update'
        : version === 33
          ? 'DROP TRIGGER hosted_run_reservations_no_update'
          : version === 34
            ? 'DROP TRIGGER hosted_run_aliases_no_update'
            : 'DROP TRIGGER hosted_lifecycle_current_runs_no_delete');
      expect(() => normalizeCurrentTeamIdentitySchema(identitySchema(writable), version, writable))
        .toThrow('schema-incompatible');
    } finally {
      writable.close();
    }
  });

  it('rejects lowered markers on a v35 database and an unknown future marker', () => {
    const database = new Database(':memory:');
    try {
      runInternalStorageMigrations(database);
      const objects = identitySchema(database);
      database.pragma('user_version = 32');
      expect(() => normalizeCurrentTeamIdentitySchema(objects, 32, database))
        .toThrow('version-unsupported');
      database.pragma('user_version = 33');
      expect(() => normalizeCurrentTeamIdentitySchema(objects, 33, database))
        .toThrow('version-unsupported');
      database.pragma('user_version = 34');
      expect(() => normalizeCurrentTeamIdentitySchema(objects, 34, database))
        .toThrow('version-unsupported');
      database.pragma('user_version = 36');
      expect(() => normalizeCurrentTeamIdentitySchema(objects, 36, database))
        .toThrow('version-unsupported');
      database.pragma('user_version = 35');
      database.pragma('application_id = 0');
      expect(() => normalizeCurrentTeamIdentitySchema(objects, 35, database))
        .toThrow('version-unsupported');
    } finally {
      database.close();
    }
  });
});
