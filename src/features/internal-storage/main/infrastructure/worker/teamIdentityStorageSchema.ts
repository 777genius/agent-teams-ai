import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const TEAM_IDENTITY_STORAGE_COMPONENT = 'team-identity';
export const TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION = 1;
export const TEAM_IDENTITY_STORAGE_MIGRATION_VERSION = 5;

const TEAM_ID_STORED_CHECK = sql`length(team_id) = 37
  AND substr(team_id, 1, 5) = 'team_'
  AND substr(team_id, 6) NOT GLOB '*[^0-9a-f]*'`;
const WORKSPACE_BINDING_STORED_CHECK = sql`(
  workspace_id IS NULL AND workspace_binding_generation IS NULL
) OR (
  length(workspace_id) = 42
  AND substr(workspace_id, 1, 10) = 'workspace_'
  AND substr(workspace_id, 11) NOT GLOB '*[^0-9a-f]*'
  AND workspace_binding_generation >= 1
)`;
const DIRECTORY_FINGERPRINT_STORED_CHECK = sql`length(directory_fingerprint) = 64
  AND directory_fingerprint NOT GLOB '*[^0-9a-f]*'`;

export const teamIdentityStorageMetadata = sqliteTable(
  'team_identity_storage_metadata',
  {
    component: text('component').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
  },
  (table) => [
    check(
      'ck_team_identity_metadata_component',
      sql`${table.component} = ${TEAM_IDENTITY_STORAGE_COMPONENT}`
    ),
    check(
      'ck_team_identity_metadata_version',
      sql`${table.schemaVersion} = ${TEAM_IDENTITY_STORAGE_COMPONENT_SCHEMA_VERSION}`
    ),
  ]
);

export const teamIdentityRecords = sqliteTable(
  'team_identity_records',
  {
    teamId: text('team_id').primaryKey(),
    state: text('state', {
      enum: ['reserved', 'adoption_prepared', 'file_published', 'active', 'tombstoned'],
    }).notNull(),
    legacyKey: text('legacy_key').notNull(),
    directoryFingerprint: text('directory_fingerprint').notNull(),
    workspaceId: text('workspace_id'),
    workspaceBindingGeneration: integer('workspace_binding_generation'),
    adoptionIntentId: text('adoption_intent_id'),
    identityChecksum: text('identity_checksum'),
    createdAt: text('created_at').notNull(),
    activatedAt: text('activated_at'),
    tombstonedAt: text('tombstoned_at'),
  },
  (table) => [
    uniqueIndex('idx_team_identity_legacy_key').on(table.legacyKey),
    uniqueIndex('idx_team_identity_directory_fingerprint').on(table.directoryFingerprint),
    uniqueIndex('idx_team_identity_checksum')
      .on(table.identityChecksum)
      .where(sql`${table.identityChecksum} IS NOT NULL`),
    check('ck_team_identity_team_id', TEAM_ID_STORED_CHECK),
    check(
      'ck_team_identity_state',
      sql`${table.state} IN ('reserved', 'adoption_prepared', 'file_published', 'active', 'tombstoned')`
    ),
    check(
      'ck_team_identity_legacy_key',
      sql`length(${table.legacyKey}) BETWEEN 1 AND 128
        AND substr(${table.legacyKey}, 1, 1) GLOB '[a-z0-9]'
        AND ${table.legacyKey} NOT GLOB '*[^a-z0-9-]*'
        AND ${table.legacyKey} NOT IN (
          'aux', 'con', 'nul', 'prn',
          'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
          'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
        )`
    ),
    check('ck_team_identity_directory_fingerprint', DIRECTORY_FINGERPRINT_STORED_CHECK),
    check('ck_team_identity_workspace_binding', WORKSPACE_BINDING_STORED_CHECK),
    check(
      'ck_team_identity_adoption_intent_id',
      sql`${table.adoptionIntentId} IS NULL OR (
        length(${table.adoptionIntentId}) = 41
        AND substr(${table.adoptionIntentId}, 1, 9) = 'adoption_'
        AND substr(${table.adoptionIntentId}, 10) NOT GLOB '*[^0-9a-f]*'
      )`
    ),
    check(
      'ck_team_identity_checksum_value',
      sql`${table.identityChecksum} IS NULL OR (
        length(${table.identityChecksum}) = 64
        AND ${table.identityChecksum} NOT GLOB '*[^0-9a-f]*'
      )`
    ),
    check(
      'ck_team_identity_state_fields',
      sql`(
        ${table.state} = 'reserved'
        AND ${table.adoptionIntentId} IS NULL
        AND ${table.identityChecksum} IS NULL
        AND ${table.activatedAt} IS NULL
        AND ${table.tombstonedAt} IS NULL
      ) OR (
        ${table.state} = 'adoption_prepared'
        AND ${table.adoptionIntentId} IS NOT NULL
        AND ${table.identityChecksum} IS NULL
        AND ${table.activatedAt} IS NULL
        AND ${table.tombstonedAt} IS NULL
      ) OR (
        ${table.state} = 'file_published'
        AND ${table.adoptionIntentId} IS NOT NULL
        AND ${table.identityChecksum} IS NOT NULL
        AND ${table.activatedAt} IS NULL
        AND ${table.tombstonedAt} IS NULL
      ) OR (
        ${table.state} = 'active'
        AND ${table.identityChecksum} IS NOT NULL
        AND ${table.activatedAt} IS NOT NULL
        AND ${table.tombstonedAt} IS NULL
      ) OR (
        ${table.state} = 'tombstoned'
        AND ${table.tombstonedAt} IS NOT NULL
      )`
    ),
  ]
);

export const legacyTeamKeyReservations = sqliteTable(
  'legacy_team_key_reservations',
  {
    legacyKey: text('legacy_key').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teamIdentityRecords.teamId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    state: text('state', { enum: ['active', 'tombstoned'] }).notNull(),
    reservedAt: text('reserved_at').notNull(),
    tombstonedAt: text('tombstoned_at'),
    tombstoneReason: text('tombstone_reason', {
      enum: ['draft_deleted', 'team_deleted', 'legacy_conflict'],
    }),
  },
  (table) => [
    uniqueIndex('idx_legacy_team_key_active_owner')
      .on(table.teamId)
      .where(sql`${table.state} = 'active'`),
    check(
      'ck_legacy_team_key_value',
      sql`length(${table.legacyKey}) BETWEEN 1 AND 128
        AND substr(${table.legacyKey}, 1, 1) GLOB '[a-z0-9]'
        AND ${table.legacyKey} NOT GLOB '*[^a-z0-9-]*'
        AND ${table.legacyKey} NOT IN (
          'aux', 'con', 'nul', 'prn',
          'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
          'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
        )`
    ),
    check('ck_legacy_team_key_state', sql`${table.state} IN ('active', 'tombstoned')`),
    check(
      'ck_legacy_team_key_state_fields',
      sql`(
        ${table.state} = 'active'
        AND ${table.tombstonedAt} IS NULL
        AND ${table.tombstoneReason} IS NULL
      ) OR (
        ${table.state} = 'tombstoned'
        AND ${table.tombstonedAt} IS NOT NULL
        AND ${table.tombstoneReason} IN ('draft_deleted', 'team_deleted', 'legacy_conflict')
      )`
    ),
  ]
);

export const teamAdoptionIntents = sqliteTable(
  'team_adoption_intents',
  {
    intentId: text('intent_id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teamIdentityRecords.teamId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    state: text('state', { enum: ['prepared', 'file_published', 'committed'] }).notNull(),
    legacyKey: text('legacy_key').notNull(),
    directoryFingerprint: text('directory_fingerprint').notNull(),
    workspaceId: text('workspace_id'),
    workspaceBindingGeneration: integer('workspace_binding_generation'),
    expectedIdentityChecksum: text('expected_identity_checksum').notNull(),
    intentChecksum: text('intent_checksum').notNull(),
    preparedAt: text('prepared_at').notNull(),
    filePublishedAt: text('file_published_at'),
    publishedIdentityChecksum: text('published_identity_checksum'),
    committedAt: text('committed_at'),
    committedIdentityChecksum: text('committed_identity_checksum'),
  },
  (table) => [
    uniqueIndex('idx_team_adoption_intent_team').on(table.teamId),
    uniqueIndex('idx_team_adoption_intent_legacy_key').on(table.legacyKey),
    uniqueIndex('idx_team_adoption_intent_directory_fingerprint').on(table.directoryFingerprint),
    check(
      'ck_team_adoption_intent_id',
      sql`length(${table.intentId}) = 41
        AND substr(${table.intentId}, 1, 9) = 'adoption_'
        AND substr(${table.intentId}, 10) NOT GLOB '*[^0-9a-f]*'`
    ),
    check('ck_team_adoption_intent_team_id', TEAM_ID_STORED_CHECK),
    check(
      'ck_team_adoption_intent_state',
      sql`${table.state} IN ('prepared', 'file_published', 'committed')`
    ),
    check('ck_team_adoption_intent_directory_fingerprint', DIRECTORY_FINGERPRINT_STORED_CHECK),
    check('ck_team_adoption_intent_workspace_binding', WORKSPACE_BINDING_STORED_CHECK),
    check(
      'ck_team_adoption_intent_legacy_key',
      sql`length(${table.legacyKey}) BETWEEN 1 AND 128
        AND substr(${table.legacyKey}, 1, 1) GLOB '[a-z0-9]'
        AND ${table.legacyKey} NOT GLOB '*[^a-z0-9-]*'
        AND ${table.legacyKey} NOT IN (
          'aux', 'con', 'nul', 'prn',
          'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
          'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
        )`
    ),
    check(
      'ck_team_adoption_intent_checksums',
      sql`length(${table.expectedIdentityChecksum}) = 64
        AND ${table.expectedIdentityChecksum} NOT GLOB '*[^0-9a-f]*'
        AND length(${table.intentChecksum}) = 64
        AND ${table.intentChecksum} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'ck_team_adoption_intent_state_fields',
      sql`(
        ${table.state} = 'prepared'
        AND ${table.filePublishedAt} IS NULL
        AND ${table.publishedIdentityChecksum} IS NULL
        AND ${table.committedAt} IS NULL
        AND ${table.committedIdentityChecksum} IS NULL
      ) OR (
        ${table.state} = 'file_published'
        AND ${table.filePublishedAt} IS NOT NULL
        AND ${table.publishedIdentityChecksum} = ${table.expectedIdentityChecksum}
        AND ${table.committedAt} IS NULL
        AND ${table.committedIdentityChecksum} IS NULL
      ) OR (
        ${table.state} = 'committed'
        AND ${table.filePublishedAt} IS NOT NULL
        AND ${table.publishedIdentityChecksum} = ${table.expectedIdentityChecksum}
        AND ${table.committedAt} IS NOT NULL
        AND ${table.committedIdentityChecksum} = ${table.expectedIdentityChecksum}
      )`
    ),
  ]
);

/**
 * Integration appends this fragment as internal-storage migration v5. The
 * component metadata is separate from PRAGMA user_version so a later shared
 * migration cannot silently widen this component's understood schema.
 */
export const TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS team_identity_storage_metadata (
    component TEXT PRIMARY KEY CHECK (component = 'team-identity'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1)
  )`,
  `INSERT OR IGNORE INTO team_identity_storage_metadata (component, schema_version)
    VALUES ('team-identity', 1)`,
  `CREATE TABLE IF NOT EXISTS team_identity_records (
    team_id TEXT PRIMARY KEY
      CHECK (length(team_id) = 37 AND substr(team_id, 1, 5) = 'team_'
        AND substr(team_id, 6) NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL
      CHECK (state IN ('reserved', 'adoption_prepared', 'file_published', 'active', 'tombstoned')),
    legacy_key TEXT NOT NULL UNIQUE
      CHECK (length(legacy_key) BETWEEN 1 AND 128
        AND substr(legacy_key, 1, 1) GLOB '[a-z0-9]'
        AND legacy_key NOT GLOB '*[^a-z0-9-]*'
        AND legacy_key NOT IN (
          'aux', 'con', 'nul', 'prn',
          'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
          'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
        )),
    directory_fingerprint TEXT NOT NULL UNIQUE
      CHECK (length(directory_fingerprint) = 64
        AND directory_fingerprint NOT GLOB '*[^0-9a-f]*'),
    workspace_id TEXT,
    workspace_binding_generation INTEGER,
    adoption_intent_id TEXT,
    identity_checksum TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    tombstoned_at TEXT,
    CHECK ((workspace_id IS NULL AND workspace_binding_generation IS NULL) OR
      (length(workspace_id) = 42 AND substr(workspace_id, 1, 10) = 'workspace_'
        AND substr(workspace_id, 11) NOT GLOB '*[^0-9a-f]*'
        AND workspace_binding_generation >= 1)),
    CHECK (adoption_intent_id IS NULL OR
      (length(adoption_intent_id) = 41 AND substr(adoption_intent_id, 1, 9) = 'adoption_'
        AND substr(adoption_intent_id, 10) NOT GLOB '*[^0-9a-f]*')),
    CHECK (identity_checksum IS NULL OR
      (length(identity_checksum) = 64 AND identity_checksum NOT GLOB '*[^0-9a-f]*')),
    CHECK (
      (state = 'reserved' AND adoption_intent_id IS NULL AND identity_checksum IS NULL
        AND activated_at IS NULL AND tombstoned_at IS NULL) OR
      (state = 'adoption_prepared' AND adoption_intent_id IS NOT NULL
        AND identity_checksum IS NULL AND activated_at IS NULL AND tombstoned_at IS NULL) OR
      (state = 'file_published' AND adoption_intent_id IS NOT NULL
        AND identity_checksum IS NOT NULL AND activated_at IS NULL AND tombstoned_at IS NULL) OR
      (state = 'active' AND identity_checksum IS NOT NULL
        AND activated_at IS NOT NULL AND tombstoned_at IS NULL) OR
      (state = 'tombstoned' AND tombstoned_at IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_team_identity_checksum
    ON team_identity_records (identity_checksum) WHERE identity_checksum IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS legacy_team_key_reservations (
    legacy_key TEXT PRIMARY KEY
      CHECK (length(legacy_key) BETWEEN 1 AND 128
        AND substr(legacy_key, 1, 1) GLOB '[a-z0-9]'
        AND legacy_key NOT GLOB '*[^a-z0-9-]*'
        AND legacy_key NOT IN (
          'aux', 'con', 'nul', 'prn',
          'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
          'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
        )),
    team_id TEXT NOT NULL REFERENCES team_identity_records(team_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('active', 'tombstoned')),
    reserved_at TEXT NOT NULL,
    tombstoned_at TEXT,
    tombstone_reason TEXT,
    CHECK (
      (state = 'active' AND tombstoned_at IS NULL AND tombstone_reason IS NULL) OR
      (state = 'tombstoned' AND tombstoned_at IS NOT NULL
        AND tombstone_reason IN ('draft_deleted', 'team_deleted', 'legacy_conflict'))
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_team_key_active_owner
    ON legacy_team_key_reservations (team_id) WHERE state = 'active'`,
  `CREATE TABLE IF NOT EXISTS team_adoption_intents (
    intent_id TEXT PRIMARY KEY
      CHECK (length(intent_id) = 41 AND substr(intent_id, 1, 9) = 'adoption_'
        AND substr(intent_id, 10) NOT GLOB '*[^0-9a-f]*'),
    team_id TEXT NOT NULL UNIQUE REFERENCES team_identity_records(team_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'file_published', 'committed')),
    legacy_key TEXT NOT NULL UNIQUE
      CHECK (length(legacy_key) BETWEEN 1 AND 128
        AND substr(legacy_key, 1, 1) GLOB '[a-z0-9]'
        AND legacy_key NOT GLOB '*[^a-z0-9-]*'
        AND legacy_key NOT IN (
          'aux', 'con', 'nul', 'prn',
          'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
          'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
        )),
    directory_fingerprint TEXT NOT NULL UNIQUE
      CHECK (length(directory_fingerprint) = 64
        AND directory_fingerprint NOT GLOB '*[^0-9a-f]*'),
    workspace_id TEXT,
    workspace_binding_generation INTEGER,
    expected_identity_checksum TEXT NOT NULL
      CHECK (length(expected_identity_checksum) = 64
        AND expected_identity_checksum NOT GLOB '*[^0-9a-f]*'),
    intent_checksum TEXT NOT NULL
      CHECK (length(intent_checksum) = 64 AND intent_checksum NOT GLOB '*[^0-9a-f]*'),
    prepared_at TEXT NOT NULL,
    file_published_at TEXT,
    published_identity_checksum TEXT,
    committed_at TEXT,
    committed_identity_checksum TEXT,
    CHECK ((workspace_id IS NULL AND workspace_binding_generation IS NULL) OR
      (length(workspace_id) = 42 AND substr(workspace_id, 1, 10) = 'workspace_'
        AND substr(workspace_id, 11) NOT GLOB '*[^0-9a-f]*'
        AND workspace_binding_generation >= 1)),
    CHECK (
      (state = 'prepared' AND file_published_at IS NULL
        AND published_identity_checksum IS NULL
        AND committed_at IS NULL AND committed_identity_checksum IS NULL) OR
      (state = 'file_published' AND file_published_at IS NOT NULL
        AND published_identity_checksum = expected_identity_checksum
        AND committed_at IS NULL AND committed_identity_checksum IS NULL) OR
      (state = 'committed' AND file_published_at IS NOT NULL
        AND published_identity_checksum = expected_identity_checksum AND committed_at IS NOT NULL
        AND committed_identity_checksum = expected_identity_checksum)
    )
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_identity_metadata_no_update
    BEFORE UPDATE ON team_identity_storage_metadata
    BEGIN SELECT RAISE(ABORT, 'team identity schema metadata is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_identity_metadata_no_delete
    BEFORE DELETE ON team_identity_storage_metadata
    BEGIN SELECT RAISE(ABORT, 'team identity schema metadata is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_identity_no_delete
    BEFORE DELETE ON team_identity_records
    BEGIN SELECT RAISE(ABORT, 'team identity records are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_identity_transition
    BEFORE UPDATE ON team_identity_records
    WHEN NOT (
      OLD.state = 'adoption_prepared' AND NEW.state = 'file_published'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.adoption_intent_id IS OLD.adoption_intent_id
      AND OLD.identity_checksum IS NULL AND NEW.identity_checksum IS NOT NULL
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NULL
      AND NEW.created_at = OLD.created_at AND NEW.tombstoned_at IS NULL
    ) AND NOT (
      OLD.state = 'file_published' AND NEW.state = 'active'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.adoption_intent_id IS OLD.adoption_intent_id
      AND NEW.identity_checksum = OLD.identity_checksum
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
      AND NEW.created_at = OLD.created_at AND NEW.tombstoned_at IS NULL
    ) AND NOT (
      OLD.state IN ('reserved', 'adoption_prepared', 'file_published', 'active')
      AND NEW.state = 'tombstoned'
      AND NEW.team_id = OLD.team_id AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.adoption_intent_id IS OLD.adoption_intent_id
      AND NEW.identity_checksum IS OLD.identity_checksum
      AND NEW.created_at = OLD.created_at AND NEW.activated_at IS OLD.activated_at
      AND OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'illegal team identity transition'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_legacy_team_key_no_delete
    BEFORE DELETE ON legacy_team_key_reservations
    BEGIN SELECT RAISE(ABORT, 'legacy team key reservations are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_legacy_team_key_transition
    BEFORE UPDATE ON legacy_team_key_reservations
    WHEN NOT (
      OLD.state = 'active' AND NEW.state = 'tombstoned'
      AND NEW.legacy_key = OLD.legacy_key AND NEW.team_id = OLD.team_id
      AND NEW.reserved_at = OLD.reserved_at
      AND OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NOT NULL
      AND OLD.tombstone_reason IS NULL
      AND NEW.tombstone_reason IN ('draft_deleted', 'team_deleted', 'legacy_conflict')
    )
    BEGIN SELECT RAISE(ABORT, 'illegal legacy team key transition'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_adoption_intent_no_delete
    BEFORE DELETE ON team_adoption_intents
    BEGIN SELECT RAISE(ABORT, 'team adoption intents are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_team_adoption_intent_transition
    BEFORE UPDATE ON team_adoption_intents
    WHEN NOT (
      OLD.state = 'prepared' AND NEW.state = 'file_published'
      AND NEW.intent_id = OLD.intent_id AND NEW.team_id = OLD.team_id
      AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.expected_identity_checksum = OLD.expected_identity_checksum
      AND NEW.intent_checksum = OLD.intent_checksum AND NEW.prepared_at = OLD.prepared_at
      AND OLD.file_published_at IS NULL AND NEW.file_published_at IS NOT NULL
      AND OLD.published_identity_checksum IS NULL
      AND NEW.published_identity_checksum = OLD.expected_identity_checksum
      AND OLD.committed_at IS NULL AND NEW.committed_at IS NULL
      AND OLD.committed_identity_checksum IS NULL AND NEW.committed_identity_checksum IS NULL
    ) AND NOT (
      OLD.state = 'file_published' AND NEW.state = 'committed'
      AND NEW.intent_id = OLD.intent_id AND NEW.team_id = OLD.team_id
      AND NEW.legacy_key = OLD.legacy_key
      AND NEW.directory_fingerprint = OLD.directory_fingerprint
      AND NEW.workspace_id IS OLD.workspace_id
      AND NEW.workspace_binding_generation IS OLD.workspace_binding_generation
      AND NEW.expected_identity_checksum = OLD.expected_identity_checksum
      AND NEW.intent_checksum = OLD.intent_checksum AND NEW.prepared_at = OLD.prepared_at
      AND NEW.file_published_at = OLD.file_published_at
      AND NEW.published_identity_checksum = OLD.published_identity_checksum
      AND OLD.committed_at IS NULL AND NEW.committed_at IS NOT NULL
      AND OLD.committed_identity_checksum IS NULL
      AND NEW.committed_identity_checksum = OLD.expected_identity_checksum
    )
    BEGIN SELECT RAISE(ABORT, 'illegal team adoption intent transition'); END`,
] as const;

export interface TeamIdentityStorageSchemaDefinition {
  type: 'table' | 'index' | 'trigger';
  name: string;
  tableName: string;
  sql: string | null;
}

const TEAM_IDENTITY_STORAGE_SCHEMA_STATEMENT_SPECS = [
  {
    statementIndex: 0,
    type: 'table',
    name: 'team_identity_storage_metadata',
    tableName: 'team_identity_storage_metadata',
  },
  {
    statementIndex: 2,
    type: 'table',
    name: 'team_identity_records',
    tableName: 'team_identity_records',
  },
  {
    statementIndex: 3,
    type: 'index',
    name: 'idx_team_identity_checksum',
    tableName: 'team_identity_records',
  },
  {
    statementIndex: 4,
    type: 'table',
    name: 'legacy_team_key_reservations',
    tableName: 'legacy_team_key_reservations',
  },
  {
    statementIndex: 5,
    type: 'index',
    name: 'idx_legacy_team_key_active_owner',
    tableName: 'legacy_team_key_reservations',
  },
  {
    statementIndex: 6,
    type: 'table',
    name: 'team_adoption_intents',
    tableName: 'team_adoption_intents',
  },
  {
    statementIndex: 7,
    type: 'trigger',
    name: 'trg_team_identity_metadata_no_update',
    tableName: 'team_identity_storage_metadata',
  },
  {
    statementIndex: 8,
    type: 'trigger',
    name: 'trg_team_identity_metadata_no_delete',
    tableName: 'team_identity_storage_metadata',
  },
  {
    statementIndex: 9,
    type: 'trigger',
    name: 'trg_team_identity_no_delete',
    tableName: 'team_identity_records',
  },
  {
    statementIndex: 10,
    type: 'trigger',
    name: 'trg_team_identity_transition',
    tableName: 'team_identity_records',
  },
  {
    statementIndex: 11,
    type: 'trigger',
    name: 'trg_legacy_team_key_no_delete',
    tableName: 'legacy_team_key_reservations',
  },
  {
    statementIndex: 12,
    type: 'trigger',
    name: 'trg_legacy_team_key_transition',
    tableName: 'legacy_team_key_reservations',
  },
  {
    statementIndex: 13,
    type: 'trigger',
    name: 'trg_team_adoption_intent_no_delete',
    tableName: 'team_adoption_intents',
  },
  {
    statementIndex: 14,
    type: 'trigger',
    name: 'trg_team_adoption_intent_transition',
    tableName: 'team_adoption_intents',
  },
] as const;

/**
 * sqlite_schema removes IF NOT EXISTS from stored CREATE statements. Keeping
 * the expected SQL derived from the migration fragment makes provenance
 * verification byte-exact after that documented SQLite normalization.
 */
const TEAM_IDENTITY_STORAGE_CREATED_SCHEMA_DEFINITIONS: readonly TeamIdentityStorageSchemaDefinition[] =
  TEAM_IDENTITY_STORAGE_SCHEMA_STATEMENT_SPECS.map((spec) => ({
    type: spec.type,
    name: spec.name,
    tableName: spec.tableName,
    sql: TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS[spec.statementIndex].replace(
      /^CREATE (TABLE|UNIQUE INDEX|TRIGGER) IF NOT EXISTS /,
      'CREATE $1 '
    ),
  }));

const TEAM_IDENTITY_STORAGE_AUTO_INDEX_DEFINITIONS: readonly TeamIdentityStorageSchemaDefinition[] =
  [
    {
      type: 'index',
      name: 'sqlite_autoindex_team_identity_storage_metadata_1',
      tableName: 'team_identity_storage_metadata',
      sql: null,
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      type: 'index' as const,
      name: `sqlite_autoindex_team_identity_records_${index + 1}`,
      tableName: 'team_identity_records',
      sql: null,
    })),
    {
      type: 'index',
      name: 'sqlite_autoindex_legacy_team_key_reservations_1',
      tableName: 'legacy_team_key_reservations',
      sql: null,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      type: 'index' as const,
      name: `sqlite_autoindex_team_adoption_intents_${index + 1}`,
      tableName: 'team_adoption_intents',
      sql: null,
    })),
  ];

export const TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS: readonly TeamIdentityStorageSchemaDefinition[] =
  [
    ...TEAM_IDENTITY_STORAGE_CREATED_SCHEMA_DEFINITIONS,
    ...TEAM_IDENTITY_STORAGE_AUTO_INDEX_DEFINITIONS,
  ];

export const TEAM_IDENTITY_STORAGE_REQUIRED_SCHEMA_OBJECTS =
  TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.map(({ type, name }) => [type, name] as const);
