import { INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES } from '../../application/internalStorageBackupContract';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export { INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES };

export const HOSTED_WORKSPACE_ACCESS_MIGRATION_STATEMENTS = Object.freeze([
  `CREATE TABLE hosted_workspaces_v16 (
    runtime_workspace_id TEXT PRIMARY KEY,
    public_workspace_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    registered_at INTEGER NOT NULL,
    registered_by TEXT,
    FOREIGN KEY (registered_by) REFERENCES users(user_id) ON DELETE RESTRICT
  )`,
  `INSERT INTO hosted_workspaces_v16
     (runtime_workspace_id, public_workspace_id, display_name, status, registered_at, registered_by)
   SELECT workspace_id, 'workspace_' || lower(hex(randomblob(16))),
          display_name, status, registered_at, registered_by
   FROM hosted_workspaces`,
  `DROP TABLE hosted_workspaces`,
  `ALTER TABLE hosted_workspaces_v16 RENAME TO hosted_workspaces`,
  `CREATE TABLE IF NOT EXISTS hosted_workspace_grants (
    user_id TEXT NOT NULL,
    runtime_workspace_id TEXT NOT NULL,
    grant_generation INTEGER NOT NULL CHECK (grant_generation >= 0),
    granted_at INTEGER NOT NULL,
    granted_by TEXT NOT NULL CHECK (granted_by = 'local-cli'),
    PRIMARY KEY (user_id, runtime_workspace_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (runtime_workspace_id)
      REFERENCES hosted_workspaces(runtime_workspace_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hosted_workspace_grants_generation
    ON hosted_workspace_grants (user_id, grant_generation, runtime_workspace_id)`,
] as const);

type TableColumnShape = readonly [
  name: string,
  type: string,
  notnull: number,
  primaryKeyPosition: number,
];

const LEGACY_HOSTED_WORKSPACE_COLUMNS: readonly TableColumnShape[] = Object.freeze([
  ['workspace_id', 'TEXT', 0, 1],
  ['display_name', 'TEXT', 1, 0],
  ['status', 'TEXT', 1, 0],
  ['registered_at', 'INTEGER', 1, 0],
  ['registered_by', 'TEXT', 0, 0],
]);
const CURRENT_HOSTED_WORKSPACE_COLUMNS: readonly TableColumnShape[] = Object.freeze([
  ['runtime_workspace_id', 'TEXT', 0, 1],
  ['public_workspace_id', 'TEXT', 1, 0],
  ['display_name', 'TEXT', 1, 0],
  ['status', 'TEXT', 1, 0],
  ['registered_at', 'INTEGER', 1, 0],
  ['registered_by', 'TEXT', 0, 0],
]);
const V16_HOSTED_WORKSPACE_GRANT_COLUMNS: readonly TableColumnShape[] = Object.freeze([
  ['user_id', 'TEXT', 1, 1],
  ['runtime_workspace_id', 'TEXT', 1, 2],
  ['grant_generation', 'INTEGER', 1, 0],
  ['granted_at', 'INTEGER', 1, 0],
  ['granted_by', 'TEXT', 1, 0],
]);
const V20_HOSTED_WORKSPACE_GRANT_COLUMNS: readonly TableColumnShape[] = Object.freeze([
  ['user_id', 'TEXT', 1, 1],
  ['runtime_workspace_id', 'TEXT', 1, 2],
  ['grant_generation', 'INTEGER', 1, 0],
  ['grant_revision', 'TEXT', 1, 0],
  ['granted_at', 'INTEGER', 1, 0],
  ['granted_by', 'TEXT', 1, 0],
]);

/**
 * A restored database can have a current table shape with an older user_version.
 * Do not destructively rebuild it as though it still exposed the v13 workspace_id column.
 */
export function migrateHostedWorkspaceAccess(db: SqliteDatabase): void {
  const workspaceColumns = readTableColumns(db, 'hosted_workspaces');
  const legacy = sameColumns(workspaceColumns, LEGACY_HOSTED_WORKSPACE_COLUMNS);
  const current = sameColumns(workspaceColumns, CURRENT_HOSTED_WORKSPACE_COLUMNS);
  if (!legacy && !current) {
    throw new Error('hosted-workspace-access-migration-metadata-invalid');
  }
  if (legacy && readTableColumns(db, 'hosted_workspace_grants').length > 0) {
    throw new Error('hosted-workspace-access-migration-metadata-invalid');
  }
  const statements = legacy
    ? HOSTED_WORKSPACE_ACCESS_MIGRATION_STATEMENTS
    : HOSTED_WORKSPACE_ACCESS_MIGRATION_STATEMENTS.slice(4);
  for (const statement of statements) db.exec(statement);
  const grantColumns = readTableColumns(db, 'hosted_workspace_grants');
  if (
    !sameColumns(readTableColumns(db, 'hosted_workspaces'), CURRENT_HOSTED_WORKSPACE_COLUMNS) ||
    (!sameColumns(grantColumns, V16_HOSTED_WORKSPACE_GRANT_COLUMNS) &&
      !sameColumns(grantColumns, V20_HOSTED_WORKSPACE_GRANT_COLUMNS)) ||
    !hasExactIndex(db, 'hosted_workspaces', ['public_workspace_id'], true) ||
    !hasExactIndex(
      db,
      'hosted_workspace_grants',
      ['user_id', 'grant_generation', 'runtime_workspace_id'],
      false
    )
  ) {
    throw new Error('hosted-workspace-access-migration-metadata-invalid');
  }
}

interface TableColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

function readTableColumns(db: SqliteDatabase, tableName: string): readonly TableColumn[] {
  return db.pragma(`table_info(${tableName})`) as TableColumn[];
}

function sameColumns(
  actual: readonly TableColumn[],
  expected: readonly TableColumnShape[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => {
      const shape = expected[index];
      return (
        column.name === shape[0] &&
        column.type === shape[1] &&
        column.notnull === shape[2] &&
        column.dflt_value === null &&
        column.pk === shape[3]
      );
    })
  );
}

function hasExactIndex(
  db: SqliteDatabase,
  tableName: string,
  columnNames: readonly string[],
  unique: boolean
): boolean {
  const indexes = db.pragma(`index_list(${tableName})`) as {
    readonly name: string;
    readonly unique: number;
  }[];
  return indexes.some((index) => {
    if (index.unique !== Number(unique)) return false;
    const quotedIndexName = `"${index.name.replaceAll('"', '""')}"`;
    const indexedColumns = db.pragma(`index_info(${quotedIndexName})`) as {
      readonly name: string;
    }[];
    return (
      indexedColumns.length === columnNames.length &&
      indexedColumns.every((column, position) => column.name === columnNames[position])
    );
  });
}

export function ensureHostedAuthResetColumns(db: SqliteDatabase): void {
  const columns = new Set(readHostedAuthConfigurationColumns(db).map((column) => column.name));
  if (!columns.has('reset_generation')) {
    db.exec(
      `ALTER TABLE hosted_auth_configuration
       ADD COLUMN reset_generation INTEGER NOT NULL DEFAULT 0
         CHECK (reset_generation >= 0)`
    );
  }
  if (!columns.has('secrets_rotated_generation')) {
    db.exec(
      `ALTER TABLE hosted_auth_configuration
       ADD COLUMN secrets_rotated_generation INTEGER NOT NULL DEFAULT 0
         CHECK (
           secrets_rotated_generation >= 0
           AND secrets_rotated_generation <= reset_generation
         )`
    );
  }
  if (!columns.has('pending_personal_keyring_id')) {
    db.exec(`ALTER TABLE hosted_auth_configuration ADD COLUMN pending_personal_keyring_id TEXT`);
  }
  const migratedColumns = new Map(
    readHostedAuthConfigurationColumns(db).map((column) => [column.name, column])
  );
  const resetGeneration = migratedColumns.get('reset_generation');
  const secretsRotatedGeneration = migratedColumns.get('secrets_rotated_generation');
  const pendingPersonalKeyringId = migratedColumns.get('pending_personal_keyring_id');
  if (
    resetGeneration?.type !== 'INTEGER' ||
    resetGeneration.notnull !== 1 ||
    resetGeneration.dflt_value !== '0' ||
    resetGeneration.pk !== 0 ||
    secretsRotatedGeneration?.type !== 'INTEGER' ||
    secretsRotatedGeneration.notnull !== 1 ||
    secretsRotatedGeneration.dflt_value !== '0' ||
    secretsRotatedGeneration.pk !== 0 ||
    pendingPersonalKeyringId?.type !== 'TEXT' ||
    pendingPersonalKeyringId.notnull !== 0 ||
    pendingPersonalKeyringId.dflt_value !== null ||
    pendingPersonalKeyringId.pk !== 0
  ) {
    throw new Error('hosted-auth-reset-migration-metadata-invalid');
  }
}

function readHostedAuthConfigurationColumns(db: SqliteDatabase): readonly {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}[] {
  return db.pragma('table_info(hosted_auth_configuration)') as {
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    readonly pk: number;
  }[];
}

function modeResetRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(code);
  }
  return value as Record<string, unknown>;
}

function modeResetText(value: unknown, code: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(code);
  }
  return value;
}

function modeResetInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(code);
  return Number(value);
}

function modeResetNullableText(value: unknown, code: string): string | null {
  return value === null ? null : modeResetText(value, code);
}

interface ModeResetAuditEvent {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly sourceIpHash: string | null;
  readonly detailsJson: string;
}

/**
 * Owns the one cross-table hosted-auth transition. It lives beside the
 * authoritative backup inventory because every table it mutates is part of
 * the same coordinated durability domain.
 */
export class HostedAuthModeStorageOps {
  constructor(private readonly database: () => SqliteDatabase) {}

  readConfiguration(): unknown {
    return (
      this.database()
        .prepare(
          `SELECT auth_mode AS authMode, configured_at AS configuredAt,
                  reset_generation AS resetGeneration,
                  secrets_rotated_generation AS secretsRotatedGeneration,
                  pending_personal_keyring_id AS pendingPersonalKeyringId
           FROM hosted_auth_configuration WHERE singleton = 1`
        )
        .get() ?? null
    );
  }

  resetMode(payload: Record<string, unknown>): string {
    const currentMode = modeResetText(payload.currentMode, 'hosted-auth-current-mode-invalid');
    const targetMode = modeResetText(payload.targetMode, 'hosted-auth-target-mode-invalid');
    if (
      (currentMode !== 'personal' && currentMode !== 'oidc') ||
      (targetMode !== 'personal' && targetMode !== 'oidc') ||
      currentMode === targetMode
    ) {
      throw new TypeError('hosted-auth-mode-transition-invalid');
    }
    const resetGeneration = modeResetInteger(
      payload.resetGeneration,
      'hosted-auth-reset-generation-invalid'
    );
    if (resetGeneration === 0) throw new TypeError('hosted-auth-reset-generation-invalid');
    const resetAt = modeResetInteger(payload.resetAt, 'hosted-auth-reset-at-invalid');
    const pendingPersonalKeyringId = modeResetText(
      payload.pendingPersonalKeyringId,
      'hosted-auth-pending-keyring-invalid',
      128
    );
    const expectedAuthorityRevision =
      payload.expectedAuthorityRevision === null
        ? null
        : modeResetInteger(
            payload.expectedAuthorityRevision,
            'hosted-auth-authority-revision-invalid'
          );
    const nextAuthorityStateJson = modeResetText(
      payload.nextAuthorityStateJson,
      'hosted-auth-authority-state-invalid',
      4_000_000
    );
    const parsedState = modeResetRecord(
      JSON.parse(nextAuthorityStateJson) as unknown,
      'hosted-auth-authority-state-invalid'
    );
    const nextAuthorityRevision = modeResetInteger(
      parsedState.revision,
      'hosted-auth-authority-revision-invalid'
    );
    if (
      parsedState.expectedKeyringId !== pendingPersonalKeyringId ||
      parsedState.consumedResetGeneration !== resetGeneration ||
      !Array.isArray(parsedState.pairingChallenges) ||
      parsedState.pairingChallenges.length !== 0 ||
      !Array.isArray(parsedState.deviceFamilies) ||
      parsedState.deviceFamilies.length !== 0 ||
      !Array.isArray(parsedState.deviceGrants) ||
      parsedState.deviceGrants.length !== 0 ||
      !Array.isArray(parsedState.sessions) ||
      parsedState.sessions.length !== 0 ||
      parsedState.resetIntent !== null
    ) {
      throw new TypeError('hosted-auth-authority-reset-state-invalid');
    }
    if (
      (expectedAuthorityRevision === null && nextAuthorityRevision !== 0) ||
      (expectedAuthorityRevision !== null &&
        nextAuthorityRevision !== expectedAuthorityRevision + 1)
    ) {
      throw new TypeError('hosted-auth-authority-reset-sequence-invalid');
    }
    const event = this.parseAuditEvent(payload.auditEvent);

    return this.database().transaction(() => {
      const configuration = this.database()
        .prepare(
          `SELECT auth_mode AS authMode, reset_generation AS resetGeneration
           FROM hosted_auth_configuration WHERE singleton = 1`
        )
        .get() as { readonly authMode: string; readonly resetGeneration: number } | undefined;
      if (configuration?.authMode !== currentMode) return 'mode_mismatch';
      if (resetGeneration <= configuration.resetGeneration) return 'generation_not_newer';
      const authority = this.database()
        .prepare(
          `SELECT revision, rollback_fence_revision AS rollbackFenceRevision
           FROM hosted_access_authority WHERE singleton = 1`
        )
        .get() as { readonly revision: number; readonly rollbackFenceRevision: number } | undefined;
      if (expectedAuthorityRevision === null) {
        if (authority !== undefined) return 'authority_conflict';
        const inserted = this.database()
          .prepare(
            `INSERT INTO hosted_access_authority
               (singleton, state_json, revision, rollback_fence_revision)
             VALUES (1, ?, 0, 0)`
          )
          .run(nextAuthorityStateJson);
        if (inserted.changes !== 1) throw new Error('hosted-auth-mode-reset-atomicity-failed');
      } else {
        if (
          authority?.revision !== expectedAuthorityRevision ||
          authority.rollbackFenceRevision !== expectedAuthorityRevision
        ) {
          return 'authority_conflict';
        }
        const updated = this.database()
          .prepare(
            `UPDATE hosted_access_authority
             SET state_json = ?, revision = ?, rollback_fence_revision = ?
             WHERE singleton = 1 AND revision = ? AND rollback_fence_revision = ?`
          )
          .run(
            nextAuthorityStateJson,
            nextAuthorityRevision,
            nextAuthorityRevision,
            expectedAuthorityRevision,
            expectedAuthorityRevision
          );
        if (updated.changes !== 1) throw new Error('hosted-auth-mode-reset-atomicity-failed');
      }
      const changed = this.database()
        .prepare(
          `UPDATE hosted_auth_configuration
           SET auth_mode = ?, configured_at = ?, reset_generation = ?,
               pending_personal_keyring_id = ?
           WHERE singleton = 1 AND auth_mode = ? AND reset_generation < ?`
        )
        .run(
          targetMode,
          resetAt,
          resetGeneration,
          pendingPersonalKeyringId,
          currentMode,
          resetGeneration
        );
      if (changed.changes !== 1) throw new Error('hosted-auth-mode-reset-atomicity-failed');
      this.database()
        .prepare(
          `UPDATE operator_sessions
           SET status = 'revoked', revoked_at = ?, revocation_reason = 'auth_mode_reset'
           WHERE status = 'active'`
        )
        .run(resetAt);
      this.database().prepare(`DELETE FROM oidc_login_attempts`).run();
      this.insertAuditEvent(event);
      return 'committed';
    })();
  }

  markSecretsRotated(payload: Record<string, unknown>): boolean {
    const mode = modeResetText(payload.mode, 'hosted-auth-mode-invalid');
    if (mode !== 'personal' && mode !== 'oidc') throw new TypeError('hosted-auth-mode-invalid');
    const resetGeneration = modeResetInteger(
      payload.resetGeneration,
      'hosted-auth-reset-generation-invalid'
    );
    const pendingPersonalKeyringId = modeResetText(
      payload.pendingPersonalKeyringId,
      'hosted-auth-pending-keyring-invalid',
      128
    );
    return (
      this.database()
        .prepare(
          `UPDATE hosted_auth_configuration
           SET secrets_rotated_generation = reset_generation,
               pending_personal_keyring_id = NULL
           WHERE singleton = 1 AND auth_mode = ? AND reset_generation = ?
             AND secrets_rotated_generation < reset_generation
             AND pending_personal_keyring_id = ?`
        )
        .run(mode, resetGeneration, pendingPersonalKeyringId).changes === 1
    );
  }

  private parseAuditEvent(value: unknown): ModeResetAuditEvent {
    const event = modeResetRecord(value, 'hosted-audit-event-invalid');
    const outcome = modeResetText(event.outcome, 'hosted-audit-outcome-invalid');
    if (outcome !== 'success' && outcome !== 'denied' && outcome !== 'failure') {
      throw new TypeError('hosted-audit-outcome-invalid');
    }
    return Object.freeze({
      eventId: modeResetText(event.eventId, 'hosted-audit-id-invalid'),
      occurredAt: modeResetInteger(event.occurredAt, 'hosted-audit-occurred-at-invalid'),
      userId: modeResetNullableText(event.userId, 'hosted-user-id-invalid'),
      sessionId: modeResetNullableText(event.sessionId, 'hosted-session-id-invalid'),
      action: modeResetText(event.action, 'hosted-audit-action-invalid', 256),
      outcome,
      sourceIpHash: modeResetNullableText(event.sourceIpHash, 'hosted-audit-source-ip-invalid'),
      detailsJson: modeResetText(event.detailsJson, 'hosted-audit-details-invalid', 65_536),
    });
  }

  private insertAuditEvent(event: ModeResetAuditEvent): void {
    this.database()
      .prepare(
        `INSERT INTO auth_audit_events
         (event_id, occurred_at, user_id, session_id, action, outcome, source_ip_hash, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.eventId,
        event.occurredAt,
        event.userId,
        event.sessionId,
        event.action,
        event.outcome,
        event.sourceIpHash,
        event.detailsJson
      );
  }
}

/**
 * Keeps workspace registration and per-principal grants in one SQLite
 * durability boundary. Grant reads always include the active restore
 * generation supplied by the hosted-access application service.
 */
export class HostedWorkspaceStorageOps {
  constructor(private readonly database: () => SqliteDatabase) {}

  isWorkspaceRegistered(payload: Record<string, unknown>): boolean {
    return Boolean(
      this.database()
        .prepare(
          `SELECT 1 FROM hosted_workspaces
           WHERE runtime_workspace_id = ? AND status = 'active'`
        )
        .get(modeResetText(payload.runtimeWorkspaceId, 'hosted-workspace-id-invalid', 1024))
    );
  }

  seedWorkspace(payload: Record<string, unknown>): null {
    this.database()
      .prepare(
        `INSERT INTO hosted_workspaces
         (runtime_workspace_id, public_workspace_id, display_name, status,
          registered_at, registered_by)
         VALUES (?, ?, ?, 'active', ?, NULL)
         ON CONFLICT(runtime_workspace_id) DO UPDATE SET display_name = excluded.display_name`
      )
      .run(
        modeResetText(payload.runtimeWorkspaceId, 'hosted-workspace-id-invalid', 1024),
        modeResetText(payload.workspaceId, 'hosted-public-workspace-id-invalid', 128),
        modeResetText(payload.displayName, 'hosted-workspace-name-invalid', 256),
        modeResetInteger(payload.registeredAt, 'hosted-workspace-created-at-invalid')
      );
    return null;
  }

  listWorkspaces(): unknown {
    return this.database()
      .prepare(
        `SELECT runtime_workspace_id AS runtimeWorkspaceId,
                public_workspace_id AS workspaceId, display_name AS displayName, status,
                registered_at AS registeredAt, registered_by AS registeredBy
         FROM hosted_workspaces ORDER BY registered_at, runtime_workspace_id`
      )
      .all();
  }

  registerWorkspace(payload: Record<string, unknown>): unknown {
    const registeredBy =
      payload.registeredBy === null
        ? null
        : modeResetText(payload.registeredBy, 'hosted-workspace-registered-by-invalid');
    const runtimeWorkspaceId = modeResetText(
      payload.runtimeWorkspaceId,
      'hosted-workspace-id-invalid',
      256
    );
    this.database()
      .prepare(
        `INSERT INTO hosted_workspaces
         (runtime_workspace_id, public_workspace_id, display_name, status,
          registered_at, registered_by)
         VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(runtime_workspace_id) DO UPDATE SET
           display_name = excluded.display_name,
           status = 'active',
           registered_at = excluded.registered_at,
           registered_by = excluded.registered_by`
      )
      .run(
        runtimeWorkspaceId,
        modeResetText(payload.workspaceId, 'hosted-public-workspace-id-invalid', 128),
        modeResetText(payload.displayName, 'hosted-workspace-name-invalid', 256),
        modeResetInteger(payload.registeredAt, 'hosted-workspace-created-at-invalid'),
        registeredBy
      );
    return this.database()
      .prepare(
        `SELECT runtime_workspace_id AS runtimeWorkspaceId,
                public_workspace_id AS workspaceId, display_name AS displayName, status,
                registered_at AS registeredAt, registered_by AS registeredBy
         FROM hosted_workspaces WHERE runtime_workspace_id = ?`
      )
      .get(runtimeWorkspaceId);
  }

  disableWorkspace(payload: Record<string, unknown>): boolean {
    const runtimeWorkspaceId = modeResetText(
      payload.runtimeWorkspaceId,
      'hosted-workspace-id-invalid',
      256
    );
    return this.database().transaction(() => {
      const changed = this.database()
        .prepare(
          `UPDATE hosted_workspaces SET status = 'disabled'
           WHERE runtime_workspace_id = ? AND status = 'active'`
        )
        .run(runtimeWorkspaceId).changes;
      if (changed !== 1) return false;
      this.database()
        .prepare(`DELETE FROM hosted_workspace_grants WHERE runtime_workspace_id = ?`)
        .run(runtimeWorkspaceId);
      return true;
    })();
  }

  listWorkspaceGrants(payload: Record<string, unknown>): unknown {
    return this.database()
      .prepare(
        `SELECT grants.user_id AS userId,
                workspaces.public_workspace_id AS workspaceId,
                grants.runtime_workspace_id AS runtimeWorkspaceId,
                workspaces.display_name AS displayName,
                grants.grant_generation AS grantGeneration,
                grants.grant_revision AS grantRevision,
                grants.granted_at AS grantedAt,
                grants.granted_by AS grantedBy
         FROM hosted_workspace_grants AS grants
         INNER JOIN hosted_workspaces AS workspaces
           ON workspaces.runtime_workspace_id = grants.runtime_workspace_id
         INNER JOIN users ON users.user_id = grants.user_id
         WHERE grants.user_id = ?
           AND grants.grant_generation = ?
           AND workspaces.status = 'active'
           AND users.status = 'active'
         ORDER BY grants.granted_at, grants.runtime_workspace_id`
      )
      .all(
        modeResetText(payload.userId, 'hosted-user-id-invalid'),
        modeResetInteger(payload.grantGeneration, 'hosted-workspace-grant-generation-invalid')
      );
  }

  setWorkspaceGrant(payload: Record<string, unknown>): unknown {
    const userId = modeResetText(payload.userId, 'hosted-user-id-invalid');
    const runtimeWorkspaceId = modeResetText(
      payload.runtimeWorkspaceId,
      'hosted-workspace-id-invalid',
      256
    );
    const grantGeneration = modeResetInteger(
      payload.grantGeneration,
      'hosted-workspace-grant-generation-invalid'
    );
    const grantedAt = modeResetInteger(payload.grantedAt, 'hosted-workspace-granted-at-invalid');
    const grantedBy = modeResetText(payload.grantedBy, 'hosted-workspace-granted-by-invalid');
    if (grantedBy !== 'local-cli') {
      throw new TypeError('hosted-workspace-granted-by-invalid');
    }
    return this.database().transaction(() => {
      const changed = this.database()
        .prepare(
          `INSERT INTO hosted_workspace_grants
             (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by)
           SELECT ?, runtime_workspace_id, ?, lower(hex(randomblob(32))), ?, ?
           FROM hosted_workspaces
           WHERE runtime_workspace_id = ? AND status = 'active'
           ON CONFLICT(user_id, runtime_workspace_id) DO UPDATE SET
             grant_generation = excluded.grant_generation,
             grant_revision = excluded.grant_revision,
             granted_at = excluded.granted_at,
             granted_by = excluded.granted_by`
        )
        .run(userId, grantGeneration, grantedAt, grantedBy, runtimeWorkspaceId).changes;
      if (changed !== 1) throw new Error('hosted-workspace-not-registered');
      return this.database()
        .prepare(
          `SELECT grants.user_id AS userId,
                  workspaces.public_workspace_id AS workspaceId,
                  grants.runtime_workspace_id AS runtimeWorkspaceId,
                  workspaces.display_name AS displayName,
                  grants.grant_generation AS grantGeneration,
                  grants.grant_revision AS grantRevision,
                  grants.granted_at AS grantedAt,
                  grants.granted_by AS grantedBy
           FROM hosted_workspace_grants AS grants
           INNER JOIN hosted_workspaces AS workspaces
             ON workspaces.runtime_workspace_id = grants.runtime_workspace_id
           WHERE grants.user_id = ? AND grants.runtime_workspace_id = ?`
        )
        .get(userId, runtimeWorkspaceId);
    })();
  }

  revokeWorkspaceGrant(payload: Record<string, unknown>): boolean {
    return (
      this.database()
        .prepare(
          `DELETE FROM hosted_workspace_grants
           WHERE user_id = ? AND runtime_workspace_id = ?`
        )
        .run(
          modeResetText(payload.userId, 'hosted-user-id-invalid'),
          modeResetText(payload.runtimeWorkspaceId, 'hosted-workspace-id-invalid', 256)
        ).changes === 1
    );
  }
}
