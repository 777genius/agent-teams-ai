import { createHash } from 'node:crypto';

import { normalizeCurrentTeamIdentitySchema } from '@features/internal-storage/main/infrastructure/normalizeCurrentTeamIdentitySchema';
import { HOSTED_PROMOTION_STORAGE_MIGRATION } from '@features/internal-storage/main/infrastructure/worker/hostedPromotionStorageMigration';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';
import { describe, expect, it } from 'vitest';

function released29(db: InstanceType<typeof Database>) {
  const stop = new Error('prefix-complete');
  const proxy = new Proxy(db, { get(target, property) {
    if (property === 'transaction') return (operation: () => void) => {
      if (target.pragma('user_version', { simple: true }) === 29) throw stop;
      return target.transaction(operation);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try { runInternalStorageMigrations(proxy); } catch (error) { if (error !== stop) throw error; }
  expect(db.pragma('user_version', { simple: true })).toBe(29);
}
const identitySchema = (db: InstanceType<typeof Database>) => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE tbl_name IN ('team_identity_records', 'legacy_team_key_reservations', 'team_adoption_intents', 'team_identity_storage_metadata')
  ORDER BY type, name, tbl_name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];

describe('promotion v30 append-only admission', () => {
  it.each(['shared', 'distinct'] as const)('preserves the exact released identity projection in %s topology', (topology) => {
    const drafts = new Database(':memory:');
    const canonical = topology === 'shared' ? drafts : new Database(':memory:');
    try {
      released29(drafts);
      if (canonical !== drafts) released29(canonical);
      const schemaBefore = drafts.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name').all();
      const normalizedBefore = normalizeCurrentTeamIdentitySchema(identitySchema(canonical), 29);
      expect(normalizedBefore).toHaveLength(23);
      expect(createHash('sha256').update(JSON.stringify(normalizedBefore)).digest('hex'))
        .toBe('570be2f0773d8768848f2bef11c3cd70129199ac86730b055980fc46b90fdf36');
      expect(() => normalizeCurrentTeamIdentitySchema(identitySchema(canonical).map((object) =>
        object.name === 'trg_team_identity_transition' ? { ...object, sql: `${object.sql} ` } : object
      ), 29)).toThrow('incompatible');
      runInternalStorageMigrations(drafts);
      if (canonical !== drafts) runInternalStorageMigrations(canonical);
      const schemaAfter = drafts.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name').all();
      // Every released object remains identical. The only additions are v30 objects.
      for (const object of schemaBefore) expect(schemaAfter).toContainEqual(object);
      expect(normalizeCurrentTeamIdentitySchema(identitySchema(canonical), 30)).toEqual(normalizedBefore);
      expect(drafts.prepare('SELECT * FROM hosted_team_configuration_promotions').all()).toEqual([]);
      expect(drafts.pragma('foreign_key_check')).toEqual([]);
      const trigger = identitySchema(canonical).find((object) => (object as { name: string }).name === 'trg_team_identity_transition');
      expect(trigger).toBeDefined();
      expect(() => normalizeCurrentTeamIdentitySchema(identitySchema(canonical).map((object) => object.name === 'trg_team_identity_transition'
        ? { ...object, sql: `${(object as { sql: string }).sql} ` } : object), 30)).toThrow('incompatible');
    } finally { if (canonical !== drafts) canonical.close(); drafts.close(); }
  });
  it('adds only focused promotion objects and retains historical migration numbering', () => {
    expect(HOSTED_PROMOTION_STORAGE_MIGRATION.version).toBe(30);
    expect(HOSTED_PROMOTION_STORAGE_MIGRATION.statements.every((sql) => sql.startsWith('CREATE '))).toBe(true);
  });
});
