import { TeamIdentityStorageOps } from '@features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { expect } from 'vitest';

import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;
const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const workspaceId = `workspace_${'b'.repeat(32)}`;
const timestamp = '2026-08-02T18:00:00.000Z';

/** A populated CURRENT schema to relabel, deliberately not a historical fixture. */
export function seedCurrentPublicationRestore(db: Database): void {
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO hosted_team_configuration_drafts VALUES
    (?, ?, 'active', 1, 'revision_restore', ?, ?, 1, 1)`)
    .run(workspaceId, teamId, '{ "name": "Restore — café" }', '[ { "name": "lead" } ]');
  db.prepare(`INSERT INTO hosted_team_configuration_publications VALUES
    ('operation_restore', ?, ?, 'actor_restore', 'deployment_restore', 'runtime_restore',
     1, 'restore-team', ?, 'revision_restore', NULL, 'pending')`)
    .run(workspaceId, teamId, timestamp);
  db.prepare(`INSERT INTO team_identity_records
    (team_id, state, legacy_key, directory_fingerprint, workspace_id,
     workspace_binding_generation, created_at)
    VALUES (?, 'reserved', 'restore-team', ?, ?, 1, ?)`)
    .run(teamId, 'c'.repeat(64), workspaceId, timestamp);
  db.prepare(`INSERT INTO legacy_team_key_reservations
    (legacy_key, team_id, state, reserved_at) VALUES ('restore-team', ?, 'active', ?)`)
    .run(teamId, timestamp);
  expectCurrentPublicationRestore(db);
}

export function publicationRestoreSnapshot(db: Database) {
  const tables = ['hosted_team_configuration_drafts', 'hosted_team_configuration_publications',
    'team_identity_storage_metadata', 'team_identity_records', 'legacy_team_key_reservations',
    'team_adoption_intents'];
  return {
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name').all(),
    rows: tables.map((table) => db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()),
    bytes: db.prepare(`SELECT hex(CAST(metadata_json AS BLOB)) AS metadata,
      hex(CAST(members_json AS BLOB)) AS members FROM main.hosted_team_configuration_drafts`).all(),
  };
}

export function expectCurrentPublicationRestore(db: Database): void {
  expect(new TeamIdentityStorageOps(() => db).getIdentity(teamId)).toMatchObject({
    teamId, state: 'reserved', legacyKey: 'restore-team', directoryFingerprint: 'c'.repeat(64),
    workspaceBinding: { workspaceId, generation: 1 },
  });
  expect(db.prepare('SELECT operation_id, state FROM hosted_team_configuration_publications').all())
    .toEqual([{ operation_id: 'operation_restore', state: 'pending' }]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
}
