import { normalizeMemberWorkSyncTeamKey } from '../../../contracts/memberWorkSyncTeamIdentity';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

const MEMBER_WORK_SYNC_TEAM_KEY_TABLES = [
  'member_work_sync_status',
  'member_work_sync_report_intents',
  'member_work_sync_outbox',
  'member_work_sync_metric_events',
] as const;
/** Runs inside the v9 migration transaction and deliberately uses the shared JS contract. */
export function backfillMemberWorkSyncTeamKeys(db: SqliteDatabase): void {
  for (const tableName of MEMBER_WORK_SYNC_TEAM_KEY_TABLES) {
    const rows = db.prepare(`SELECT rowid, team_name FROM ${tableName}`).all() as {
      readonly rowid: number;
      readonly team_name: string;
    }[];
    const update = db.prepare(`UPDATE ${tableName} SET team_key = ? WHERE rowid = ?`);
    for (const row of rows) {
      update.run(normalizeMemberWorkSyncTeamKey(row.team_name), row.rowid);
    }
  }
}
export function ensureMemberWorkSyncTeamKeyIndexes(db: SqliteDatabase): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_status_team_key
    ON member_work_sync_status (team_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_report_intents_team_key
    ON member_work_sync_report_intents (team_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_outbox_team_key
    ON member_work_sync_outbox (team_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mws_metric_events_team_key
    ON member_work_sync_metric_events (team_key)`);
}

export function ensureCommandCoordinationAttribution(db: SqliteDatabase): void {
  const columns = db.pragma('table_info(durable_application_commands)') as {
    readonly name: string;
  }[];
  if (!columns.some((column) => column.name === 'coordination_attribution_json')) {
    db.exec(
      `ALTER TABLE durable_application_commands
       ADD COLUMN coordination_attribution_json TEXT NOT NULL
       DEFAULT '{"actor":{"actorRef":"legacy-command:unknown","kind":"recovery"},"provenance":"legacy_recovery_v1"}'
       CHECK (json_valid(coordination_attribution_json))`
    );
  }
  db.exec(
    `UPDATE durable_application_commands
     SET coordination_attribution_json = json_object(
       'actor', json_object(
         'actorRef', 'legacy-command:' || stable_actor_id,
         'kind', 'recovery'
       ),
       'provenance', 'legacy_recovery_v1'
     )
     WHERE json_extract(coordination_attribution_json, '$.provenance') = 'legacy_recovery_v1'`
  );
}

interface LegacyOutboxEventRow {
  readonly deployment_id: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly command_id: string;
  readonly event_type: string;
  readonly scope_kind: string;
  readonly scope_id: string;
  readonly schema_version: number;
  readonly payload_json: string;
  readonly created_at: string;
  readonly coordination_attribution_json: string;
}

const LEGACY_EVENT_SCOPE_KINDS = new Set([
  'instance',
  'catalog',
  'workspace',
  'team',
  'run',
  'session',
]);

/** Imports the v6/v7 outbox into the one journal using runtime-identical canonical JSON. */
export function backfillCoordinationEventJournal(db: SqliteDatabase): void {
  const mismatchedCommand = db
    .prepare(
      `SELECT outbox.command_id
       FROM durable_application_command_outbox AS outbox
       JOIN durable_application_commands AS commands ON commands.command_id = outbox.command_id
       WHERE commands.deployment_id <> outbox.deployment_id
       LIMIT 1`
    )
    .get() as { readonly command_id: string } | undefined;
  if (mismatchedCommand) throw new Error('internal-storage-command-outbox-deployment-mismatch');

  const rows = db
    .prepare(
      `SELECT
         outbox.deployment_id,
         outbox.sequence,
         outbox.event_id,
         outbox.command_id,
         outbox.event_type,
         outbox.scope_kind,
         outbox.scope_id,
         outbox.schema_version,
         outbox.payload_json,
         outbox.created_at,
         commands.coordination_attribution_json
       FROM durable_application_command_outbox AS outbox
       JOIN durable_application_commands AS commands ON commands.command_id = outbox.command_id
       ORDER BY outbox.deployment_id ASC, outbox.sequence ASC, outbox.event_id ASC`
    )
    .all() as LegacyOutboxEventRow[];

  const deployments = db
    .prepare(
      `SELECT
         deployment_id,
         COUNT(*) AS event_count,
         MIN(created_at) AS created_at,
         MAX(created_at) AS updated_at
       FROM durable_application_command_outbox
       GROUP BY deployment_id
       ORDER BY deployment_id ASC`
    )
    .all() as {
    readonly deployment_id: string;
    readonly event_count: number;
    readonly created_at: string;
    readonly updated_at: string;
  }[];
  for (const deployment of deployments) {
    const result = db
      .prepare(
        `INSERT INTO coordination_event_journal_metadata (
           deployment_id, event_epoch, retention_floor_sequence,
           high_watermark_sequence, created_at, updated_at
         ) VALUES (?, 'epoch-initial-v1', 0, ?, ?, ?)
         ON CONFLICT(deployment_id) DO NOTHING`
      )
      .run(
        deployment.deployment_id,
        deployment.event_count,
        deployment.created_at,
        deployment.updated_at
      );
    if (result.changes === 0) {
      const existing = db
        .prepare(
          `SELECT event_epoch, retention_floor_sequence, high_watermark_sequence
           FROM coordination_event_journal_metadata WHERE deployment_id = ?`
        )
        .get(deployment.deployment_id) as {
        readonly event_epoch: string;
        readonly retention_floor_sequence: number;
        readonly high_watermark_sequence: number;
      };
      if (
        existing.event_epoch !== 'epoch-initial-v1' ||
        existing.retention_floor_sequence !== 0 ||
        existing.high_watermark_sequence !== deployment.event_count
      ) {
        throw new Error('internal-storage-event-journal-metadata-backfill-conflict');
      }
    }
  }

  let deploymentId: string | null = null;
  let eventSequence = 0;
  for (const row of rows) {
    if (row.deployment_id !== deploymentId) {
      deploymentId = row.deployment_id;
      eventSequence = 0;
    }
    eventSequence += 1;
    const bodyJson = legacyOutboxEventBodyJson(row);
    const existing = db
      .prepare(
        `SELECT deployment_id, event_epoch, event_sequence, body_json
         FROM coordination_event_journal
         WHERE event_id = ?`
      )
      .get(row.event_id) as
      | {
          readonly deployment_id: string;
          readonly event_epoch: string;
          readonly event_sequence: number;
          readonly body_json: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.deployment_id !== row.deployment_id ||
        existing.event_epoch !== 'epoch-initial-v1' ||
        existing.event_sequence !== eventSequence ||
        existing.body_json !== bodyJson
      ) {
        throw new Error('internal-storage-event-journal-backfill-conflict');
      }
      continue;
    }
    db.prepare(
      `INSERT INTO coordination_event_journal (
         deployment_id, event_epoch, event_sequence, event_id, body_json,
         emitted_at, origin_command_id, created_at
       ) VALUES (?, 'epoch-initial-v1', ?, ?, ?, ?, ?, ?)`
    ).run(
      row.deployment_id,
      eventSequence,
      row.event_id,
      bodyJson,
      row.created_at,
      row.command_id,
      row.created_at
    );
  }
}

function legacyOutboxEventBodyJson(row: LegacyOutboxEventRow): string {
  if (row.schema_version !== 1 || !LEGACY_EVENT_SCOPE_KINDS.has(row.scope_kind)) {
    throw new Error('internal-storage-legacy-outbox-event-contract-invalid');
  }
  const attribution = parseMigrationJsonObject(row.coordination_attribution_json);
  const actor = attribution.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw new Error('internal-storage-legacy-outbox-attribution-invalid');
  }
  const runId = row.scope_kind === 'run' ? row.scope_id : attribution.runId;
  if (runId !== undefined && typeof runId !== 'string') {
    throw new Error('internal-storage-legacy-outbox-run-id-invalid');
  }
  return canonicalMigrationJson({
    actor,
    eventId: row.event_id,
    emittedAt: row.created_at,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as unknown,
    ...(runId === undefined ? {} : { runId }),
    schemaVersion: row.schema_version,
    scope: { kind: row.scope_kind, scopeId: row.scope_id },
    ...(row.scope_kind === 'team' ? { teamId: row.scope_id } : {}),
    ...(row.scope_kind === 'workspace' ? { workspaceId: row.scope_id } : {}),
  });
}

function parseMigrationJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('internal-storage-migration-json-object-invalid');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function canonicalMigrationJson(value: unknown): string {
  return JSON.stringify(normalizeMigrationJson(value));
}

function normalizeMigrationJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('internal-storage-migration-json-number-invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeMigrationJson);
  if (typeof value !== 'object') throw new Error('internal-storage-migration-json-value-invalid');
  const record = value as Readonly<Record<string, unknown>>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    if (record[key] !== undefined) normalized[key] = normalizeMigrationJson(record[key]);
  }
  return normalized;
}
