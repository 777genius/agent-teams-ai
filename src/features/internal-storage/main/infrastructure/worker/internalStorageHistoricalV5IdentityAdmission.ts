import {
  TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS,
  TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS,
} from './teamIdentityStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

/** Admit the independently released v5 identity component before hosted migrations. */
export function admitHistoricV5IdentitySchema(db: SqliteDatabase): void {
  const error = 'internal-storage-v31-team-identity-schema-incompatible';
  const tables = [
    ...new Set(TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.map(({ tableName }) => tableName)),
  ];
  const placeholders = tables.map(() => '?').join(', ');
  const read = (schema: 'main' | 'temp') =>
    db
      .prepare(
        `SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema
      WHERE tbl_name IN (${placeholders})`
      )
      .all(...tables) as typeof TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS;
  if (read('temp').length !== 0) throw new Error(error);
  let objects = read('main');
  if (objects.length === 0) {
    for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) db.exec(statement);
    objects = read('main');
  }
  if (
    objects.length !== TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.length ||
    !TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.every((expected) =>
      objects.some(
        (object) =>
          object.type === expected.type &&
          object.name === expected.name &&
          object.tableName === expected.tableName &&
          object.sql === expected.sql
      )
    )
  )
    throw new Error(error);
  const metadata = db
    .prepare('SELECT component, schema_version FROM main.team_identity_storage_metadata')
    .all() as { component: unknown; schema_version: unknown }[];
  if (
    metadata.length !== 1 ||
    metadata[0]?.component !== 'team-identity' ||
    metadata[0]?.schema_version !== 1
  )
    throw new Error(error);
  if ((db.pragma('main.foreign_key_check') as unknown[]).length !== 0) throw new Error(error);
}
