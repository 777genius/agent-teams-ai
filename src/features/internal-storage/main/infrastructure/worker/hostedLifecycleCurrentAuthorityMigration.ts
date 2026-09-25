import type DatabaseConstructor from 'better-sqlite3';

/** v35: Product's current authority is explicit; historical v33 runs remain denied. */
export const HOSTED_LIFECYCLE_CURRENT_AUTHORITY_MIGRATION = {
  version: 35,
  statements: [
    `CREATE TABLE hosted_lifecycle_deployment_authorities (
      deployment_id TEXT PRIMARY KEY,
      boot_id TEXT NOT NULL,
      owner_authority TEXT NOT NULL,
      owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
      owner_session_id TEXT NOT NULL,
      restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
      mount_generation INTEGER NOT NULL CHECK (mount_generation > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'retired'))
    )`,
    `CREATE TRIGGER hosted_lifecycle_authorities_no_replace BEFORE INSERT ON hosted_lifecycle_deployment_authorities
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_deployment_authorities a
        WHERE a.rowid = NEW.rowid OR a.deployment_id = NEW.deployment_id)
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle authority is retained'); END`,
    `CREATE TRIGGER hosted_lifecycle_authorities_no_delete BEFORE DELETE ON hosted_lifecycle_deployment_authorities
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle authority is retained'); END`,
    `CREATE TRIGGER hosted_lifecycle_authorities_guard_update BEFORE UPDATE ON hosted_lifecycle_deployment_authorities
      WHEN NEW.deployment_id != OLD.deployment_id OR NEW.revision != OLD.revision + 1
        OR NEW.owner_generation < OLD.owner_generation
        OR NEW.owner_authority != OLD.owner_authority
        OR (NEW.owner_generation = OLD.owner_generation AND
          (NEW.boot_id != OLD.boot_id OR NEW.owner_authority != OLD.owner_authority OR
           NEW.owner_session_id != OLD.owner_session_id OR
           NEW.restore_generation != OLD.restore_generation OR
           NEW.mount_generation != OLD.mount_generation))
        OR (OLD.state = 'retired' AND NEW.owner_generation = OLD.owner_generation)
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle authority transition invalid'); END`,
    `CREATE TABLE hosted_lifecycle_current_runs (
      run_id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      owner_authority TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      owner_session_id TEXT NOT NULL,
      restore_generation INTEGER NOT NULL,
      mount_generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('eligible', 'cleanup_pending', 'retired')),
      FOREIGN KEY (run_id) REFERENCES hosted_lifecycle_run_reservations(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE UNIQUE INDEX hosted_lifecycle_one_unretired_run_per_team
      ON hosted_lifecycle_current_runs (deployment_id, team_id) WHERE state != 'retired'`,
    `CREATE TRIGGER hosted_lifecycle_current_runs_no_replace BEFORE INSERT ON hosted_lifecycle_current_runs
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_current_runs r
        WHERE r.rowid = NEW.rowid OR r.run_id = NEW.run_id OR
          (r.deployment_id = NEW.deployment_id AND r.team_id = NEW.team_id AND r.state != 'retired'))
        OR NOT EXISTS (SELECT 1 FROM hosted_lifecycle_deployment_authorities a
          WHERE a.deployment_id = NEW.deployment_id AND a.boot_id = NEW.boot_id
            AND a.owner_authority = NEW.owner_authority AND a.owner_generation = NEW.owner_generation
            AND a.owner_session_id = NEW.owner_session_id
            AND a.restore_generation = NEW.restore_generation
            AND a.mount_generation = NEW.mount_generation AND a.state = 'active')
        OR NOT EXISTS (SELECT 1 FROM hosted_lifecycle_run_reservations r
          WHERE r.run_id = NEW.run_id AND r.deployment_id = NEW.deployment_id
            AND r.boot_id = NEW.boot_id AND r.team_id = NEW.team_id)
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle current run binding invalid'); END`,
    `CREATE TRIGGER hosted_lifecycle_current_runs_guard_update BEFORE UPDATE ON hosted_lifecycle_current_runs
      WHEN NOT ((OLD.state = 'eligible' AND NEW.state = 'cleanup_pending')
        OR (OLD.state = 'cleanup_pending' AND NEW.state = 'retired'))
        OR NEW.run_id != OLD.run_id
        OR NEW.deployment_id != OLD.deployment_id OR NEW.boot_id != OLD.boot_id
        OR NEW.team_id != OLD.team_id OR NEW.owner_authority != OLD.owner_authority
        OR NEW.owner_generation != OLD.owner_generation OR NEW.owner_session_id != OLD.owner_session_id
        OR NEW.restore_generation != OLD.restore_generation OR NEW.mount_generation != OLD.mount_generation
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle run transition invalid'); END`,
    `CREATE TRIGGER hosted_lifecycle_current_runs_no_delete BEFORE DELETE ON hosted_lifecycle_current_runs
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle run is retained'); END`,
    `CREATE TABLE hosted_lifecycle_retired_members (
      run_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      PRIMARY KEY (run_id, member_id),
      FOREIGN KEY (run_id) REFERENCES hosted_lifecycle_current_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE TRIGGER hosted_lifecycle_retired_members_no_replace BEFORE INSERT ON hosted_lifecycle_retired_members
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_retired_members m
        WHERE m.rowid = NEW.rowid OR (m.run_id = NEW.run_id AND m.member_id = NEW.member_id))
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle member retirement is immutable'); END`,
    `CREATE TRIGGER hosted_lifecycle_retired_members_no_update BEFORE UPDATE ON hosted_lifecycle_retired_members
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle member retirement is immutable'); END`,
    `CREATE TRIGGER hosted_lifecycle_retired_members_no_delete BEFORE DELETE ON hosted_lifecycle_retired_members
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle member retirement is retained'); END`,
  ],
} as const;

type Database = InstanceType<typeof DatabaseConstructor>;
const TABLES = [
  'hosted_lifecycle_deployment_authorities',
  'hosted_lifecycle_current_runs',
  'hosted_lifecycle_retired_members',
] as const;
const ERROR = 'internal-storage-v35-current-lifecycle-schema-incompatible';

export function runHostedLifecycleCurrentAuthorityMigrationAdmission(
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
        TABLES.includes(tableName.toLowerCase() as (typeof TABLES)[number]) ||
        name.toLowerCase().startsWith('hosted_lifecycle_authorities_') ||
        name.toLowerCase().startsWith('hosted_lifecycle_current_runs_') ||
        name.toLowerCase().startsWith('hosted_lifecycle_retired_members_') ||
        name.toLowerCase() === 'hosted_lifecycle_one_unretired_run_per_team' ||
        TABLES.some((table) => name.toLowerCase().startsWith(`sqlite_autoindex_${table}_`))
    );
  if (read('temp').length !== 0) throw new Error(ERROR);
  const objects = read('main');
  if (objects.length === 0) {
    if (requireExisting) throw new Error(ERROR);
    for (const statement of HOSTED_LIFECYCLE_CURRENT_AUTHORITY_MIGRATION.statements)
      db.exec(statement);
    return;
  }
  const expected: { type: string; name: string; tableName: string; sql: string | null }[] =
    HOSTED_LIFECYCLE_CURRENT_AUTHORITY_MIGRATION.statements.map((sql) => {
      const match = /^CREATE (TABLE|TRIGGER|UNIQUE INDEX) ([a-z_]+)/u.exec(sql);
      if (!match) throw new Error(ERROR);
      const type = match[1] === 'UNIQUE INDEX' ? 'index' : match[1].toLowerCase();
      const tableName = type === 'table' ? match[2] : / ON ([a-z_]+)/u.exec(sql)?.[1];
      if (!tableName) throw new Error(ERROR);
      return { type, name: match[2], tableName, sql };
    });
  for (const table of TABLES)
    expected.push({
      type: 'index',
      name: `sqlite_autoindex_${table}_1`,
      tableName: table,
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
  )
    throw new Error(ERROR);
  if (
    (db.pragma('main.foreign_key_check') as unknown[]).length !== 0 ||
    (db.pragma('main.integrity_check') as { integrity_check: string }[])[0]?.integrity_check !==
      'ok'
  )
    throw new Error(ERROR);
}
