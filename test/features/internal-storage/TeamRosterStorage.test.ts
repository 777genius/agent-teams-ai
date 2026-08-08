import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseTeamRosterSnapshotRecord,
  TEAM_ROSTER_STORAGE_SCHEMA_VERSION,
  type TeamRosterSnapshotRecord,
} from '@features/internal-storage/contracts';
import { INTERNAL_STORAGE_SCHEMA_VERSION } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  parseMemberId,
  parseTeamId,
  parseWorkspaceId,
  type TeamId,
} from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

function makeCore(databasePath: string, onSql?: (sql: string) => void): InternalStorageWorkerCore {
  return new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) =>
      new Database(file, onSql ? { verbose: (message) => onSql(String(message)) } : undefined),
  });
}

function roster(
  teamId: TeamId,
  character: string,
  overrides: Partial<TeamRosterSnapshotRecord> = {}
): TeamRosterSnapshotRecord {
  return parseTeamRosterSnapshotRecord({
    schemaVersion: TEAM_ROSTER_STORAGE_SCHEMA_VERSION,
    teamId,
    rosterGeneration: 1,
    adoptionFingerprint: `sha256:${character.repeat(64)}`,
    adoptedAt: '2026-07-23T10:00:00.000Z',
    members: [
      {
        ordinal: 0,
        memberId: parseMemberId(`member_${character.repeat(32)}`),
        legacyMemberKey: `builder-${character}`,
        memberRevision: 1,
        state: 'active',
        providerId: 'codex',
        model: 'gpt-5',
        role: 'builder',
        workflow: null,
        isolation: null,
      },
    ],
    ...overrides,
  });
}

function insertActiveTeamIdentity(databasePath: string, teamId: TeamId, key: string): void {
  const character = teamId.slice('team_'.length, 'team_'.length + 1);
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = ON');
    database
      .prepare(
        `INSERT INTO team_identity_records (
           team_id, state, legacy_key, directory_fingerprint, workspace_id,
           workspace_binding_generation, adoption_intent_id, identity_checksum,
           created_at, activated_at, tombstoned_at
         ) VALUES (?, 'active', ?, ?, ?, 1, ?, ?, ?, ?, NULL)`
      )
      .run(
        teamId,
        key,
        character.repeat(64),
        parseWorkspaceId(`workspace_${character.repeat(32)}`),
        `adoption_${character.repeat(32)}`,
        character.repeat(64),
        '2026-07-23T09:00:00.000Z',
        '2026-07-23T09:01:00.000Z'
      );
    database
      .prepare(
        `INSERT INTO legacy_team_key_reservations (
           legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
         ) VALUES (?, ?, 'active', ?, NULL, NULL)`
      )
      .run(key, teamId, '2026-07-23T09:00:00.000Z');
  } finally {
    database.close();
  }
}

function prepareHistoricalV9Database(databasePath: string, malformedRosterMetadata = false): void {
  const current = makeCore(databasePath);
  current.handle('ping', {});
  current.close();

  const database = new Database(databasePath);
  try {
    database.exec(
      `DROP TRIGGER trg_team_roster_metadata_no_update;
       DROP TRIGGER trg_team_roster_metadata_no_delete;
       DROP TABLE team_roster_members;
       DROP TABLE team_rosters;
       DROP TABLE team_roster_storage_metadata`
    );
    if (malformedRosterMetadata) {
      database.exec(
        `CREATE TABLE team_roster_storage_metadata (
           component TEXT PRIMARY KEY,
           schema_version INTEGER NOT NULL
         );
         INSERT INTO team_roster_storage_metadata VALUES ('team-roster', 2)`
      );
    }
    database.pragma('user_version = 9');
  } finally {
    database.close();
  }
}

describe('TeamRoster internal storage', () => {
  let temporaryDirectory: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  async function databasePath(): Promise<string> {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-roster-storage-'));
    return path.join(temporaryDirectory, 'storage', 'app.db');
  }

  function track(core: InternalStorageWorkerCore): InternalStorageWorkerCore {
    cores.push(core);
    return core;
  }

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // already closed
      }
    }
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it('adopts atomically and reloads the exact generation and MemberIds after reopen', async () => {
    const target = await databasePath();
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const first = track(makeCore(target));
    first.handle('ping', {});
    insertActiveTeamIdentity(target, teamId, 'atlas');
    const candidate = roster(teamId, 'a');

    expect(first.handle('teamRoster.adopt', { roster: candidate })).toEqual({
      outcome: 'created',
      roster: candidate,
    });
    expect(first.handle('teamRoster.adopt', { roster: candidate })).toEqual({
      outcome: 'existing',
      roster: candidate,
    });
    first.close();

    const reopened = track(makeCore(target));
    expect(reopened.handle('teamRoster.get', { teamId })).toEqual(candidate);
    expect(reopened.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      integrity: 'ok',
    });
  });

  it('rejects a conflicting adoption without overwriting persisted identity', async () => {
    const target = await databasePath();
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const core = track(makeCore(target));
    core.handle('ping', {});
    insertActiveTeamIdentity(target, teamId, 'atlas');
    const original = roster(teamId, 'a');
    core.handle('teamRoster.adopt', { roster: original });

    expect(() =>
      core.handle('teamRoster.adopt', {
        roster: roster(teamId, 'b', {
          members: [
            {
              ...roster(teamId, 'b').members[0]!,
              legacyMemberKey: 'reviewer-b',
            },
          ],
        }),
      })
    ).toThrow('team-roster-adoption-conflict');
    expect(core.handle('teamRoster.get', { teamId })).toEqual(original);
  });

  it('reads roster generation and member rows from one SQLite snapshot', async () => {
    const target = await databasePath();
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const writer = track(makeCore(target));
    writer.handle('ping', {});
    insertActiveTeamIdentity(target, teamId, 'atlas');
    const candidate = roster(teamId, 'a');
    writer.handle('teamRoster.adopt', { roster: candidate });
    writer.close();

    const external = new Database(target);
    let rosterRowRead = false;
    let updatedBetweenSelects = false;
    const reader = track(
      makeCore(target, (sql) => {
        if (/FROM team_rosters\s+WHERE team_id/.test(sql)) {
          rosterRowRead = true;
        } else if (
          rosterRowRead &&
          !updatedBetweenSelects &&
          /FROM team_roster_members\s+WHERE team_id/.test(sql)
        ) {
          external.transaction(() => {
            external
              .prepare(`UPDATE team_rosters SET roster_generation = 2 WHERE team_id = ?`)
              .run(teamId);
            external
              .prepare(
                `UPDATE team_roster_members
                 SET member_revision = 2, role = 'changed-concurrently'
                 WHERE team_id = ?`
              )
              .run(teamId);
          })();
          updatedBetweenSelects = true;
        }
      })
    );

    try {
      expect(reader.handle('teamRoster.get', { teamId })).toEqual(candidate);
      expect(updatedBetweenSelects).toBe(true);
      expect(reader.handle('teamRoster.get', { teamId })).toMatchObject({
        rosterGeneration: 2,
        members: [{ memberRevision: 2, role: 'changed-concurrently' }],
      });
    } finally {
      external.close();
    }
  });

  it('rolls back the aggregate row when a globally stable MemberId collides', async () => {
    const target = await databasePath();
    const firstTeamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const secondTeamId = parseTeamId(`team_${'b'.repeat(32)}`);
    const core = track(makeCore(target));
    core.handle('ping', {});
    insertActiveTeamIdentity(target, firstTeamId, 'atlas');
    insertActiveTeamIdentity(target, secondTeamId, 'bravo');
    const firstRoster = roster(firstTeamId, 'a');
    core.handle('teamRoster.adopt', { roster: firstRoster });
    const colliding = roster(secondTeamId, 'b', {
      members: [
        {
          ...roster(secondTeamId, 'b').members[0]!,
          memberId: firstRoster.members[0]!.memberId,
        },
      ],
    });

    expect(() => core.handle('teamRoster.adopt', { roster: colliding })).toThrow();
    expect(core.handle('teamRoster.get', { teamId: secondTeamId })).toBeNull();
    expect(core.handle('teamRoster.get', { teamId: firstTeamId })).toEqual(firstRoster);
  });

  it('migrates a historical schema in one transaction and refuses a malformed preexisting component', async () => {
    const target = await databasePath();
    prepareHistoricalV9Database(target);

    const migrated = track(makeCore(target));
    expect(migrated.handle('ping', {})).toMatchObject({
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
    });
    migrated.close();

    const malformedPath = path.join(temporaryDirectory!, 'storage', 'malformed.db');
    prepareHistoricalV9Database(malformedPath, true);

    const rejected = track(makeCore(malformedPath));
    expect(() => rejected.handle('ping', {})).toThrow(
      'team-roster-storage-migration-metadata-invalid'
    );
    const unchanged = new Database(malformedPath, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(9);
      expect(
        unchanged.prepare(`SELECT schema_version FROM team_roster_storage_metadata`).pluck().get()
      ).toBe(2);
      expect(
        unchanged
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('team_rosters', 'team_roster_members')
             ORDER BY name`
          )
          .pluck()
          .all()
      ).toEqual([]);
    } finally {
      unchanged.close();
    }
  });
});
