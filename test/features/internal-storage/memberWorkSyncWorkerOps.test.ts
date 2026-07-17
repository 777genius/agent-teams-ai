import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import { MemberWorkSyncWorkerOps } from '@features/internal-storage/main/infrastructure/worker/memberWorkSyncWorkerOps';
import Database from 'better-sqlite3-node';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemberWorkSyncOutboxItemRecord } from '@features/internal-storage/contracts/internalStorageContracts';

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
});
