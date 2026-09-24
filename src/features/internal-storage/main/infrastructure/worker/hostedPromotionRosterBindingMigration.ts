import type DatabaseConstructor from 'better-sqlite3';

/** Append-only v32. Historic promotions are intentionally left without bindings. */
export const HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION = {
  version: 32,
  statements: [
    `CREATE TABLE hosted_promotion_roster_bindings (
      operation_id TEXT PRIMARY KEY,
      plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json) AND length(CAST(binding_json AS BLOB)) <= 262144),
      FOREIGN KEY (operation_id) REFERENCES hosted_team_configuration_promotions(operation_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE TRIGGER hosted_roster_bindings_no_replace BEFORE INSERT ON hosted_promotion_roster_bindings
      WHEN EXISTS (SELECT 1 FROM hosted_promotion_roster_bindings b
        WHERE b.rowid = NEW.rowid OR b.operation_id = NEW.operation_id)
      BEGIN SELECT RAISE(ABORT, 'promotion roster binding is immutable'); END`,
    `CREATE TRIGGER hosted_roster_bindings_no_update BEFORE UPDATE ON hosted_promotion_roster_bindings
      BEGIN SELECT RAISE(ABORT, 'promotion roster binding is immutable'); END`,
    `CREATE TRIGGER hosted_roster_bindings_no_delete BEFORE DELETE ON hosted_promotion_roster_bindings
      BEGIN SELECT RAISE(ABORT, 'promotion roster binding is retained'); END`,
  ],
} as const;

type Database = InstanceType<typeof DatabaseConstructor>;
const TABLE = 'hosted_promotion_roster_bindings';
const ERROR = 'internal-storage-v32-roster-binding-schema-incompatible';

/** Admit exact retained v32 objects after a restored marker; never backfill old rows. */
export function runHostedPromotionRosterBindingMigrationAdmission(
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
        fold(name).startsWith('hosted_roster_bindings_') ||
        fold(name).startsWith(`sqlite_autoindex_${TABLE}`)
    );
  if (read('temp').length !== 0) throw new Error(ERROR);
  const objects = read('main');
  if (objects.length === 0) {
    if (requireExisting) throw new Error(ERROR);
    for (const statement of HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION.statements)
      db.exec(statement);
    return;
  }
  const expected: { type: string; name: string; tableName: string; sql: string | null }[] =
    HOSTED_PROMOTION_ROSTER_BINDING_MIGRATION.statements.map((sql) => {
      const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql);
      if (!match) throw new Error(ERROR);
      return {
        type: match[1]!.toLowerCase(),
        name: match[2]!,
        tableName: match[1] === 'TABLE' ? match[2]! : TABLE,
        sql,
      };
    });
  expected.push({
    type: 'index',
    name: `sqlite_autoindex_${TABLE}_1`,
    tableName: TABLE,
    sql: null,
  });
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
