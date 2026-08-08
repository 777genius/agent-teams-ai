import { parseTeamId, type TeamId } from '@shared/contracts/hosted';

import {
  parseTeamRosterSnapshotRecord,
  TEAM_ROSTER_STORAGE_SCHEMA_VERSION,
  type TeamRosterAdoptRecordResult,
  type TeamRosterMemberRecord,
  type TeamRosterSnapshotRecord,
} from '../../../contracts/teamRosterStorageContracts';

import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface StoredRosterRow {
  readonly schema_version: number;
  readonly team_id: string;
  readonly roster_generation: number;
  readonly adoption_fingerprint: string;
  readonly adopted_at: string;
}

interface StoredRosterMemberRow {
  readonly ordinal: number;
  readonly member_id: string;
  readonly legacy_member_key: string;
  readonly member_revision: number;
  readonly state: string;
  readonly provider_id: string;
  readonly model: string | null;
  readonly role: string | null;
  readonly workflow: string | null;
  readonly isolation: string | null;
}

export class TeamRosterStorageOps {
  constructor(private readonly getDatabase: () => SqliteDatabase) {}

  getRoster(teamIdValue: TeamId): TeamRosterSnapshotRecord | null {
    const teamId = parseTeamId(teamIdValue);
    const database = this.getDatabase();
    return database.transaction(() => {
      assertTeamRosterComponentSchema(database);
      return readRoster(database, teamId);
    })();
  }

  adoptRoster(value: TeamRosterSnapshotRecord): TeamRosterAdoptRecordResult {
    const record = parseTeamRosterSnapshotRecord(value);
    if (
      record.rosterGeneration !== 1 ||
      record.members.some((member) => member.memberRevision !== 1)
    ) {
      throw new Error('team-roster-adoption-initial-generation-required');
    }
    const database = this.getDatabase();
    return database.transaction(() => {
      assertTeamRosterComponentSchema(database);
      const identity = database
        .prepare(`SELECT state FROM team_identity_records WHERE team_id = ?`)
        .get(record.teamId) as { readonly state: string } | undefined;
      if (identity?.state !== 'active') {
        throw new Error('team-roster-team-identity-not-active');
      }
      const existing = readRoster(database, parseTeamId(record.teamId));
      if (existing) {
        if (existing.adoptionFingerprint !== record.adoptionFingerprint) {
          throw new Error('team-roster-adoption-conflict');
        }
        return { outcome: 'existing' as const, roster: existing };
      }

      database
        .prepare(
          `INSERT INTO team_rosters (
             team_id, schema_version, roster_generation, adoption_fingerprint, adopted_at
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          record.teamId,
          record.schemaVersion,
          record.rosterGeneration,
          record.adoptionFingerprint,
          record.adoptedAt
        );
      const insertMember = database.prepare(
        `INSERT INTO team_roster_members (
           member_id, team_id, ordinal, legacy_member_key, legacy_member_key_folded,
           member_revision, state, provider_id, model, role, workflow, isolation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const member of record.members) {
        insertMember.run(
          member.memberId,
          record.teamId,
          member.ordinal,
          member.legacyMemberKey,
          member.legacyMemberKey.toLowerCase(),
          member.memberRevision,
          member.state,
          member.providerId,
          member.model,
          member.role,
          member.workflow,
          member.isolation
        );
      }
      const persisted = readRoster(database, parseTeamId(record.teamId));
      if (!persisted) throw new Error('team-roster-adoption-readback-missing');
      return { outcome: 'created' as const, roster: persisted };
    })();
  }
}

function assertTeamRosterComponentSchema(database: SqliteDatabase): void {
  const row = database
    .prepare(
      `SELECT schema_version
       FROM team_roster_storage_metadata
       WHERE component = 'team-roster'`
    )
    .get() as { readonly schema_version: number } | undefined;
  if (row?.schema_version !== TEAM_ROSTER_STORAGE_SCHEMA_VERSION) {
    throw new Error('team-roster-storage-schema-unsupported');
  }
}

function readRoster(database: SqliteDatabase, teamId: TeamId): TeamRosterSnapshotRecord | null {
  const row = database
    .prepare(
      `SELECT
         schema_version, team_id, roster_generation, adoption_fingerprint, adopted_at
       FROM team_rosters
       WHERE team_id = ?`
    )
    .get(teamId) as StoredRosterRow | undefined;
  if (!row) return null;
  const memberRows = database
    .prepare(
      `SELECT
         ordinal, member_id, legacy_member_key, member_revision, state, provider_id,
         model, role, workflow, isolation
       FROM team_roster_members
       WHERE team_id = ?
       ORDER BY ordinal ASC`
    )
    .all(teamId) as StoredRosterMemberRow[];
  return parseTeamRosterSnapshotRecord({
    schemaVersion: row.schema_version,
    teamId: row.team_id,
    rosterGeneration: row.roster_generation,
    adoptionFingerprint: row.adoption_fingerprint,
    adoptedAt: row.adopted_at,
    members: memberRows.map(
      (member): TeamRosterMemberRecord => ({
        ordinal: member.ordinal,
        memberId: member.member_id,
        legacyMemberKey: member.legacy_member_key,
        memberRevision: member.member_revision,
        state: member.state as TeamRosterMemberRecord['state'],
        providerId: member.provider_id as TeamRosterMemberRecord['providerId'],
        model: member.model,
        role: member.role,
        workflow: member.workflow,
        isolation: member.isolation as TeamRosterMemberRecord['isolation'],
      })
    ),
  });
}
