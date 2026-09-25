import { INTERNAL_STORAGE_APPLICATION_ID } from '../application/internalStorageBackupContract';

import { runHostedLifecycleRunReservationMigrationAdmission } from './worker/hostedLifecycleRunReservationMigration';
import { runHostedPromotionRosterBindingMigrationAdmission } from './worker/hostedPromotionRosterBindingMigration';
import { RESERVED_TEAM_IDENTITY_TRANSITION } from './worker/teamDraftPublicationMigration';
import { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } from './worker/teamIdentityStorageSchema';

import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

interface SchemaObject {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly tbl_name?: unknown;
  readonly sql?: unknown;
}

/** Validate retained migration objects and normalize the v29 identity change before the frozen v1 digest.
 * The supplied current-version database is an immutable snapshot. Admission never executes migration SQL.
 * The caller still checks the complete identity object count/digest and graph.
 */
export function normalizeCurrentTeamIdentitySchema(
  objects: readonly SchemaObject[],
  version: unknown,
  database?: Database
): readonly SchemaObject[] {
  if (version === 32 || version === 33) {
    if (
      !database ||
      database.pragma('user_version', { simple: true }) !== version ||
      database.pragma('application_id', { simple: true }) !== INTERNAL_STORAGE_APPLICATION_ID
    ) {
      throw new Error('canonical-team-identity-schema-version-unsupported');
    }
    runHostedPromotionRosterBindingMigrationAdmission(database, true);
    if (version === 33) {
      runHostedLifecycleRunReservationMigrationAdmission(database, true);
    } else {
      // A lowered v32 marker must not admit a partially or fully applied v33 schema.
      const v33Objects = database
        .prepare(
          `SELECT 1 FROM sqlite_schema
        WHERE tbl_name = 'hosted_lifecycle_run_reservations'
           OR name LIKE 'hosted_run_reservations_%'
           OR name LIKE 'sqlite_autoindex_hosted_lifecycle_run_reservations_%'
        LIMIT 1`
        )
        .get();
      if (v33Objects !== undefined) {
        throw new Error('canonical-team-identity-schema-version-unsupported');
      }
    }
  } else if (typeof version === 'number' && version > 31) {
    throw new Error('canonical-team-identity-schema-version-unsupported');
  }
  if (version !== 29 && version !== 30 && version !== 31 && version !== 32 && version !== 33) {
    return objects;
  }
  const name = 'trg_team_identity_transition';
  const current = objects.filter((object) => object.name === name);
  if (
    current.length !== 1 ||
    current[0]?.type !== 'trigger' ||
    current[0]?.tbl_name !== 'team_identity_records' ||
    current[0]?.sql !== RESERVED_TEAM_IDENTITY_TRANSITION
  ) {
    throw new Error('canonical-v29-identity-schema-incompatible');
  }
  const released = TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS.find((sql) =>
    sql.startsWith(`CREATE TRIGGER IF NOT EXISTS ${name}\n`)
  );
  if (!released) throw new Error('canonical-released-identity-schema-absent');
  return objects.map((object) =>
    object.name === name
      ? { ...object, sql: released.replace('CREATE TRIGGER IF NOT EXISTS', 'CREATE TRIGGER') }
      : object
  );
}
