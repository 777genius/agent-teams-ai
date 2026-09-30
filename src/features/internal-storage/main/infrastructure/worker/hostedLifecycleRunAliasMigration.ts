import type DatabaseConstructor from 'better-sqlite3';

/** v34 retains retry identities without changing the immutable v33 canonical run. */
export const HOSTED_LIFECYCLE_RUN_ALIAS_MIGRATION = {
  version: 34,
  statements: [
    `CREATE TABLE hosted_lifecycle_run_aliases (
      command_id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      UNIQUE (deployment_id, actor_id, idempotency_key),
      FOREIGN KEY (run_id) REFERENCES hosted_lifecycle_run_reservations(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE TRIGGER hosted_run_aliases_no_replace BEFORE INSERT ON hosted_lifecycle_run_aliases
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_run_aliases a
        WHERE a.rowid = NEW.rowid OR a.command_id = NEW.command_id
          OR (a.deployment_id = NEW.deployment_id AND a.actor_id = NEW.actor_id
            AND a.idempotency_key = NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT, 'hosted run alias is immutable'); END`,
    `CREATE TRIGGER hosted_run_aliases_no_update BEFORE UPDATE ON hosted_lifecycle_run_aliases
      BEGIN SELECT RAISE(ABORT, 'hosted run alias is immutable'); END`,
    `CREATE TRIGGER hosted_run_aliases_no_delete BEFORE DELETE ON hosted_lifecycle_run_aliases
      BEGIN SELECT RAISE(ABORT, 'hosted run alias is retained'); END`,
  ],
} as const;

type Database = InstanceType<typeof DatabaseConstructor>;
const TABLE = 'hosted_lifecycle_run_aliases';
const ERROR = 'internal-storage-v34-run-alias-schema-incompatible';

export function runHostedLifecycleRunAliasMigrationAdmission(
  db: Database,
  requireExisting = false
): void {
  const read = (schema: 'main' | 'temp') =>
    (
      db
        .prepare(`SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema`)
        .all() as { type: string; name: string; tableName: string; sql: string | null }[]
    ).filter(
      ({ name, tableName }) =>
        tableName.toLowerCase() === TABLE ||
        name.toLowerCase().startsWith('hosted_run_aliases_') ||
        name.toLowerCase().startsWith(`sqlite_autoindex_${TABLE}_`)
    );
  if (read('temp').length !== 0) throw new Error(ERROR);
  const objects = read('main');
  if (objects.length === 0) {
    if (requireExisting) throw new Error(ERROR);
    for (const statement of HOSTED_LIFECYCLE_RUN_ALIAS_MIGRATION.statements) db.exec(statement);
    return;
  }
  const expected: { type: string; name: string; tableName: string; sql: string | null }[] =
    HOSTED_LIFECYCLE_RUN_ALIAS_MIGRATION.statements.map((sql) => {
      const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql);
      if (!match) throw new Error(ERROR);
      return {
        type: match[1].toLowerCase(),
        name: match[2],
        tableName: match[1] === 'TABLE' ? match[2] : TABLE,
        sql,
      };
    });
  for (let index = 1; index <= 2; index += 1) {
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
  )
    throw new Error(ERROR);
  if (
    (db.pragma('main.foreign_key_check') as unknown[]).length !== 0 ||
    (db.pragma('main.integrity_check') as { integrity_check: string }[])[0]?.integrity_check !==
      'ok'
  )
    throw new Error(ERROR);
}
