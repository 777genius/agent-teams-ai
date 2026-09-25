import type DatabaseConstructor from 'better-sqlite3';

/** Append-only v33. No historical run is inferred from a frozen promotion. */
export const HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION = {
  version: 33,
  statements: [
    `CREATE TABLE hosted_lifecycle_run_reservations (
      run_id TEXT PRIMARY KEY CHECK (length(run_id) = 36 AND substr(run_id, 1, 4) = 'run_'
        AND substr(run_id, 5) NOT GLOB '*[^0-9a-f]*'),
      deployment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      expected_revision TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      promotion_operation_id TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK (json_valid(record_json)
        AND length(CAST(record_json AS BLOB)) <= 16384),
      UNIQUE (deployment_id, actor_id, idempotency_key),
      UNIQUE (deployment_id, boot_id, team_id, expected_revision),
      FOREIGN KEY (promotion_operation_id)
        REFERENCES hosted_team_configuration_promotions(operation_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE TRIGGER hosted_run_reservations_no_replace BEFORE INSERT ON hosted_lifecycle_run_reservations
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_run_reservations r
        WHERE r.rowid = NEW.rowid OR r.run_id = NEW.run_id OR r.command_id = NEW.command_id
          OR (r.deployment_id = NEW.deployment_id AND r.actor_id = NEW.actor_id
            AND r.idempotency_key = NEW.idempotency_key)
          OR (r.deployment_id = NEW.deployment_id AND r.boot_id = NEW.boot_id
            AND r.team_id = NEW.team_id AND r.expected_revision = NEW.expected_revision))
      BEGIN SELECT RAISE(ABORT, 'hosted run reservation is immutable'); END`,
    `CREATE TRIGGER hosted_run_reservations_no_update BEFORE UPDATE ON hosted_lifecycle_run_reservations
      BEGIN SELECT RAISE(ABORT, 'hosted run reservation is immutable'); END`,
    `CREATE TRIGGER hosted_run_reservations_no_delete BEFORE DELETE ON hosted_lifecycle_run_reservations
      BEGIN SELECT RAISE(ABORT, 'hosted run reservation is retained'); END`,
  ],
} as const;

type Database = InstanceType<typeof DatabaseConstructor>;
const TABLE = 'hosted_lifecycle_run_reservations';
const ERROR = 'internal-storage-v33-run-reservation-schema-incompatible';

/** Refuse a restored marker if any reservation table or trigger differs from v33. */
export function runHostedLifecycleRunReservationMigrationAdmission(
  db: Database,
  requireExisting = false
): void {
  const fold = (name: string) => name.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const read = (schema: 'main' | 'temp') =>
    (
      db
        .prepare(`SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema`)
        .all() as { type: string; name: string; tableName: string; sql: string | null }[]
    ).filter(
      ({ name, tableName }) =>
        fold(tableName) === TABLE ||
        fold(name).startsWith('hosted_run_reservations_') ||
        fold(name).startsWith(`sqlite_autoindex_${TABLE}`)
    );
  if (read('temp').length !== 0) throw new Error(ERROR);
  const objects = read('main');
  if (objects.length === 0) {
    if (requireExisting) throw new Error(ERROR);
    for (const statement of HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION.statements)
      db.exec(statement);
    return;
  }
  const expected: { type: string; name: string; tableName: string; sql: string | null }[] =
    HOSTED_LIFECYCLE_RUN_RESERVATION_MIGRATION.statements.map((sql) => {
      const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql);
      if (!match) throw new Error(ERROR);
      return {
        type: match[1].toLowerCase(),
        name: match[2],
        tableName: match[1] === 'TABLE' ? match[2] : TABLE,
        sql,
      };
    });
  for (let index = 1; index <= 4; index += 1) {
    expected.push({
      type: 'index',
      name: `sqlite_autoindex_${TABLE}_${index}`,
      tableName: TABLE,
      sql: null,
    });
  }
  if (
    objects.length !== expected.length ||
    expected.some(
      (definition) =>
        !objects.some(
          (object) =>
            object.type === definition.type &&
            object.name === definition.name &&
            object.tableName === definition.tableName &&
            object.sql === definition.sql
        )
    )
  ) {
    throw new Error(ERROR);
  }
  if (
    (db.pragma('main.foreign_key_check') as unknown[]).length !== 0 ||
    (db.pragma('main.integrity_check') as { integrity_check: string }[])[0]?.integrity_check !==
      'ok'
  ) {
    throw new Error(ERROR);
  }
}
