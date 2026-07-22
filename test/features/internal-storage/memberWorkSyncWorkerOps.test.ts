import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { MemberWorkSyncWorkerOps } from '@features/internal-storage/main/infrastructure/worker/memberWorkSyncWorkerOps';
import Database from 'better-sqlite3-node';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncTeamSnapshotRecords,
} from '@features/internal-storage/contracts/internalStorageContracts';

const TEAM_NAME = 'team-a';
const ITEM_ID = 'member-work-sync:team-a:bob:agenda:v1:abc';
const CREATED_AT = '2026-07-17T09:00:00.000Z';
const CLAIMED_AT = '2026-07-17T09:01:00.000Z';

function makeOutboxRecord(): MemberWorkSyncOutboxItemRecord {
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
});
