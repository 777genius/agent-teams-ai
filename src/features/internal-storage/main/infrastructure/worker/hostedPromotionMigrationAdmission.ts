import { HOSTED_PROMOTION_STORAGE_MIGRATION } from './hostedPromotionStorageMigration';

import type { TeamIdentityStorageSchemaDefinition } from './teamIdentityStorageSchema';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
const TABLE = 'hosted_team_configuration_promotions';
const ERROR = 'internal-storage-v30-promotion-schema-incompatible';
const DEPENDENCIES = [
  TABLE,
  'hosted_team_configuration_drafts',
  'hosted_team_configuration_create_keys',
  'hosted_team_configuration_publications',
];

const DEFINITIONS: readonly TeamIdentityStorageSchemaDefinition[] = [
  ...HOSTED_PROMOTION_STORAGE_MIGRATION.statements.map((sql) => {
    const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql);
    if (!match?.[2]) throw new Error(ERROR);
    const type = match[1] === 'TABLE' ? 'table' as const : 'trigger' as const;
    const tableName = type === 'table' ? match[2] : / ON ([a-z_]+)\n/u.exec(sql)?.[1];
    if (!tableName) throw new Error(ERROR);
    return { type, name: match[2], tableName, sql };
  }),
  ...[1, 2, 3].map((index) => ({
    type: 'index' as const,
    name: `sqlite_autoindex_${TABLE}_${index}`,
    tableName: TABLE,
    sql: null,
  })),
];

function fold(name: string): string {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isPromotion(object: TeamIdentityStorageSchemaDefinition): boolean {
  const name = fold(object.name);
  return fold(object.tableName) === TABLE || name.startsWith('hosted_promotions_') ||
    name.startsWith(TABLE) || name.startsWith(`sqlite_autoindex_${TABLE}`);
}

/** Admit an absent component or the exact complete retained v30 component.
 * Only validated object names may be excluded from the v29 schema projection.
 * Never execute repair SQL, discard unknown objects, or trust the version marker.
 */
export function readRetainedPromotionObjects(
  db: SqliteDatabase, error = ERROR
): readonly TeamIdentityStorageSchemaDefinition[] {
  const read = (schema: 'main' | 'temp') => db.prepare(
    `SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema`
  ).all() as TeamIdentityStorageSchemaDefinition[];
  if (read('temp').some((object) => isPromotion(object) ||
    DEPENDENCIES.includes(fold(object.name)) || DEPENDENCIES.includes(fold(object.tableName)))) {
    throw new Error(error);
  }
  const objects = read('main').filter(isPromotion);
  if (objects.length === 0) return objects;
  if (objects.length !== DEFINITIONS.length || !DEFINITIONS.every((expected) => {
    const found = objects.filter((object) => object.name === expected.name);
    return found.length === 1 && found[0]?.type === expected.type &&
      found[0]?.tableName === expected.tableName && found[0]?.sql === expected.sql;
  })) throw new Error(error);
  assertRetainedStorageIntegrity(db, error);
  return objects;
}

/** Inspect the whole main/TEMP constraint graph, not just the new journal. */
function assertRetainedStorageIntegrity(db: SqliteDatabase, error = ERROR): void {
  if (db.pragma('ignore_check_constraints', { simple: true }) !== 0) throw new Error(error);
  for (const schema of ['main', 'temp']) {
    if ((db.pragma(`${schema}.foreign_key_check`) as unknown[]).length !== 0) throw new Error(error);
    const integrity = db.pragma(`${schema}.integrity_check`) as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error(error);
  }
}

/** The runner validates the v29 identity/publication graph first, inside its fence. */
export function runHostedPromotionMigrationAdmission(db: SqliteDatabase): void {
  if (readRetainedPromotionObjects(db).length !== 0) return;
  assertRetainedStorageIntegrity(db);
  for (const statement of HOSTED_PROMOTION_STORAGE_MIGRATION.statements) db.exec(statement);
}
