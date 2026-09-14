import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import {
  parseDirectoryFingerprint,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentId,
  parseTeamIdentityChecksum,
} from '@features/internal-storage/contracts/teamIdentityStorageContracts';
import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import {
  RESERVED_TEAM_IDENTITY_TRANSITION,
  TEAM_DRAFT_PUBLICATION_MIGRATION,
} from '@features/internal-storage/main/infrastructure/worker/teamDraftPublicationMigration';
import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import { TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema';
import { TeamIdentityStorageSupport } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageSupport';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted/identifiers';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  expectCurrentPublicationRestore,
  publicationRestoreSnapshot,
  seedCurrentPublicationRestore,
} from './fixtures/currentPublicationRestore';
import { createReleasedInternalStorageSchema } from './fixtures/releasedInternalStorageSchema';

const roots: string[] = [];
const databases: Database.Database[] = [];
const table = 'hosted_team_configuration_publications';
const oldTrigger = TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.find(
  ({ name }) => name === 'trg_team_identity_transition'
)!.sql!;

function open(file: string): Database.Database {
  const db = new Database(file);
  databases.push(db);
  return db;
}

function fixture(historical = false) {
  const root = mkdtempSync(join(tmpdir(), 'publication-restore-'));
  roots.push(root);
  const file = join(root, 'storage.sqlite');
  const db = open(file);
  if (historical) createReleasedInternalStorageSchema(db, 28);
  else {
    runInternalStorageMigrations(db);
    seedCurrentPublicationRestore(db);
  }
  return { db, file };
}

function relabel(db: Database.Database, marker = 28) {
  db.pragma(`user_version = ${marker}`);
}

function replacePublication(db: Database.Database, sql: string) {
  // Test-only replacement keeps populated rows and both exact triggers, so the
  // negative case isolates the altered table constraint rather than absence.
  db.exec(`CREATE TEMP TABLE saved_publications AS SELECT * FROM main.${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(sql);
  db.exec(`INSERT INTO ${table} SELECT * FROM temp.saved_publications`);
  db.exec('DROP TABLE temp.saved_publications');
  db.exec(TEAM_DRAFT_PUBLICATION_MIGRATION.statements[3]);
  db.exec(TEAM_DRAFT_PUBLICATION_MIGRATION.statements[4]);
}

const componentTables = [
  'team_identity_storage_metadata',
  'team_identity_records',
  'legacy_team_key_reservations',
  'team_adoption_intents',
  table,
];
const graphStates = ['prepared', 'file_published', 'active', 'tombstoned'] as const;

// Populate through the real identity operations while the retained predecessor
// trigger is still installed. This does not relabel a current schema as history.
function seedAdoptionGraph(db: Database.Database, state: (typeof graphStates)[number]) {
  const ops = new TeamIdentityStorageOps(() => db);
  const input = {
    teamId: parseTeamId(`team_${'d'.repeat(32)}`),
    intentId: parseTeamAdoptionIntentId(`adoption_${'e'.repeat(32)}`),
    legacyKey: parseLegacyTeamKey('historical-adoption'),
    directoryFingerprint: parseDirectoryFingerprint('f'.repeat(64)),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`), generation: 1,
    },
    expectedIdentityChecksum: parseTeamIdentityChecksum('1'.repeat(64)),
    preparedAt: '2026-08-02T18:00:00.000Z',
  };
  const prepared = ops.prepareAdoption(input);
  const transition = {
    teamId: input.teamId, intentId: input.intentId,
    intentChecksum: prepared.intent.intentChecksum, identityChecksum: input.expectedIdentityChecksum,
  };
  if (state !== 'prepared') {
    ops.recordIdentityFilePublished({ ...transition, filePublishedAt: '2026-08-02T18:01:00.000Z' });
  }
  if (state === 'active' || state === 'tombstoned') {
    ops.commitAdoption({ ...transition, committedAt: '2026-08-02T18:02:00.000Z' });
  }
  if (state === 'tombstoned') {
    ops.tombstoneLegacyKey({
      teamId: input.teamId, legacyKey: input.legacyKey,
      reason: 'team_deleted', tombstonedAt: '2026-08-02T18:03:00.000Z',
    });
  }
  expect(ops.getIdentity(input.teamId)?.state)
    .toBe(state === 'prepared' ? 'adoption_prepared' : state);
  return input;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function schemaSnapshot(db: Database.Database, schema: 'main' | 'temp') {
  const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema ORDER BY name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tables = db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type = 'table' ORDER BY name`)
    .all() as { name: string }[];
  return {
    objects,
    rows: tables.map(({ name }) => ({
      name, rows: db.prepare(`SELECT * FROM ${schema}.${quoteIdentifier(name)} ORDER BY rowid`).all(),
    })),
  };
}

function expectRejectedBeforeDdl(db: Database.Database) {
  const before = { main: schemaSnapshot(db, 'main'), temp: schemaSnapshot(db, 'temp') };
  const statements: string[] = [];
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === 'exec') return (sql: string) => {
        statements.push(sql);
        return target.exec(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  expect(() => runInternalStorageMigrations(observed))
    .toThrow('internal-storage-v29-publication-schema-incompatible');
  expect(statements).toEqual([]);
  expect(db.pragma('user_version', { simple: true })).toBe(28);
  expect({ main: schemaSnapshot(db, 'main'), temp: schemaSnapshot(db, 'temp') }).toEqual(before);
}

afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await setImmediate();
});

describe('v29 exact publication restore admission', () => {
  it('migrates a real v28 prefix separately from relabeled current storage', () => {
    const { db } = fixture(true);
    expect(db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
      .get('trg_team_identity_transition')).toEqual({ sql: oldTrigger });
    runInternalStorageMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(30);
    expect(db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
      .get('trg_team_identity_transition')).toEqual({ sql: RESERVED_TEAM_IDENTITY_TRANSITION });
    seedCurrentPublicationRestore(db);
    expectCurrentPublicationRestore(db);
  });

  it.each(graphStates)('migrates a populated real predecessor %s graph before v29 DDL', (state) => {
    const { db } = fixture(true);
    const input = seedAdoptionGraph(db, state);
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(db.prepare('SELECT sql FROM main.sqlite_schema WHERE name = ?')
      .get('trg_team_identity_transition')).toEqual({ sql: oldTrigger });
    expect(db.prepare('SELECT name FROM main.sqlite_schema WHERE name = ?').get(table)).toBeUndefined();
    const before = schemaSnapshot(db, 'main');
    runInternalStorageMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(30);
    const after = schemaSnapshot(db, 'main');
    expect(after.rows.filter(({ name }) => name !== table &&
      name !== 'hosted_team_configuration_promotions')).toEqual(before.rows);
    expect(db.prepare('SELECT * FROM main.hosted_team_configuration_promotions').all()).toEqual([]);
    expect(after.objects).toEqual(expect.arrayContaining(before.objects.filter((object) =>
      object.name !== 'trg_team_identity_transition')));
    expect(db.prepare('SELECT sql FROM main.sqlite_schema WHERE name = ?')
      .get('trg_team_identity_transition')).toEqual({ sql: RESERVED_TEAM_IDENTITY_TRANSITION });
    expect(new TeamIdentityStorageOps(() => db).getIdentity(input.teamId)?.state)
      .toBe(state === 'prepared' ? 'adoption_prepared' : state);
  });

  describe.each([true, false])('TEMP rejection (real predecessor=%s)', (historical) => {
    const shadowCases = componentTables.flatMap((name) =>
      [name.toUpperCase(), name.replace(/(^|_)[a-z]/g, (letter) => letter.toUpperCase())]
        .flatMap((shadow) => ['TABLE', 'VIEW'].map((kind) => ({ shadow, kind })))
    );
    it.each(shadowCases)('rejects $kind $shadow before DDL', ({ shadow, kind }) => {
      const { db } = fixture(historical);
      if (!historical) relabel(db);
      db.exec(`CREATE TEMP ${kind} ${quoteIdentifier(shadow)} AS SELECT 'shadow — café' AS payload`);
      expectRejectedBeforeDdl(db);
    });

    it.each(['reservation timestamp', 'intent checksum', 'intent graph'])(
      'rejects valid TEMP contents substituting for invalid main %s', (corruption) => {
        const { db } = fixture(historical);
        const input = seedAdoptionGraph(db, 'active');
        if (!historical) relabel(db);
        const reservation = corruption === 'reservation timestamp';
        // Replay uses the original reserved publication identity from the review counterexample.
        const targetTeamId = reservation && !historical ? parseTeamId(`team_${'a'.repeat(32)}`) : input.teamId;
        const source = reservation ? 'legacy_team_key_reservations' : 'team_adoption_intents';
        const shadow = reservation ? source.toUpperCase() : 'TeAm_AdOpTiOn_InTeNtS';
        db.exec(`CREATE TEMP TABLE ${quoteIdentifier(shadow)} AS SELECT * FROM main.${source}`);
        const tempBefore = schemaSnapshot(db, 'temp');
        const valid = db.prepare(`SELECT * FROM temp.${quoteIdentifier(shadow)} ORDER BY rowid`).all();
        const trigger = reservation ? 'trg_legacy_team_key_transition' : 'trg_team_adoption_intent_transition';
        const schema = schemaSnapshot(db, 'main').objects;
        db.exec(`DROP TRIGGER main.${trigger}`);
        if (reservation) {
          db.prepare(`UPDATE main.legacy_team_key_reservations SET reserved_at = ? WHERE team_id = ?`)
            .run('2026-08-03T18:00:00.000Z', targetTeamId);
        } else if (corruption === 'intent checksum') {
          db.prepare('UPDATE main.team_adoption_intents SET intent_checksum = ? WHERE team_id = ?')
            .run('0'.repeat(64), input.teamId);
        } else {
          // committed_at is outside the intent checksum, but must equal activated_at.
          db.prepare('UPDATE main.team_adoption_intents SET committed_at = ? WHERE team_id = ?')
            .run('2026-08-03T18:00:00.000Z', input.teamId);
        }
        const triggerSql = TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.find(({ name }) => name === trigger)!.sql!;
        // Qualify the trigger name, not its ON clause: SQLite binds the owner
        // in main and omits the schema qualifier from stored CREATE SQL.
        db.exec(triggerSql.replace(`CREATE TRIGGER ${trigger}`, `CREATE TRIGGER main.${trigger}`));
        expect(db.prepare('SELECT sql FROM main.sqlite_schema WHERE name = ?').get(trigger))
          .toEqual({ sql: triggerSql });
        expect(schemaSnapshot(db, 'main').objects).toEqual(schema);
        expect(schemaSnapshot(db, 'temp')).toEqual(tempBefore);
        expect(db.prepare(`SELECT * FROM temp.${quoteIdentifier(shadow)} ORDER BY rowid`).all()).toEqual(valid);
        expect(db.prepare(`SELECT * FROM main.${source} ORDER BY rowid`).all()).not.toEqual(valid);
        expect(db.pragma(`main.foreign_key_check('${source}')`)).toEqual([]);
        expect(db.pragma(`main.integrity_check('${source}')`)).toEqual([{ integrity_check: 'ok' }]);
        const support = new TeamIdentityStorageSupport();
        const identity = support.requireIdentity(db, targetTeamId);
        // The unqualified graph reader sees the valid TEMP copy: this is a real
        // substitution, not merely a malformed fixture rejected by another check.
        expect(() => support.assertReadableIdentityGraph(db, identity)).not.toThrow();
        expectRejectedBeforeDdl(db);
        db.exec(`DROP TABLE temp.${quoteIdentifier(shadow)}`);
        expect(() => support.assertReadableIdentityGraph(db, identity)).toThrow();
      }
    );

    it.each(['IDX_TEAM_IDENTITY_unexpected', 'TrG_LeGaCy_TeAm_KeY_unexpected',
      'TEAM_ADOPTION_INTENT_unexpected', 'HOSTED_TEAM_CONFIGURATION_PUBLICATIONS_unexpected'])(
      'rejects case-folded reserved object %s on an unrelated owner', (name) => {
        const { db } = fixture(historical);
        if (!historical) relabel(db);
        db.exec('CREATE TABLE unrelated_restore_probe (value TEXT)');
        db.exec(`CREATE INDEX ${quoteIdentifier(name)} ON unrelated_restore_probe(value)`);
        expectRejectedBeforeDdl(db);
      }
    );
  });

  it.each([15, 28])('preserves populated schema, identity and payload bytes after marker %i and two opens', (marker) => {
    const { db, file } = fixture();
    const before = publicationRestoreSnapshot(db);
    relabel(db, marker);
    db.close();
    const restored = open(file);
    runInternalStorageMigrations(restored);
    expectCurrentPublicationRestore(restored);
    expect(publicationRestoreSnapshot(restored)).toEqual(before);
    restored.close();
    const bytes = readFileSync(file);
    const second = open(file);
    runInternalStorageMigrations(second);
    expectCurrentPublicationRestore(second);
    expect(publicationRestoreSnapshot(second)).toEqual(before);
    second.close();
    expect(readFileSync(file)).toEqual(bytes);
  });

  const malformed: readonly [string, (db: Database.Database) => void][] = [
    ['case-only publication trigger name', (db) => {
      db.exec(`DROP TRIGGER ${table}_immutable`);
      db.exec(TEAM_DRAFT_PUBLICATION_MIGRATION.statements[3]
        .replace(`${table}_immutable`, `${table}_immutable`.toUpperCase()));
    }],
    ['case-only identity trigger name', (db) => {
      db.exec('DROP TRIGGER trg_team_identity_transition');
      db.exec(RESERVED_TEAM_IDENTITY_TRANSITION
        .replace('trg_team_identity_transition', 'TRG_TEAM_IDENTITY_TRANSITION'));
    }],
    ['missing publication trigger', (db) => db.exec(`DROP TRIGGER ${table}_immutable`)],
    ['altered publication trigger', (db) => {
      db.exec(`DROP TRIGGER ${table}_no_delete`);
      db.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT 1; END`);
    }],
    ['extra publication trigger', (db) => db.exec(`CREATE TRIGGER extra_publication
      AFTER INSERT ON ${table} BEGIN SELECT 1; END`)],
    ['extra publication index', (db) => db.exec(`CREATE INDEX extra_publication ON ${table}(state)`)],
    ['missing unique index', (db) => replacePublication(db,
      TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2].replace('team_id TEXT NOT NULL UNIQUE', 'team_id TEXT NOT NULL'))],
    ['altered unique index', (db) => replacePublication(db,
      TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2].replace('legacy_key TEXT NOT NULL UNIQUE',
        'legacy_key TEXT NOT NULL COLLATE NOCASE UNIQUE'))],
    ['weakened CHECK', (db) => replacePublication(db,
      TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2].replace('binding_generation > 0', 'binding_generation >= 0'))],
    ['weakened fingerprint CHECK', (db) => replacePublication(db,
      TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2].replace("NOT GLOB '*[^0-9a-f]*'", "NOT GLOB '*[^0-9a-fA-F]*'"))],
    ['altered FK', (db) => replacePublication(db,
      TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2].replace('ON DELETE RESTRICT', 'ON DELETE CASCADE'))],
    ['missing FK', (db) => replacePublication(db,
      TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2].replace(/ {6}FOREIGN KEY[\s\S]*?ON UPDATE RESTRICT,\n/, ''))],
    ['extra column', (db) => db.exec(`ALTER TABLE ${table} ADD COLUMN extra TEXT`)],
    ['old identity plus current publication', (db) => {
      db.exec('DROP TRIGGER trg_team_identity_transition'); db.exec(oldTrigger);
    }],
    ['missing identity metadata', (db) => {
      db.exec('DROP TRIGGER trg_team_identity_metadata_no_delete');
      db.exec('DELETE FROM team_identity_storage_metadata');
      db.exec(TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.find(
        ({ name }) => name === 'trg_team_identity_metadata_no_delete')!.sql!);
    }],
    ['missing identity trigger', (db) => db.exec('DROP TRIGGER trg_team_identity_transition')],
    ['altered identity trigger', (db) => {
      db.exec('DROP TRIGGER trg_team_identity_transition');
      db.exec(RESERVED_TEAM_IDENTITY_TRANSITION.replace("OLD.state = 'reserved'", "OLD.state = 'active'"));
    }],
    ['extra identity index', (db) => db.exec('CREATE INDEX extra_identity ON team_identity_records(state)')],
    ['missing identity index', (db) => db.exec('DROP INDEX idx_team_identity_checksum')],
    ['TEMP identity shadow', (db) => db.exec('CREATE TEMP TABLE team_identity_records (team_id TEXT)')],
    ['TEMP publication shadow', (db) => db.exec(`CREATE TEMP TABLE ${table} (operation_id TEXT)`) ],
    ['invalid publication relationship', (db) => {
      db.pragma('foreign_keys = OFF');
      db.exec('DELETE FROM hosted_team_configuration_drafts');
    }],
    ['stored CHECK violation', (db) => {
      db.pragma('ignore_check_constraints = ON');
      db.exec(`INSERT INTO hosted_team_configuration_drafts VALUES
        ('other', 'other', 'active', 1, 'other', '{}', '[]', 1, 1)`);
      db.exec(`INSERT INTO ${table} VALUES
        ('invalid', 'other', 'other', 'actor', 'deployment', 'runtime', 0,
         'other', 'now', 'other', NULL, 'published')`);
      db.pragma('ignore_check_constraints = OFF');
    }],
    ['invalid identity relationship', (db) => {
      db.exec('DROP TRIGGER trg_legacy_team_key_transition');
      db.exec("UPDATE legacy_team_key_reservations SET reserved_at = '2026-08-03T18:00:00.000Z'");
      db.exec(TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.find(
        ({ name }) => name === 'trg_legacy_team_key_transition')!.sql!);
    }],
  ];

  it.each(malformed)('rejects %s with unchanged marker and component', (_name, alter) => {
    const { db } = fixture();
    alter(db);
    relabel(db);
    const before = publicationRestoreSnapshot(db);
    const temp = db.prepare('SELECT * FROM temp.sqlite_schema ORDER BY name').all();
    expect(() => runInternalStorageMigrations(db)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(publicationRestoreSnapshot(db)).toEqual(before);
    expect(db.prepare('SELECT * FROM temp.sqlite_schema ORDER BY name').all()).toEqual(temp);
  });

  it('rejects persisted malformed restore after earlier migrations commit, without changing v29 component bytes', () => {
    const { db, file } = fixture();
    replacePublication(db, TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2]
      .replace('binding_generation > 0', 'binding_generation >= 0'));
    relabel(db, 15);
    const before = publicationRestoreSnapshot(db);
    db.close();
    const restored = open(file);
    expect(() => runInternalStorageMigrations(restored)).toThrow('internal-storage-v29-publication-schema-incompatible');
    expect(restored.pragma('user_version', { simple: true })).toBe(28);
    expect(publicationRestoreSnapshot(restored)).toEqual(before);
    restored.close();
    const bytes = readFileSync(file);
    const rejectedAgain = open(file);
    expect(() => runInternalStorageMigrations(rejectedAgain)).toThrow('internal-storage-v29-publication-schema-incompatible');
    rejectedAgain.close();
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('rejects a retained identity with a partial publication component', () => {
    const { db } = fixture(true);
    db.exec(TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2]);
    const before = publicationRestoreSnapshot(db);
    expect(() => runInternalStorageMigrations(db)).toThrow('internal-storage-v29-publication-schema-incompatible');
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(publicationRestoreSnapshot(db)).toEqual(before);
  });

  it('rolls back the retained DDL and marker if v29 fails after creating its table', () => {
    const { db } = fixture(true);
    const before = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    const injected = new Error('test-only-v29-ddl-interruption');
    const failing = new Proxy(db, {
      get(target, property) {
        if (property === 'exec') return (sql: string) => {
          const result = target.exec(sql);
          if (sql === TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2]) throw injected;
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => runInternalStorageMigrations(failing)).toThrow(injected);
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(before);
  });

  it.each(['absent', 'view', 'reserved-name'])('rejects current identity plus %s publication', (shape) => {
    const { db } = fixture();
    db.exec(`DROP TABLE ${table}`);
    if (shape === 'view') db.exec(`CREATE VIEW ${table} AS SELECT 1 AS operation_id`);
    if (shape === 'reserved-name') db.exec(`CREATE TABLE ${table}_unexpected (id TEXT)`);
    relabel(db);
    const before = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    expect(() => runInternalStorageMigrations(db)).toThrow('internal-storage-v29-publication-schema-incompatible');
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(before);
  });

  it.each([true, false])('keeps the backup fence ahead of v29 admission (historical=%s)', (historical) => {
    const { db } = fixture(historical);
    relabel(db);
    db.exec(`INSERT INTO coordination_backup_runs
      (backup_run_id, deployment_id, state, revision, fence_completion_status, record_json, requested_at, updated_at)
      VALUES ('backup-restore', 'deployment', 'sqlite_snapshot', 1, NULL, '{}', 'now', 'now');
      INSERT INTO coordination_backup_writer_fences
      (deployment_id, generation, admitted_run_id, lease_id, status, disposition, acquired_at, completed_at)
      VALUES ('deployment', 1, 'backup-restore', 'lease', 'active', NULL, 'now', NULL)`);
    const before = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    expect(() => runInternalStorageMigrations(db)).toThrow('internal-storage-v29-migration-backup-fenced');
    expect(db.pragma('user_version', { simple: true })).toBe(28);
    expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(before);
    expect(db.prepare('SELECT status FROM coordination_backup_writer_fences').get()).toEqual({ status: 'active' });
  });

  it.each(['published', 'recovery_required', 'tombstoned'])('preserves populated %s publication rows on replay', (state) => {
    const { db } = fixture();
    db.prepare(`UPDATE ${table} SET directory_fingerprint = ?, state = ?`).run('c'.repeat(64), state);
    const before = publicationRestoreSnapshot(db);
    relabel(db);
    runInternalStorageMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(30);
    expect(publicationRestoreSnapshot(db)).toEqual(before);
  });

  it('retains publication write constraints after validated replay', () => {
    const { db } = fixture();
    relabel(db);
    runInternalStorageMigrations(db);
    expect(() => db.exec(`UPDATE ${table} SET binding_generation = 2`)).toThrow('immutable');
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('retained');
    expect(() => db.exec(`UPDATE ${table} SET state = 'published'`)).toThrow('CHECK');
    db.prepare(`UPDATE ${table} SET directory_fingerprint = ?, state = 'published'`).run('c'.repeat(64));
    expect(() => db.exec(`UPDATE ${table} SET state = 'pending'`)).toThrow('immutable');
    expect(() => db.prepare(`UPDATE ${table} SET directory_fingerprint = ?`).run('d'.repeat(64)))
      .toThrow('immutable');
    expect(() => db.exec('DELETE FROM hosted_team_configuration_drafts')).toThrow('FOREIGN KEY');
  });
});
