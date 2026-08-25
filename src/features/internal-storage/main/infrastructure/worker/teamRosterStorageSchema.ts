import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { teamIdentityRecords } from './teamIdentityStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export const teamRosterStorageMetadata = sqliteTable(
  'team_roster_storage_metadata',
  {
    component: text('component').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
  },
  (table) => [
    check('ck_team_roster_storage_component', sql`${table.component} = 'team-roster'`),
    check('ck_team_roster_storage_schema', sql`${table.schemaVersion} = 1`),
  ]
);

export const teamRosters = sqliteTable(
  'team_rosters',
  {
    teamId: text('team_id')
      .primaryKey()
      .references(() => teamIdentityRecords.teamId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    schemaVersion: integer('schema_version').notNull(),
    rosterGeneration: integer('roster_generation').notNull(),
    adoptionFingerprint: text('adoption_fingerprint').notNull(),
    adoptedAt: text('adopted_at').notNull(),
  },
  (table) => [
    check('ck_team_roster_schema', sql`${table.schemaVersion} = 1`),
    check('ck_team_roster_generation', sql`${table.rosterGeneration} > 0`),
    check(
      'ck_team_roster_fingerprint',
      sql`length(${table.adoptionFingerprint}) = 71
        AND substr(${table.adoptionFingerprint}, 1, 7) = 'sha256:'
        AND substr(${table.adoptionFingerprint}, 8) NOT GLOB '*[^0-9a-f]*'`
    ),
  ]
);

export const teamRosterMembers = sqliteTable(
  'team_roster_members',
  {
    memberId: text('member_id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teamRosters.teamId, { onDelete: 'restrict', onUpdate: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    legacyMemberKey: text('legacy_member_key').notNull(),
    legacyMemberKeyFolded: text('legacy_member_key_folded').notNull(),
    memberRevision: integer('member_revision').notNull(),
    state: text('state').notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model'),
    role: text('role'),
    workflow: text('workflow'),
    isolation: text('isolation'),
  },
  (table) => [
    uniqueIndex('idx_team_roster_member_ordinal').on(table.teamId, table.ordinal),
    uniqueIndex('idx_team_roster_member_exact_key').on(table.teamId, table.legacyMemberKey),
    uniqueIndex('idx_team_roster_member_folded_key').on(table.teamId, table.legacyMemberKeyFolded),
    check('ck_team_roster_member_ordinal', sql`${table.ordinal} >= 0`),
    check(
      'ck_team_roster_member_id',
      sql`length(${table.memberId}) = 39
        AND substr(${table.memberId}, 1, 7) = 'member_'
        AND substr(${table.memberId}, 8) NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_team_roster_member_key',
      sql`length(${table.legacyMemberKey}) BETWEEN 1 AND 128
        AND substr(${table.legacyMemberKey}, 1, 1) GLOB '[A-Za-z0-9]'
        AND ${table.legacyMemberKey} NOT GLOB '*[^A-Za-z0-9._-]*'
        AND substr(${table.legacyMemberKey}, -1, 1) <> '.'
        AND ${table.legacyMemberKeyFolded} = lower(${table.legacyMemberKey})`
    ),
    check('ck_team_roster_member_revision', sql`${table.memberRevision} > 0`),
    check('ck_team_roster_member_state', sql`${table.state} IN ('active', 'removed')`),
    check(
      'ck_team_roster_member_provider',
      sql`${table.providerId} IN ('anthropic', 'codex', 'gemini', 'opencode')`
    ),
    check(
      'ck_team_roster_member_fields',
      sql`(${table.model} IS NULL OR length(${table.model}) BETWEEN 1 AND 512)
        AND (${table.role} IS NULL OR length(${table.role}) BETWEEN 1 AND 4096)
        AND (${table.workflow} IS NULL OR length(${table.workflow}) BETWEEN 1 AND 131072)
        AND (${table.isolation} IS NULL OR ${table.isolation} = 'worktree')`
    ),
  ]
);

export const TEAM_ROSTER_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS team_roster_storage_metadata (
    component TEXT PRIMARY KEY CHECK (component = 'team-roster'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1)
  )`,
  `INSERT OR IGNORE INTO team_roster_storage_metadata (component, schema_version)
    VALUES ('team-roster', 1)`,
  `CREATE TABLE IF NOT EXISTS team_rosters (
    team_id TEXT PRIMARY KEY REFERENCES team_identity_records(team_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    roster_generation INTEGER NOT NULL CHECK (roster_generation > 0),
    adoption_fingerprint TEXT NOT NULL
      CHECK (length(adoption_fingerprint) = 71
        AND substr(adoption_fingerprint, 1, 7) = 'sha256:'
        AND substr(adoption_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
    adopted_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_roster_members (
    member_id TEXT PRIMARY KEY
      CHECK (length(member_id) = 39 AND substr(member_id, 1, 7) = 'member_'
        AND substr(member_id, 8) NOT GLOB '*[^0-9a-f]*'),
    team_id TEXT NOT NULL REFERENCES team_rosters(team_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    legacy_member_key TEXT NOT NULL
      CHECK (length(legacy_member_key) BETWEEN 1 AND 128
        AND substr(legacy_member_key, 1, 1) GLOB '[A-Za-z0-9]'
        AND legacy_member_key NOT GLOB '*[^A-Za-z0-9._-]*'
        AND substr(legacy_member_key, -1, 1) <> '.'),
    legacy_member_key_folded TEXT NOT NULL
      CHECK (legacy_member_key_folded = lower(legacy_member_key)),
    member_revision INTEGER NOT NULL CHECK (member_revision > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
    provider_id TEXT NOT NULL
      CHECK (provider_id IN ('anthropic', 'codex', 'gemini', 'opencode')),
    model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 512),
    role TEXT CHECK (role IS NULL OR length(role) BETWEEN 1 AND 4096),
    workflow TEXT CHECK (workflow IS NULL OR length(workflow) BETWEEN 1 AND 131072),
    isolation TEXT CHECK (isolation IS NULL OR isolation = 'worktree')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_roster_member_ordinal
    ON team_roster_members (team_id, ordinal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_roster_member_exact_key
    ON team_roster_members (team_id, legacy_member_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_roster_member_folded_key
    ON team_roster_members (team_id, legacy_member_key_folded)`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_roster_metadata_no_update
    BEFORE UPDATE ON team_roster_storage_metadata
    BEGIN SELECT RAISE(ABORT, 'team roster schema metadata is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_roster_metadata_no_delete
    BEFORE DELETE ON team_roster_storage_metadata
    BEGIN SELECT RAISE(ABORT, 'team roster schema metadata is immutable'); END`,
] as const;

const EXPECTED_TEAM_ROSTER_COLUMNS = Object.freeze({
  team_roster_storage_metadata: ['component', 'schema_version'],
  team_rosters: [
    'team_id',
    'schema_version',
    'roster_generation',
    'adoption_fingerprint',
    'adopted_at',
  ],
  team_roster_members: [
    'member_id',
    'team_id',
    'ordinal',
    'legacy_member_key',
    'legacy_member_key_folded',
    'member_revision',
    'state',
    'provider_id',
    'model',
    'role',
    'workflow',
    'isolation',
  ],
} as const);

/** Runs inside the shared migration transaction before user_version advances. */
export function verifyTeamRosterStorageMigration(database: SqliteDatabase): void {
  const metadata = database
    .prepare(
      `SELECT schema_version
       FROM team_roster_storage_metadata
       WHERE component = 'team-roster'`
    )
    .get() as { readonly schema_version: number } | undefined;
  if (metadata?.schema_version !== 1) {
    throw new Error('team-roster-storage-migration-metadata-invalid');
  }
  for (const [tableName, expectedColumns] of Object.entries(EXPECTED_TEAM_ROSTER_COLUMNS)) {
    const actualColumns = (
      database.pragma(`table_info(${tableName})`) as { readonly name: string }[]
    ).map(({ name }) => name);
    if (
      actualColumns.length !== expectedColumns.length ||
      actualColumns.some((column, index) => column !== expectedColumns[index])
    ) {
      throw new Error(`team-roster-storage-migration-table-invalid:${tableName}`);
    }
  }
  const rosterForeignKeys = database.pragma('foreign_key_list(team_rosters)') as {
    readonly from: string;
    readonly table: string;
    readonly to: string;
  }[];
  const memberForeignKeys = database.pragma('foreign_key_list(team_roster_members)') as {
    readonly from: string;
    readonly table: string;
    readonly to: string;
  }[];
  if (
    !rosterForeignKeys.some(
      (key) =>
        key.from === 'team_id' && key.table === 'team_identity_records' && key.to === 'team_id'
    ) ||
    !memberForeignKeys.some(
      (key) => key.from === 'team_id' && key.table === 'team_rosters' && key.to === 'team_id'
    )
  ) {
    throw new Error('team-roster-storage-migration-foreign-key-invalid');
  }
}
