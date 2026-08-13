import { parseActorId } from '@shared/contracts/hosted';

import { HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS } from './hostedTeamApprovalAuthorityStorageMigration';
import { HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './hostedTeamApprovalCanonicalIdentityStorageMigration';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
type Shape = 'absent' | 'legacy' | 'canonical-v21' | 'canonical-v22' | 'invalid';

interface ColumnSpec {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

interface TableSpec {
  readonly columns: readonly string[];
  readonly foreignKeys: readonly string[];
  readonly indexes: readonly string[];
}

interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}

interface SchemaSqlSpec {
  readonly legacy: readonly string[];
  readonly canonicalV21: readonly string[];
  readonly canonicalV22: readonly string[];
}

interface SchemaSqlRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

const TABLES = [
  'hosted_team_approval_records',
  'hosted_team_approval_idempotency',
  'hosted_team_approval_audit',
  'hosted_team_approval_delivery_outbox',
] as const;

const APPROVAL_AUTO_INDEXES = [
  'sqlite_autoindex_hosted_team_approval_audit_1',
  'sqlite_autoindex_hosted_team_approval_delivery_outbox_1',
  'sqlite_autoindex_hosted_team_approval_delivery_outbox_2',
  'sqlite_autoindex_hosted_team_approval_idempotency_1',
  'sqlite_autoindex_hosted_team_approval_idempotency_2',
  'sqlite_autoindex_hosted_team_approval_idempotency_3',
  'sqlite_autoindex_hosted_team_approval_records_1',
] as const;

const SCHEMA_SQL = buildSchemaSqlSpec();

function buildSchemaSqlSpec(): SchemaSqlSpec {
  const legacy = schemaDefinitions(HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS);
  const canonicalV21 = schemaDefinitions(
    HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS,
    true
  );
  const canonicalV22 = canonicalV21.map((definition) =>
    definition.includes(':create table hosted_team_approval_delivery_outbox(')
      ? definition.replace(',unique(', ',principal_id text,unique(')
      : definition
  );
  return { legacy, canonicalV21, canonicalV22 };
}

function schemaDefinitions(statements: readonly string[], canonical = false): readonly string[] {
  const explicit = statements
    .filter((statement) => /^\s*CREATE (?:UNIQUE )?(?:TABLE|INDEX)\b/i.test(statement))
    .filter((statement) => !/\bTEMP\b/i.test(statement))
    .map(normalizeSchemaSql)
    .map((definition) =>
      canonical
        ? definition
            .replace(/^create table ([^(]+)_v21\(/, 'create table $1(')
            .replaceAll(
              'references hosted_team_approval_records_v21',
              'references hosted_team_approval_records'
            )
        : definition
    )
    .map(schemaObjectFingerprint);
  const automatic = APPROVAL_AUTO_INDEXES.map((name) => {
    const table = name.replace(/^sqlite_autoindex_/, '').replace(/_\d+$/, '');
    return `index:${name}:${table}:<null>`;
  });
  return [...explicit, ...automatic].sort((left, right) => left.localeCompare(right));
}

function normalizeSchemaSql(sql: string): string {
  const literals: string[] = [];
  const masked = sql.replace(/'(?:''|[^'])*'/g, (literal) => {
    const index = literals.push(literal) - 1;
    return `__APPROVAL_SQL_LITERAL_${index}__`;
  });
  const normalized = masked
    .replace(/"((?:""|[^"])*)"/g, (_match, identifier: string) => identifier.replaceAll('""', '"'))
    .replace(/\bIF NOT EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase();
  return normalized.replace(/__approval_sql_literal_(\d+)__/g, (_match, index: string) => {
    const literal = literals[Number(index)];
    if (literal === undefined) throw new Error('internal-storage-approval-schema-literal-invalid');
    return literal;
  });
}

function schemaObjectFingerprint(sql: string): string {
  const table = /^create table ([^(]+)/.exec(sql);
  if (table?.[1]) return `table:${table[1]}:${table[1]}:${sql}`;
  const index = /^create (?:unique )?index ([^ ]+) on ([^(]+)/.exec(sql);
  if (index?.[1] && index[2]) return `index:${index[1]}:${index[2]}:${sql}`;
  throw new Error('internal-storage-approval-schema-definition-invalid');
}

const column = (name: string, type: 'TEXT' | 'INTEGER', notnull = 1, pk = 0): string =>
  `${name}:${type}:${notnull}:${pk}`;

const LEGACY: Readonly<Record<(typeof TABLES)[number], TableSpec>> = {
  hosted_team_approval_records: {
    columns: [
      column('principal_id', 'TEXT', 1, 1),
      column('workspace_id', 'TEXT', 1, 2),
      column('team_id', 'TEXT', 1, 3),
      column('authority_generation', 'TEXT', 1, 4),
      column('restore_generation', 'INTEGER', 1, 5),
      column('approval_id', 'TEXT', 1, 6),
      column('approval_generation', 'TEXT', 1, 7),
      column('category', 'TEXT'),
      column('summary', 'TEXT'),
      column('requested_at_ms', 'INTEGER'),
      column('expires_at_ms', 'INTEGER', 0),
      column('preview_ref', 'TEXT', 0),
      column('preview_content', 'TEXT', 0),
      column('preview_byte_length', 'INTEGER', 0),
      column('preview_truncated', 'INTEGER', 0),
      column('preview_is_binary', 'INTEGER', 0),
      column('delivery_ref', 'TEXT'),
      column('state', 'TEXT'),
      column('decision', 'TEXT', 0),
      column('revision', 'INTEGER'),
      column('observed_at_ms', 'INTEGER'),
      column('resolved_at_ms', 'INTEGER', 0),
      column('last_idempotency_key', 'TEXT', 0),
      column('payload_hash', 'TEXT', 0),
    ],
    foreignKeys: [],
    indexes: [
      'idx_hosted_team_approval_current_generation:0:c:principal_id,workspace_id,team_id,authority_generation,restore_generation,approval_id,observed_at_ms',
      'idx_hosted_team_approval_one_pending_generation:1:c:principal_id,workspace_id,team_id,authority_generation,restore_generation,approval_id',
      'idx_hosted_team_approval_pending_page:0:c:principal_id,workspace_id,team_id,authority_generation,restore_generation,state,approval_id',
    ],
  },
  hosted_team_approval_idempotency: {
    columns: [
      column('principal_id', 'TEXT', 1, 1),
      column('workspace_id', 'TEXT', 1, 2),
      column('team_id', 'TEXT', 1, 3),
      column('authority_generation', 'TEXT', 1, 4),
      column('restore_generation', 'INTEGER', 1, 5),
      column('idempotency_key', 'TEXT', 1, 6),
      column('approval_id', 'TEXT'),
      column('approval_generation', 'TEXT'),
      column('decision', 'TEXT'),
      column('payload_hash', 'TEXT'),
      column('revision', 'INTEGER'),
      column('audit_id', 'TEXT'),
      column('delivery_id', 'TEXT'),
      column('created_at_ms', 'INTEGER'),
    ],
    foreignKeys: legacyForeignKeys(),
    indexes: [],
  },
  hosted_team_approval_audit: {
    columns: [
      column('audit_id', 'TEXT', 0, 1),
      column('principal_id', 'TEXT'),
      column('workspace_id', 'TEXT'),
      column('team_id', 'TEXT'),
      column('authority_generation', 'TEXT'),
      column('restore_generation', 'INTEGER'),
      column('approval_id', 'TEXT'),
      column('approval_generation', 'TEXT'),
      column('decision', 'TEXT'),
      column('payload_hash', 'TEXT'),
      column('actor_id', 'TEXT'),
      column('session_id', 'TEXT'),
      column('occurred_at_ms', 'INTEGER'),
    ],
    foreignKeys: legacyForeignKeys(),
    indexes: [
      'idx_hosted_team_approval_audit_scope:0:c:principal_id,workspace_id,team_id,authority_generation,restore_generation,occurred_at_ms',
    ],
  },
  hosted_team_approval_delivery_outbox: {
    columns: legacyDeliveryColumns(),
    foreignKeys: legacyForeignKeys(),
    indexes: [
      'idx_hosted_team_approval_delivery_pending:0:c:state,delivery_lease_expires_at_ms,created_at_ms,delivery_id',
    ],
  },
};

function legacyForeignKeys(): readonly string[] {
  const names = [
    'principal_id',
    'workspace_id',
    'team_id',
    'authority_generation',
    'restore_generation',
    'approval_id',
    'approval_generation',
  ];
  return names.map(
    (name, sequence) =>
      `0:${sequence}:hosted_team_approval_records:${name}:${name}:RESTRICT:RESTRICT:NONE`
  );
}

function legacyDeliveryColumns(): readonly string[] {
  return [
    column('delivery_id', 'TEXT', 0, 1),
    column('principal_id', 'TEXT'),
    column('workspace_id', 'TEXT'),
    column('team_id', 'TEXT'),
    column('authority_generation', 'TEXT'),
    column('restore_generation', 'INTEGER'),
    column('approval_id', 'TEXT'),
    column('approval_generation', 'TEXT'),
    column('decision', 'TEXT'),
    column('payload_hash', 'TEXT'),
    column('delivery_ref', 'TEXT'),
    column('intent_json', 'TEXT'),
    column('state', 'TEXT'),
    column('delivery_generation', 'INTEGER'),
    column('delivery_owner_id', 'TEXT', 0),
    column('delivery_lease_token', 'TEXT', 0),
    column('delivery_claimed_at_ms', 'INTEGER', 0),
    column('delivery_lease_expires_at_ms', 'INTEGER', 0),
    column('delivered_at_ms', 'INTEGER', 0),
    column('created_at_ms', 'INTEGER'),
  ];
}

const CANONICAL: Readonly<Record<(typeof TABLES)[number], TableSpec>> = {
  hosted_team_approval_records: {
    columns: [
      column('workspace_id', 'TEXT', 1, 1),
      column('team_id', 'TEXT', 1, 2),
      column('authority_generation', 'TEXT', 1, 3),
      column('restore_generation', 'INTEGER', 1, 4),
      column('run_id', 'TEXT', 1, 5),
      column('request_id', 'TEXT', 1, 6),
      column('approval_id', 'TEXT'),
      column('approval_generation', 'TEXT'),
      column('category', 'TEXT'),
      column('summary', 'TEXT'),
      column('requested_at_ms', 'INTEGER'),
      column('expires_at_ms', 'INTEGER', 0),
      column('preview_ref', 'TEXT', 0),
      column('preview_content', 'TEXT', 0),
      column('preview_byte_length', 'INTEGER', 0),
      column('preview_truncated', 'INTEGER', 0),
      column('preview_is_binary', 'INTEGER', 0),
      column('delivery_ref', 'TEXT'),
      column('state', 'TEXT'),
      column('decision', 'TEXT', 0),
      column('revision', 'INTEGER'),
      column('observed_at_ms', 'INTEGER'),
      column('resolved_at_ms', 'INTEGER', 0),
      column('last_idempotency_key', 'TEXT', 0),
      column('payload_hash', 'TEXT', 0),
    ],
    foreignKeys: [],
    indexes: [
      'idx_hosted_team_approval_identity:1:c:workspace_id,team_id,authority_generation,restore_generation,run_id,approval_id',
      'idx_hosted_team_approval_pending_page:0:c:team_id,state,approval_id',
      'idx_hosted_team_approval_pending_partition:0:c:team_id,run_id,state,approval_id',
    ],
  },
  hosted_team_approval_idempotency: {
    columns: [
      column('workspace_id', 'TEXT', 1, 1),
      column('team_id', 'TEXT', 1, 2),
      column('authority_generation', 'TEXT', 1, 3),
      column('restore_generation', 'INTEGER', 1, 4),
      column('run_id', 'TEXT', 1, 5),
      column('idempotency_key', 'TEXT', 1, 6),
      column('request_id', 'TEXT'),
      column('approval_id', 'TEXT'),
      column('approval_generation', 'TEXT'),
      column('decision', 'TEXT'),
      column('payload_hash', 'TEXT'),
      column('revision', 'INTEGER'),
      column('audit_id', 'TEXT'),
      column('delivery_id', 'TEXT'),
      column('created_at_ms', 'INTEGER'),
    ],
    foreignKeys: canonicalForeignKeys(),
    indexes: [],
  },
  hosted_team_approval_audit: {
    columns: [
      column('audit_id', 'TEXT', 0, 1),
      column('workspace_id', 'TEXT'),
      column('team_id', 'TEXT'),
      column('authority_generation', 'TEXT'),
      column('restore_generation', 'INTEGER'),
      column('run_id', 'TEXT'),
      column('request_id', 'TEXT'),
      column('approval_id', 'TEXT'),
      column('approval_generation', 'TEXT'),
      column('decision', 'TEXT'),
      column('payload_hash', 'TEXT'),
      column('actor_id', 'TEXT'),
      column('session_id', 'TEXT'),
      column('occurred_at_ms', 'INTEGER'),
    ],
    foreignKeys: canonicalForeignKeys(),
    indexes: ['idx_hosted_team_approval_audit_partition:0:c:team_id,run_id,occurred_at_ms'],
  },
  hosted_team_approval_delivery_outbox: {
    columns: canonicalDeliveryColumns(false),
    foreignKeys: canonicalForeignKeys(),
    indexes: [
      'idx_hosted_team_approval_delivery_pending:0:c:state,delivery_owner_id,delivery_lease_expires_at_ms,created_at_ms,delivery_id',
    ],
  },
};

function canonicalForeignKeys(): readonly string[] {
  const names = [
    'workspace_id',
    'team_id',
    'authority_generation',
    'restore_generation',
    'run_id',
    'request_id',
  ];
  return names.map(
    (name, sequence) =>
      `0:${sequence}:hosted_team_approval_records:${name}:${name}:RESTRICT:RESTRICT:NONE`
  );
}

function canonicalDeliveryColumns(withPrincipal: boolean): readonly string[] {
  const columns = [
    column('delivery_id', 'TEXT', 0, 1),
    column('workspace_id', 'TEXT'),
    column('team_id', 'TEXT'),
    column('authority_generation', 'TEXT'),
    column('restore_generation', 'INTEGER'),
    column('run_id', 'TEXT'),
    column('request_id', 'TEXT'),
    column('approval_id', 'TEXT'),
    column('approval_generation', 'TEXT'),
    column('decision', 'TEXT'),
    column('payload_hash', 'TEXT'),
    column('delivery_ref', 'TEXT'),
    column('intent_json', 'TEXT'),
    column('state', 'TEXT'),
    column('delivery_generation', 'INTEGER'),
    column('delivery_owner_id', 'TEXT', 0),
    column('delivery_lease_token', 'TEXT', 0),
    column('delivery_claimed_at_ms', 'INTEGER', 0),
    column('delivery_lease_expires_at_ms', 'INTEGER', 0),
    column('delivered_at_ms', 'INTEGER', 0),
    column('created_at_ms', 'INTEGER'),
  ];
  return withPrincipal ? [...columns, column('principal_id', 'TEXT', 0)] : columns;
}

export function runHostedTeamApprovalMigrationRepair(db: SqliteDatabase, version: number): boolean {
  if (version === 18) {
    const shape = detectShape(db);
    if (shape === 'absent') {
      assertNoApprovalTempShadows(db, 'internal-storage-v18-approval-temp-shadow');
      execute(db, HOSTED_TEAM_APPROVAL_AUTHORITY_STORAGE_MIGRATION_STATEMENTS);
      assertShape(db, 'legacy');
    } else if (shape !== 'legacy' && shape !== 'canonical-v21' && shape !== 'canonical-v22') {
      throw new Error('internal-storage-v18-approval-schema-invalid');
    }
    return true;
  }
  if (version === 21) {
    const shape = detectShape(db);
    if (shape === 'legacy') {
      assertNoApprovalTempShadows(db, 'internal-storage-v21-approval-temp-shadow');
      migrateCanonicalIdentity(db);
    } else if (shape !== 'canonical-v21' && shape !== 'canonical-v22') {
      throw new Error('internal-storage-v21-approval-schema-invalid');
    }
    return true;
  }
  if (version === 22) {
    migratePrincipalIdentity(db);
    return true;
  }
  if (version === 23) {
    migratePrincipalJson(db);
    return true;
  }
  return false;
}

function migrateCanonicalIdentity(db: SqliteDatabase): void {
  const before = rowCounts(db);
  execute(db, HOSTED_TEAM_APPROVAL_CANONICAL_IDENTITY_STORAGE_MIGRATION_STATEMENTS);
  assertShape(db, 'canonical-v21');
  assertRowCounts(db, before, 'internal-storage-v21-approval-row-count-mismatch');
  assertForeignKeys(db, 'internal-storage-v21-approval-foreign-key-invalid');
}

function assertNoApprovalTempShadows(db: SqliteDatabase, error: string): void {
  const shadow = db
    .prepare(
      `SELECT 1 FROM temp.sqlite_schema
       WHERE lower(name) LIKE 'hosted_team_approval_%'
          OR lower(tbl_name) LIKE 'hosted_team_approval_%'
          OR lower(name) LIKE 'idx_hosted_team_approval_%'
       LIMIT 1`
    )
    .get();
  if (shadow) throw new Error(error);
}

function migratePrincipalIdentity(db: SqliteDatabase): void {
  const before = rowCounts(db);
  const shape = detectShape(db);
  if (shape !== 'canonical-v21' && shape !== 'canonical-v22') {
    throw new Error('internal-storage-v22-approval-schema-invalid');
  }
  if (shape === 'canonical-v21') {
    db.exec(`ALTER TABLE main.hosted_team_approval_delivery_outbox ADD COLUMN principal_id TEXT`);
  }
  db.exec(
    `UPDATE main.hosted_team_approval_delivery_outbox AS delivery
     SET principal_id = CASE
       WHEN delivery.decision = 'timeout' THEN 'actor_approval-timeout-system'
       ELSE (
         SELECT audit.actor_id FROM main.hosted_team_approval_audit AS audit
         WHERE audit.workspace_id = delivery.workspace_id
           AND audit.team_id = delivery.team_id
           AND audit.authority_generation = delivery.authority_generation
           AND audit.restore_generation = delivery.restore_generation
           AND audit.run_id = delivery.run_id
           AND audit.request_id = delivery.request_id
           AND audit.approval_id = delivery.approval_id
           AND audit.approval_generation = delivery.approval_generation
           AND audit.decision = delivery.decision
           AND length(trim(audit.actor_id)) > 0
         ORDER BY audit.occurred_at_ms DESC, audit.audit_id DESC LIMIT 1
       )
     END
     WHERE principal_id IS NULL`
  );
  assertV22Principals(db);
  assertShape(db, 'canonical-v22');
  assertRowCounts(db, before, 'internal-storage-v22-approval-row-count-mismatch');
}

function assertV22Principals(db: SqliteDatabase): void {
  const rows = db
    .prepare(
      `SELECT delivery.delivery_id AS deliveryId, delivery.decision,
       delivery.principal_id AS principalId, delivery.workspace_id AS workspaceId,
       delivery.team_id AS teamId, delivery.authority_generation AS authorityGeneration,
       delivery.restore_generation AS restoreGeneration, delivery.run_id AS runId,
       delivery.request_id AS requestId, delivery.approval_id AS approvalId,
       delivery.approval_generation AS approvalGeneration
     FROM main.hosted_team_approval_delivery_outbox AS delivery`
    )
    .all() as readonly {
    deliveryId: string;
    decision: string;
    principalId: string | null;
    workspaceId: string;
    teamId: string;
    authorityGeneration: string;
    restoreGeneration: number;
    runId: string;
    requestId: string;
    approvalId: string;
    approvalGeneration: string;
  }[];
  for (const row of rows) {
    const actorId = readV22ActorId(row.principalId, row.decision);
    if (actorId === null) continue;
    const audit = db
      .prepare(
        `SELECT 1 FROM main.hosted_team_approval_audit
       WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
         AND restore_generation = ? AND run_id = ? AND request_id = ?
         AND approval_id = ? AND approval_generation = ? AND decision = ?
         AND actor_id = ? AND length(trim(actor_id)) > 0 LIMIT 1`
      )
      .get(
        row.workspaceId,
        row.teamId,
        row.authorityGeneration,
        row.restoreGeneration,
        row.runId,
        row.requestId,
        row.approvalId,
        row.approvalGeneration,
        row.decision,
        actorId
      );
    if (!audit) throw new Error('internal-storage-v22-approval-principal-invalid');
  }
}

function readV22ActorId(value: string | null, decision: string): string | null {
  if (!value?.trim()) throw new Error('internal-storage-v22-approval-principal-invalid');
  if (!value.startsWith('{') && !value.startsWith('[')) {
    if (decision === 'timeout') {
      if (value !== 'actor_approval-timeout-system') {
        throw new Error('internal-storage-v22-approval-principal-invalid');
      }
      return null;
    }
    return validateActorId(value, 'internal-storage-v22-approval-principal-invalid');
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isExactPrincipal(parsed, decision)) throw new Error('invalid');
    return decision === 'timeout'
      ? null
      : validateActorId(
          (parsed as { actorId: string }).actorId,
          'internal-storage-v22-approval-principal-invalid'
        );
  } catch {
    throw new Error('internal-storage-v22-approval-principal-invalid');
  }
}

function migratePrincipalJson(db: SqliteDatabase): void {
  if (detectShape(db) !== 'canonical-v22') {
    throw new Error('internal-storage-v23-approval-schema-invalid');
  }
  const before = rowCounts(db);
  const rows = db
    .prepare(
      `SELECT delivery_id AS deliveryId, decision, principal_id AS principalId
     FROM main.hosted_team_approval_delivery_outbox`
    )
    .all() as readonly { deliveryId: string; decision: string; principalId: string | null }[];
  const update = db.prepare(
    `UPDATE main.hosted_team_approval_delivery_outbox SET principal_id = ? WHERE delivery_id = ?`
  );
  for (const row of rows) {
    const normalized = normalizePrincipal(row.principalId, row.decision);
    if (normalized !== row.principalId) update.run(normalized, row.deliveryId);
  }
  const invalid = db
    .prepare(
      `SELECT 1 FROM main.hosted_team_approval_delivery_outbox
     WHERE principal_id IS NULL OR json_valid(principal_id) = 0
       OR (decision = 'timeout' AND NOT (
         json_type(principal_id, '$.kind') = 'text'
         AND json_extract(principal_id, '$.kind') = 'system_timeout'
         AND (SELECT COUNT(*) FROM json_each(principal_id)) = 1))
       OR (decision <> 'timeout' AND NOT (
         json_type(principal_id, '$.kind') = 'text'
         AND json_extract(principal_id, '$.kind') = 'operator'
         AND json_type(principal_id, '$.actorId') = 'text'
         AND length(trim(json_extract(principal_id, '$.actorId'))) > 0
         AND (SELECT COUNT(*) FROM json_each(principal_id)) = 2)) LIMIT 1`
    )
    .get();
  if (invalid) throw new Error('internal-storage-v23-approval-principal-invalid');
  assertRowCounts(db, before, 'internal-storage-v23-approval-row-count-mismatch');
}

function normalizePrincipal(value: string | null, decision: string): string {
  if (!value) throw new Error('internal-storage-v23-approval-principal-invalid');
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!isExactPrincipal(parsed, decision)) throw new Error('invalid');
      return value;
    } catch {
      throw new Error('internal-storage-v23-approval-principal-invalid');
    }
  }
  if (decision === 'timeout') {
    if (value !== 'actor_approval-timeout-system') {
      throw new Error('internal-storage-v23-approval-principal-invalid');
    }
    return '{"kind":"system_timeout"}';
  }
  const actorId = validateActorId(value, 'internal-storage-v23-approval-principal-invalid');
  return JSON.stringify({ kind: 'operator', actorId });
}

function isExactPrincipal(value: unknown, decision: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  if (decision === 'timeout') {
    return keys.length === 1 && keys[0] === 'kind' && record.kind === 'system_timeout';
  }
  if (keys.join(',') !== 'actorId,kind' || record.kind !== 'operator') return false;
  try {
    parseActorId(record.actorId);
    return true;
  } catch {
    return false;
  }
}

function detectShape(db: SqliteDatabase): Shape {
  const present = TABLES.filter((table) => tableExists(db, table));
  if (present.length === 0) return 'absent';
  if (present.length !== TABLES.length) return 'invalid';
  if (matches(db, LEGACY) && matchesSchemaSql(db, SCHEMA_SQL.legacy)) return 'legacy';
  if (matches(db, CANONICAL) && matchesSchemaSql(db, SCHEMA_SQL.canonicalV21)) {
    return 'canonical-v21';
  }
  const canonicalV22 = {
    ...CANONICAL,
    hosted_team_approval_delivery_outbox: {
      ...CANONICAL.hosted_team_approval_delivery_outbox,
      columns: canonicalDeliveryColumns(true),
    },
  };
  return matches(db, canonicalV22) && matchesSchemaSql(db, SCHEMA_SQL.canonicalV22)
    ? 'canonical-v22'
    : 'invalid';
}

function matches(
  db: SqliteDatabase,
  expected: Readonly<Record<(typeof TABLES)[number], TableSpec>>
): boolean {
  return TABLES.every((table) => {
    const columns = db.pragma(`main.table_info('${table}')`) as readonly ColumnSpec[];
    const actualColumns = columns.map(
      ({ name, type, notnull, pk }) => `${name}:${type}:${notnull}:${pk}`
    );
    return (
      equal(actualColumns, expected[table].columns) &&
      equal(readForeignKeys(db, table), expected[table].foreignKeys) &&
      equal(readCriticalIndexes(db, table), expected[table].indexes)
    );
  });
}

function matchesSchemaSql(db: SqliteDatabase, expected: readonly string[]): boolean {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
       WHERE tbl_name LIKE 'hosted_team_approval_%'
          OR name LIKE 'hosted_team_approval_%'
          OR name LIKE 'sqlite_autoindex_hosted_team_approval_%'`
    )
    .all() as readonly SchemaSqlRow[];
  const actual = rows
    .map(
      ({ type, name, tbl_name: table, sql }) =>
        `${type}:${name}:${table}:${sql === null ? '<null>' : normalizeSchemaSql(sql)}`
    )
    .sort((left, right) => left.localeCompare(right));
  return equal(actual, expected);
}

function readForeignKeys(db: SqliteDatabase, table: string): readonly string[] {
  const rows = db.pragma(`main.foreign_key_list('${table}')`) as readonly ForeignKeyRow[];
  return rows.map(
    (row) =>
      `${row.id}:${row.seq}:${row.table}:${row.from}:${row.to}:${row.on_update}:${row.on_delete}:${row.match}`
  );
}

function readCriticalIndexes(db: SqliteDatabase, table: string): readonly string[] {
  const rows = db.pragma(`main.index_list('${table}')`) as readonly {
    name: string;
    unique: number;
    origin: string;
  }[];
  return rows
    .filter(({ origin }) => origin === 'c')
    .map(({ name, unique, origin }) => {
      const columns = db.pragma(`main.index_info('${name}')`) as readonly { name: string }[];
      return `${name}:${unique}:${origin}:${columns.map((entry) => entry.name).join(',')}`;
    })
    .sort((left, right) => left.localeCompare(right));
}

function rowCounts(db: SqliteDatabase): readonly number[] {
  return TABLES.map(
    (table) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM main.${table}`).get() as { count: number }).count
  );
}

function assertRowCounts(db: SqliteDatabase, expected: readonly number[], error: string): void {
  if (!equal(rowCounts(db), expected)) throw new Error(error);
}

function assertForeignKeys(db: SqliteDatabase, error: string): void {
  if ((db.pragma('main.foreign_key_check') as readonly unknown[]).length > 0)
    throw new Error(error);
}

function assertShape(db: SqliteDatabase, expected: Shape): void {
  if (detectShape(db) !== expected)
    throw new Error(`internal-storage-approval-schema-postcondition-${expected}`);
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?`).get(table)
  );
}

function execute(db: SqliteDatabase, statements: readonly string[]): void {
  for (const statement of statements) db.exec(statement);
}

function equal(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateActorId(value: unknown, error: string): string {
  try {
    return parseActorId(value);
  } catch {
    throw new Error(error);
  }
}
