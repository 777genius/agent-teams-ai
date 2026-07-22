import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { MemberWorkSyncWorkerOps } from '@features/internal-storage/main/infrastructure/worker/memberWorkSyncWorkerOps';
import Database from 'better-sqlite3-node';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
} from '@features/internal-storage/contracts/internalStorageContracts';

const TEAM_NAME = 'team-a';
const ITEM_ID = 'member-work-sync:team-a:bob:agenda:v1:abc';
const CREATED_AT = '2026-07-17T09:00:00.000Z';
const CLAIMED_AT = '2026-07-17T09:01:00.000Z';

type TeamNamedRecords = readonly { teamName: string }[];

function makeOutboxRecord(
  overrides: Partial<MemberWorkSyncOutboxItemRecord> = {}
): MemberWorkSyncOutboxItemRecord {
  return {
    teamName: TEAM_NAME,
    id: ITEM_ID,
    memberKey: 'bob',
    memberName: 'bob',
    agendaFingerprint: 'agenda:v1:abc',
    payloadHash: 'hash-a',
    status: 'pending',
    attemptGeneration: 0,
    claimedBy: null,
    claimedAt: null,
    deliveredMessageId: null,
    deliveryState: null,
    lastError: null,
    nextAttemptAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    workSyncIntent: 'status_check',
    workSyncIntentKey: null,
    reviewRequestEventIdsJson: null,
    deliveryDiagnosticsJson: null,
    payloadJson: JSON.stringify({ text: 'Check work status.', workSyncIntent: 'status_check' }),
    ...overrides,
  };
}

function makeStatusRecord(
  teamName: string,
  memberKey: string,
  evaluatedAt = CREATED_AT
): MemberWorkSyncStatusRecord {
  return {
    teamName,
    memberKey,
    memberName: memberKey,
    state: 'still_working',
    evaluatedAt,
    providerId: null,
    statusJson: JSON.stringify({
      teamName,
      memberName: memberKey,
      state: 'still_working',
      agenda: { teamName, memberName: memberKey },
    }),
  };
}

function makeMetricEventRecord(
  teamName: string,
  id: string,
  memberKey: string
): MemberWorkSyncMetricEventRecord {
  return {
    teamName,
    id,
    memberKey,
    memberName: memberKey,
    kind: 'status_evaluated',
    recordedAt: CREATED_AT,
    eventJson: JSON.stringify({ teamName, memberName: memberKey, kind: 'status_evaluated' }),
  };
}

function makeReportIntentRecord(
  teamName: string,
  id: string,
  memberKey: string
): MemberWorkSyncReportIntentRecord {
  return {
    teamName,
    id,
    memberKey,
    memberName: memberKey,
    status: 'pending',
    reason: 'test',
    recordedAt: CREATED_AT,
    processedAt: null,
    resultCode: null,
    requestJson: JSON.stringify({ teamName, memberName: memberKey }),
  };
}

describe('MemberWorkSyncWorkerOps.outboxMarkFailed', () => {
  let database: InstanceType<typeof Database>;
  let ops: MemberWorkSyncWorkerOps;

  beforeEach(() => {
    database = new Database(':memory:');
    runInternalStorageMigrations(database);
    const orm = drizzle(database);
    ops = new MemberWorkSyncWorkerOps(() => orm);
  });

  afterEach(() => {
    database.close();
  });

  function createAndClaim(): MemberWorkSyncOutboxItemRecord {
    ops.outboxEnsurePending({
      record: makeOutboxRecord(),
      nowIso: CREATED_AT,
      nextAttemptAt: null,
    });
    const [claimed] = ops.outboxClaimDue({
      teamName: TEAM_NAME,
      claimedBy: 'dispatcher-a',
      nowIso: CLAIMED_AT,
      limit: 1,
    });
    return claimed;
  }

  function readItem(): MemberWorkSyncOutboxItemRecord {
    const [item] = ops.listTeamSnapshot(TEAM_NAME).outboxItems;
    return item;
  }

  it('requires the current claim generation before marking an attempt failed', () => {
    const claimed = createAndClaim();

    ops.outboxMarkFailed({
      teamName: TEAM_NAME,
      id: ITEM_ID,
      attemptGeneration: claimed.attemptGeneration - 1,
      error: 'late stale failure',
      retryable: true,
      nextAttemptAt: '2026-07-17T09:10:00.000Z',
      nowIso: '2026-07-17T09:02:00.000Z',
    });
    expect(readItem()).toEqual(claimed);

    ops.outboxMarkFailed({
      teamName: TEAM_NAME,
      id: ITEM_ID,
      attemptGeneration: claimed.attemptGeneration,
      error: 'temporary delivery failure',
      retryable: true,
      nextAttemptAt: '2026-07-17T09:10:00.000Z',
      nowIso: '2026-07-17T09:03:00.000Z',
    });
    expect(readItem()).toMatchObject({
      status: 'failed_retryable',
      attemptGeneration: claimed.attemptGeneration,
      lastError: 'temporary delivery failure',
      nextAttemptAt: '2026-07-17T09:10:00.000Z',
      updatedAt: '2026-07-17T09:03:00.000Z',
    });
  });

  it('does not let a late claim failure overwrite revived pending work', () => {
    const claimed = createAndClaim();
    const revivedAt = '2026-07-17T09:02:00.000Z';
    const revived = ops.outboxEnsurePending({
      record: makeOutboxRecord(),
      nowIso: revivedAt,
      nextAttemptAt: null,
    });

    expect(revived).toMatchObject({
      ok: true,
      outcome: 'existing',
      item: {
        status: 'pending',
        attemptGeneration: claimed.attemptGeneration,
        updatedAt: revivedAt,
      },
    });

    ops.outboxMarkFailed({
      teamName: TEAM_NAME,
      id: ITEM_ID,
      attemptGeneration: claimed.attemptGeneration,
      error: 'late stale failure',
      retryable: false,
      nextAttemptAt: null,
      nowIso: '2026-07-17T09:03:00.000Z',
    });

    expect(readItem()).toEqual(revived.item);
  });

  it('treats importTeam as the exact routing identity for rows and nested JSON', () => {
    const canonicalTeam = 'Team-A';
    const legacyAlias = 'team-a';
    const snapshot: MemberWorkSyncTeamSnapshotRecords = {
      statuses: [
        {
          teamName: legacyAlias,
          memberKey: 'bob',
          memberName: 'bob',
          state: 'still_working',
          evaluatedAt: CREATED_AT,
          providerId: null,
          statusJson: JSON.stringify({
            teamName: legacyAlias,
            memberName: 'bob',
            state: 'still_working',
            agenda: { teamName: legacyAlias, memberName: 'bob' },
            report: { teamName: legacyAlias, memberName: 'bob' },
          }),
        },
      ],
      reportIntents: [
        {
          teamName: legacyAlias,
          id: 'intent-1',
          memberKey: 'bob',
          memberName: 'bob',
          status: 'pending',
          reason: 'test',
          recordedAt: CREATED_AT,
          processedAt: null,
          resultCode: null,
          requestJson: JSON.stringify({ teamName: legacyAlias, memberName: 'bob' }),
        },
      ],
      outboxItems: [{ ...makeOutboxRecord(), teamName: legacyAlias }],
      metricEvents: [
        {
          teamName: legacyAlias,
          id: 'metric-1',
          memberKey: 'bob',
          memberName: 'bob',
          kind: 'status_evaluated',
          recordedAt: CREATED_AT,
          eventJson: JSON.stringify({ teamName: legacyAlias, memberName: 'bob' }),
        },
      ],
    };

    ops.importTeam(canonicalTeam, snapshot);

    expect(ops.statusRead(legacyAlias, 'bob')).toBeNull();
    const status = ops.statusRead(canonicalTeam, 'bob');
    expect(status?.teamName).toBe(canonicalTeam);
    expect(JSON.parse(status?.statusJson ?? '{}')).toMatchObject({
      teamName: canonicalTeam,
      agenda: { teamName: canonicalTeam },
      report: { teamName: canonicalTeam },
    });
    expect(ops.reportsListPending(legacyAlias)).toEqual([]);
    expect(JSON.parse(ops.reportsListPending(canonicalTeam)[0].requestJson)).toMatchObject({
      teamName: canonicalTeam,
    });
    expect(ops.metricEventsList(legacyAlias)).toEqual([]);
    expect(JSON.parse(ops.metricEventsList(canonicalTeam)[0].eventJson)).toMatchObject({
      teamName: canonicalTeam,
    });
    expect(
      ops.outboxClaimDue({
        teamName: legacyAlias,
        claimedBy: 'wrong-route',
        nowIso: CLAIMED_AT,
        limit: 1,
      })
    ).toEqual([]);
    expect(
      ops.outboxClaimDue({
        teamName: canonicalTeam,
        claimedBy: 'canonical-route',
        nowIso: CLAIMED_AT,
        limit: 1,
      })
    ).toHaveLength(1);
  });

  it('uses normalized team-key indexes to find whitespace and case aliases amid unrelated bulk data', () => {
    const aliases = ['  Team-A  ', 'team-a'];
    for (const [index, alias] of aliases.entries()) {
      const memberKey = `alias-${index}`;
      ops.statusWrite(makeStatusRecord(alias, memberKey), [
        makeMetricEventRecord(alias, `alias-metric-${index}`, memberKey),
      ]);
      ops.reportsAppend(makeReportIntentRecord(alias, `alias-report-${index}`, memberKey));
      ops.outboxEnsurePending({
        record: makeOutboxRecord({
          teamName: alias,
          id: `alias-outbox-${index}`,
          memberKey,
          memberName: memberKey,
        }),
        nowIso: CREATED_AT,
        nextAttemptAt: null,
      });
    }
    for (let index = 0; index < 250; index += 1) {
      const teamName = `unrelated-${index}`;
      const memberKey = `bulk-${index}`;
      ops.statusWrite(makeStatusRecord(teamName, memberKey), [
        makeMetricEventRecord(teamName, `bulk-metric-${index}`, memberKey),
      ]);
      ops.reportsAppend(makeReportIntentRecord(teamName, `bulk-report-${index}`, memberKey));
      ops.outboxEnsurePending({
        record: makeOutboxRecord({
          teamName,
          id: `bulk-outbox-${index}`,
          memberKey,
          memberName: memberKey,
        }),
        nowIso: CREATED_AT,
        nextAttemptAt: null,
      });
    }

    const result = ops.listTeamSnapshot(' TEAM-A ');

    expect(result.statuses).toHaveLength(2);
    expect(result.reportIntents).toHaveLength(2);
    expect(result.outboxItems).toHaveLength(2);
    expect(result.metricEvents).toHaveLength(2);
    const recordGroups: readonly TeamNamedRecords[] = Object.values(result);
    for (const records of recordGroups) {
      expect(new Set(records.map((record) => record.teamName))).toEqual(new Set(aliases));
      for (const record of records) expect(record).not.toHaveProperty('teamKey');
    }
    expectQueryPlanToUseIndex(database, 'member_work_sync_status', 'idx_mws_status_team_key');
    expectQueryPlanToUseIndex(
      database,
      'member_work_sync_report_intents',
      'idx_mws_report_intents_team_key'
    );
    expectQueryPlanToUseIndex(database, 'member_work_sync_outbox', 'idx_mws_outbox_team_key');
    expectQueryPlanToUseIndex(
      database,
      'member_work_sync_metric_events',
      'idx_mws_metric_events_team_key'
    );
  });

  it('collapses every exact alias spelling and reinserts only canonical public rows in one import', () => {
    const aliases = [' team-a ', 'TEAM-A'];
    for (const [index, alias] of aliases.entries()) {
      const memberKey = `member-${index}`;
      ops.statusWrite(makeStatusRecord(alias, memberKey), [
        makeMetricEventRecord(alias, `metric-${index}`, memberKey),
      ]);
      ops.reportsAppend(makeReportIntentRecord(alias, `report-${index}`, memberKey));
      ops.outboxEnsurePending({
        record: makeOutboxRecord({
          teamName: alias,
          id: `outbox-${index}`,
          memberKey,
          memberName: memberKey,
        }),
        nowIso: CREATED_AT,
        nextAttemptAt: null,
      });
    }
    const union = ops.listTeamSnapshot('team-a');

    ops.importTeam('Team-A', union);

    const canonical = ops.listTeamSnapshot(' team-A ');
    expect(canonical.statuses).toHaveLength(2);
    expect(canonical.reportIntents).toHaveLength(2);
    expect(canonical.outboxItems).toHaveLength(2);
    expect(canonical.metricEvents).toHaveLength(2);
    for (const tableName of MEMBER_WORK_SYNC_TABLES) {
      expect(
        database.prepare(`SELECT DISTINCT team_name, team_key FROM ${tableName}`).all()
      ).toEqual([{ team_name: 'Team-A', team_key: 'team-a' }]);
    }
    const canonicalRecordGroups: readonly TeamNamedRecords[] = Object.values(canonical);
    for (const records of canonicalRecordGroups) {
      for (const record of records) expect(record).not.toHaveProperty('teamKey');
    }
  });

  it('repairs persistence team keys on every status, metric, report, and outbox write path', () => {
    const teamName = ' Team-A ';
    const status = makeStatusRecord(teamName, 'bob');
    const metric = makeMetricEventRecord(teamName, 'metric-1', 'bob');
    const report = makeReportIntentRecord(teamName, 'report-1', 'bob');
    const outbox = makeOutboxRecord({ teamName, id: 'outbox-1' });
    ops.statusWrite(status, [metric]);
    ops.reportsAppend(report);
    ops.outboxEnsurePending({ record: outbox, nowIso: CREATED_AT, nextAttemptAt: null });
    for (const tableName of MEMBER_WORK_SYNC_TABLES) {
      database.prepare(`UPDATE ${tableName} SET team_key = 'corrupt-key'`).run();
    }

    ops.statusWrite(status, [metric]);
    ops.reportsAppend(report);
    const [claimed] = ops.outboxClaimDue({
      teamName,
      claimedBy: 'dispatcher',
      nowIso: CLAIMED_AT,
      limit: 1,
    });
    expect(claimed).toBeDefined();

    for (const tableName of MEMBER_WORK_SYNC_TABLES) {
      expect(database.prepare(`SELECT team_key FROM ${tableName}`).get()).toEqual({
        team_key: 'team-a',
      });
    }
  });
});

describe('member-work-sync v9 migration', () => {
  it('backfills all four team keys with the shared JavaScript normalizer and recreates indexes', () => {
    const database = new Database(':memory:');
    try {
      createV8MemberWorkSyncSchema(database);
      const legacyTeamNames = ['  ÉQUIPE  ', 'Équipe', 'éQUIPE ', ' ÉQUIPE'];
      database
        .prepare(
          `INSERT INTO member_work_sync_status (
             team_name, member_key, member_name, state, evaluated_at, provider_id, status_json
           ) VALUES (?, 'bob', 'bob', 'still_working', ?, NULL, '{}')`
        )
        .run(legacyTeamNames[0], CREATED_AT);
      database
        .prepare(
          `INSERT INTO member_work_sync_report_intents (
             team_name, id, member_key, member_name, status, reason, recorded_at,
             processed_at, result_code, request_json
           ) VALUES (?, 'report-1', 'bob', 'bob', 'pending', 'test', ?, NULL, NULL, '{}')`
        )
        .run(legacyTeamNames[1], CREATED_AT);
      database
        .prepare(
          `INSERT INTO member_work_sync_outbox (
             team_name, id, member_key, member_name, agenda_fingerprint, payload_hash,
             status, attempt_generation, claimed_by, claimed_at, delivered_message_id,
             delivery_state, last_error, next_attempt_at, created_at, updated_at,
             work_sync_intent, work_sync_intent_key, review_request_event_ids_json,
             delivery_diagnostics_json, payload_json
           ) VALUES (
             ?, 'outbox-1', 'bob', 'bob', 'agenda', 'hash', 'pending', 0,
             NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 'status_check', NULL, NULL, NULL, '{}'
           )`
        )
        .run(legacyTeamNames[2], CREATED_AT, CREATED_AT);
      database
        .prepare(
          `INSERT INTO member_work_sync_metric_events (
             team_name, id, member_key, member_name, kind, recorded_at, event_json
           ) VALUES (?, 'metric-1', 'bob', 'bob', 'status_evaluated', ?, '{}')`
        )
        .run(legacyTeamNames[3], CREATED_AT);
      database.pragma('user_version = 8');

      runInternalStorageMigrations(database);

      expect(database.pragma('user_version', { simple: true })).toBe(9);
      for (const tableName of MEMBER_WORK_SYNC_TABLES) {
        const columns = database.pragma(`table_info(${tableName})`) as Array<{
          name: string;
          notnull: number;
        }>;
        expect(columns).toContainEqual(expect.objectContaining({ name: 'team_key', notnull: 1 }));
        expect(database.prepare(`SELECT team_key FROM ${tableName}`).get()).toEqual({
          team_key: 'équipe',
        });
      }
      expectMemberWorkSyncTeamKeyIndexes(database);

      for (const indexName of MEMBER_WORK_SYNC_TEAM_KEY_INDEXES) {
        database.exec(`DROP INDEX ${indexName}`);
      }
      runInternalStorageMigrations(database);
      expectMemberWorkSyncTeamKeyIndexes(database);
    } finally {
      database.close();
    }
  });
});

const MEMBER_WORK_SYNC_TABLES = [
  'member_work_sync_status',
  'member_work_sync_report_intents',
  'member_work_sync_outbox',
  'member_work_sync_metric_events',
] as const;

const MEMBER_WORK_SYNC_TEAM_KEY_INDEXES = [
  'idx_mws_status_team_key',
  'idx_mws_report_intents_team_key',
  'idx_mws_outbox_team_key',
  'idx_mws_metric_events_team_key',
] as const;

function expectQueryPlanToUseIndex(
  database: InstanceType<typeof Database>,
  tableName: string,
  indexName: string
): void {
  const plan = database
    .prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${tableName} WHERE team_key = ?`)
    .all('team-a') as Array<{ detail: string }>;
  expect(plan.map((step) => step.detail).join('\n')).toContain(indexName);
}

function expectMemberWorkSyncTeamKeyIndexes(database: InstanceType<typeof Database>): void {
  const indexes = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'idx_mws_%_team_key'
       ORDER BY name`
    )
    .all() as Array<{ name: string }>;
  expect(indexes.map((index) => index.name).sort()).toEqual(
    [...MEMBER_WORK_SYNC_TEAM_KEY_INDEXES].sort()
  );
}

function createV8MemberWorkSyncSchema(database: InstanceType<typeof Database>): void {
  database.exec(`
    CREATE TABLE member_work_sync_status (
      team_name TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      state TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      provider_id TEXT,
      status_json TEXT NOT NULL,
      PRIMARY KEY (team_name, member_key)
    );
    CREATE TABLE member_work_sync_report_intents (
      team_name TEXT NOT NULL,
      id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      processed_at TEXT,
      result_code TEXT,
      request_json TEXT NOT NULL,
      PRIMARY KEY (team_name, id)
    );
    CREATE TABLE member_work_sync_outbox (
      team_name TEXT NOT NULL,
      id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      agenda_fingerprint TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      delivered_message_id TEXT,
      delivery_state TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      work_sync_intent TEXT NOT NULL,
      work_sync_intent_key TEXT,
      review_request_event_ids_json TEXT,
      delivery_diagnostics_json TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (team_name, id)
    );
    CREATE TABLE member_work_sync_metric_events (
      team_name TEXT NOT NULL,
      id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      member_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (team_name, id)
    );
  `);
}
