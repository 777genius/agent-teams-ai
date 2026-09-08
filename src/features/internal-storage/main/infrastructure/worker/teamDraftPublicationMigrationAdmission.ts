import {
  RESERVED_TEAM_IDENTITY_TRANSITION,
  TEAM_DRAFT_PUBLICATION_MIGRATION,
} from './teamDraftPublicationMigration';
import { TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS } from './teamIdentityStorageSchema';
import { TeamIdentityStorageSupport } from './teamIdentityStorageSupport';

import type { TeamIdentityStorageSchemaDefinition } from './teamIdentityStorageSchema';
import type { TeamIdentityRow } from './teamIdentityStorageSupport';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
const PUBLICATIONS = 'hosted_team_configuration_publications';
const IDENTITY_TABLES = [
  'team_identity_storage_metadata',
  'team_identity_records',
  'legacy_team_key_reservations',
  'team_adoption_intents',
];
const ERROR = 'internal-storage-v29-publication-schema-incompatible';
const PUBLICATION_SCHEMA: readonly TeamIdentityStorageSchemaDefinition[] = [
  {
    type: 'table',
    name: PUBLICATIONS,
    tableName: PUBLICATIONS,
    sql: TEAM_DRAFT_PUBLICATION_MIGRATION.statements[2],
  },
  {
    type: 'trigger',
    name: `${PUBLICATIONS}_immutable`,
    tableName: PUBLICATIONS,
    sql: TEAM_DRAFT_PUBLICATION_MIGRATION.statements[3],
  },
  {
    type: 'trigger',
    name: `${PUBLICATIONS}_no_delete`,
    tableName: PUBLICATIONS,
    sql: TEAM_DRAFT_PUBLICATION_MIGRATION.statements[4],
  },
  ...[1, 2, 3].map((index) => ({
    type: 'index' as const,
    name: `sqlite_autoindex_${PUBLICATIONS}_${index}`,
    tableName: PUBLICATIONS,
    sql: null,
  })),
];

/** Called inside the runner's existing backup fence and v29 transaction.
 * Admit only the retained predecessor or a fully validated durable v29 replay.
 * Never normalize or modify the read-only identity projection to select a path.
 */
export function runTeamDraftPublicationMigrationAdmission(db: SqliteDatabase): void {
  const objects = readObjects(db, 'main');
  // Reject shadows before any unqualified retained DDL or identity graph reads.
  if (readObjects(db, 'temp').length !== 0) throw new Error(ERROR);
  const identity = objects.filter((object) => isIdentity(object));
  const publication = objects.filter((object) => !isIdentity(object));
  const currentIdentity = TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS.map((object) =>
    object.name === 'trg_team_identity_transition'
      ? { ...object, sql: RESERVED_TEAM_IDENTITY_TRANSITION }
      : object
  );
  const predecessor = matches(identity, TEAM_IDENTITY_STORAGE_SCHEMA_DEFINITIONS);
  const replay = matches(identity, currentIdentity) && matches(publication, PUBLICATION_SCHEMA);
  if (!(predecessor && publication.length === 0) && !replay) throw new Error(ERROR);
  assertRelationships(db, replay);
  if (!replay) {
    for (const statement of TEAM_DRAFT_PUBLICATION_MIGRATION.statements) db.exec(statement);
  }
}

// SQLite folds only ASCII identifiers. Use this solely for classification;
// matches() must retain the original names, owner tables, types and SQL bytes.
function foldIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isIdentity(object: TeamIdentityStorageSchemaDefinition): boolean {
  return IDENTITY_TABLES.includes(foldIdentifier(object.tableName)) ||
    /^(?:sqlite_autoindex_|idx_|trg_)?(?:team_identity_|legacy_team_key_|team_adoption_intent)/.test(foldIdentifier(object.name));
}

function readObjects(db: SqliteDatabase, schema: 'main' | 'temp') {
  const objects = db.prepare(
    `SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema`
  ).all() as TeamIdentityStorageSchemaDefinition[];
  return objects.filter((object) => isIdentity(object) ||
    foldIdentifier(object.tableName) === PUBLICATIONS ||
    foldIdentifier(object.name).startsWith(PUBLICATIONS) ||
    foldIdentifier(object.name).startsWith(`sqlite_autoindex_${PUBLICATIONS}`));
}

function matches(
  actual: readonly TeamIdentityStorageSchemaDefinition[],
  expected: readonly TeamIdentityStorageSchemaDefinition[]
): boolean {
  return actual.length === expected.length && expected.every((definition) => {
    const found = actual.filter((object) => object.name === definition.name);
    return found.length === 1 && found[0]?.type === definition.type &&
      found[0]?.tableName === definition.tableName && found[0]?.sql === definition.sql;
  });
}

function assertRelationships(db: SqliteDatabase, replay: boolean): void {
  if (db.pragma('ignore_check_constraints', { simple: true }) !== 0) throw new Error(ERROR);
  const metadata = db.prepare(
    'SELECT component, schema_version FROM main.team_identity_storage_metadata'
  ).all() as { component: unknown; schema_version: unknown }[];
  if (metadata.length !== 1 || metadata[0]?.component !== 'team-identity' ||
      metadata[0]?.schema_version !== 1) {
    throw new Error(ERROR);
  }
  for (const table of [...IDENTITY_TABLES, ...(replay ? [PUBLICATIONS] : [])]) {
    if ((db.pragma(`main.foreign_key_check('${table}')`) as unknown[]).length !== 0) {
      throw new Error(ERROR);
    }
    // Also validate stored CHECK/UNIQUE/NOT NULL constraints, including rows
    // restored by a connection that had constraint enforcement disabled.
    const integrity = db.pragma(`main.integrity_check('${table}')`) as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error(ERROR);
  }
  const support = new TeamIdentityStorageSupport();
  const identities = db.prepare('SELECT * FROM main.team_identity_records').all() as TeamIdentityRow[];
  for (const row of identities) support.assertReadableIdentityGraph(db, support.mapIdentity(row));
  // FKs alone do not prevent an extra intent/reservation pointing at another
  // otherwise valid identity; require both reverse graph edges as well.
  if (db.prepare(`SELECT 1 FROM main.team_adoption_intents a
      JOIN main.team_identity_records i ON i.team_id = a.team_id
      WHERE i.adoption_intent_id IS NOT a.intent_id
      UNION ALL SELECT 1 FROM main.legacy_team_key_reservations r
      JOIN main.team_identity_records i ON i.team_id = r.team_id
      WHERE i.legacy_key IS NOT r.legacy_key LIMIT 1`).get()) throw new Error(ERROR);
}
