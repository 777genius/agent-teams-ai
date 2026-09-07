import { RESERVED_TEAM_IDENTITY_TRANSITION } from './worker/teamDraftPublicationMigration';
import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './worker/teamIdentityStorageSchema';

interface SchemaObject {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly tbl_name?: unknown;
  readonly sql?: unknown;
}

/** Validate the one explicit v29 identity change (retained in v30) before the frozen v1 digest.
 * This only normalizes an in-memory schema projection; it never executes SQL or repairs storage.
 * The caller must still check the complete object count/digest and identity graph.
 */
export function normalizeCurrentTeamIdentitySchema(
  objects: readonly SchemaObject[], version: unknown
): readonly SchemaObject[] {
  if (version !== 29 && version !== 30) return objects;
  const name = 'trg_team_identity_transition';
  const current = objects.filter((object) => object.name === name);
  if (current.length !== 1 || current[0]?.type !== 'trigger' ||
      current[0]?.tbl_name !== 'team_identity_records' || current[0]?.sql !== RESERVED_TEAM_IDENTITY_TRANSITION) {
    throw new Error('canonical-v29-identity-schema-incompatible');
  }
  const released = TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS.find((sql) =>
    sql.startsWith(`CREATE TRIGGER IF NOT EXISTS ${name}\n`));
  if (!released) throw new Error('canonical-released-identity-schema-absent');
  return objects.map((object) => object.name === name
    ? { ...object, sql: released.replace('CREATE TRIGGER IF NOT EXISTS', 'CREATE TRIGGER') }
    : object);
}
