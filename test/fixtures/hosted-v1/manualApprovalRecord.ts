import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import Database from 'better-sqlite3-node';

import { parseHostedRosterConfiguration } from '../../../src/features/team-configuration/contracts/hostedRosterConfiguration';
import { canonicalHostedTeamConfigurationCreate } from '../../../src/features/team-configuration/core/application/hosted-authority/canonicalHostedTeamConfigurationCreate';

interface ManualRecordRow {
  readonly workspace_id: string;
  readonly team_id: string;
  readonly state: string;
  readonly revision_ordinal: number;
  readonly revision_token: string;
  readonly metadata_json: string;
  readonly members_json: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ManualRecordSnapshot {
  readonly draft: ManualRecordRow;
  readonly createKeys: readonly Record<string, unknown>[];
  readonly publications: readonly Record<string, unknown>[];
  readonly promotions: readonly Record<string, unknown>[];
}

async function databasePath(sandboxRoot: string, appDataDir: string): Promise<string> {
  const root = await realpath(sandboxRoot);
  const data = await realpath(appDataDir);
  const rel = relative(root, data);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('manual_approval_fixture_outside_sandbox');
  }
  const database = await realpath(join(data, 'data', 'storage', 'app.db'));
  const databaseRelation = relative(root, database);
  if (!databaseRelation || databaseRelation === '..' || databaseRelation.startsWith(`..${sep}`)) {
    throw new Error('manual_approval_fixture_database_outside_sandbox');
  }
  return database;
}

function snapshot(
  database: InstanceType<typeof Database>,
  workspaceId: string,
  teamId: string
): ManualRecordSnapshot {
  const draft = database
    .prepare(
      'SELECT * FROM hosted_team_configuration_drafts WHERE workspace_id = ? AND team_id = ?'
    )
    .get(workspaceId, teamId) as ManualRecordRow | undefined;
  if (!draft) throw new Error('manual_approval_fixture_draft_missing');
  const createKeys = database
    .prepare(
      'SELECT * FROM hosted_team_configuration_create_keys WHERE workspace_id = ? AND team_id = ? ORDER BY idempotency_key'
    )
    .all(workspaceId, teamId) as Record<string, unknown>[];
  const publications = database
    .prepare(
      'SELECT * FROM hosted_team_configuration_publications WHERE workspace_id = ? AND team_id = ? ORDER BY operation_id'
    )
    .all(workspaceId, teamId) as Record<string, unknown>[];
  const promotions = database
    .prepare(
      'SELECT * FROM hosted_team_configuration_promotions WHERE workspace_id = ? AND team_id = ? ORDER BY operation_id'
    )
    .all(workspaceId, teamId) as Record<string, unknown>[];
  return { draft, createKeys, publications, promotions };
}

export async function seedHistoricalManualRecord(input: {
  readonly sandboxRoot: string;
  readonly appDataDir: string;
  readonly workspaceId: string;
  readonly teamId: string;
}): Promise<ManualRecordSnapshot> {
  const database = new Database(await databasePath(input.sandboxRoot, input.appDataDir));
  try {
    return database
      .transaction(() => {
        const before = snapshot(database, input.workspaceId, input.teamId);
        const roster = JSON.parse(before.draft.members_json) as Record<string, unknown>;
        const configuration = roster.configuration as Record<string, unknown> | undefined;
        if (configuration?.toolApprovalMode !== 'auto') {
          throw new Error('manual_approval_fixture_auto_preimage_missing');
        }
        if (before.createKeys.length !== 1)
          throw new Error('manual_approval_fixture_create_key_missing');
        const manualConfiguration = parseHostedRosterConfiguration({
          ...configuration,
          toolApprovalMode: 'manual',
        });
        const manual = JSON.stringify({ ...roster, configuration: manualConfiguration });
        const metadata = JSON.parse(before.draft.metadata_json) as { name: string };
        const members = roster.members as { name: string }[];
        const manualHash = createHash('sha256')
          .update(
            canonicalHostedTeamConfigurationCreate({
              workspaceId: input.workspaceId as never,
              name: metadata.name,
              members,
              configuration: manualConfiguration,
            })
          )
          .digest('hex');
        const changed = database
          .prepare(
            'UPDATE hosted_team_configuration_drafts SET members_json = ? WHERE workspace_id = ? AND team_id = ? AND members_json = ?'
          )
          .run(manual, input.workspaceId, input.teamId, before.draft.members_json);
        if (changed.changes !== 1) throw new Error('manual_approval_fixture_seed_conflict');
        const key = database
          .prepare(
            'UPDATE hosted_team_configuration_create_keys SET payload_hash = ? WHERE workspace_id = ? AND team_id = ?'
          )
          .run(manualHash, input.workspaceId, input.teamId);
        if (key.changes !== 1) throw new Error('manual_approval_fixture_create_key_conflict');
        return snapshot(database, input.workspaceId, input.teamId);
      })
      .immediate();
  } finally {
    database.close();
  }
}

export async function readHistoricalManualRecord(input: {
  readonly sandboxRoot: string;
  readonly appDataDir: string;
  readonly workspaceId: string;
  readonly teamId: string;
}): Promise<ManualRecordSnapshot> {
  const database = new Database(await databasePath(input.sandboxRoot, input.appDataDir), {
    readonly: true,
  });
  try {
    return snapshot(database, input.workspaceId, input.teamId);
  } finally {
    database.close();
  }
}
