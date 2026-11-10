import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import {
  handleMemberWorkSyncOp,
  MemberWorkSyncWorkerOps,
} from '@features/internal-storage/main/infrastructure/worker/memberWorkSyncWorkerOps';
import Database from 'better-sqlite3-node';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncStatusCompareAndWriteResult,
  MemberWorkSyncStatusRecord,
} from '@features/internal-storage/contracts/internalStorageContracts';

describe('member work sync SQLite status CAS', () => {
  let root: string;
  let databases: InstanceType<typeof Database>[];
  let ops: MemberWorkSyncWorkerOps;

  function connect(): MemberWorkSyncWorkerOps {
    const database = new Database(join(root, 'sandbox.sqlite'));
    databases.push(database);
    runInternalStorageMigrations(database);
    const orm = drizzle(database);
    return new MemberWorkSyncWorkerOps(() => orm);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-status-cas-'));
    databases = [];
    ops = connect();
  });

  afterEach(async () => {
    for (const database of databases) database.close();
    await rm(root, { recursive: true, force: true });
  });

  function record(statusJson: string, memberKey = 'alice'): MemberWorkSyncStatusRecord {
    return {
      teamName: 'sandbox',
      memberKey,
      memberName: memberKey,
      state: 'needs_sync',
      evaluatedAt: '2026-09-10T00:00:00.000Z',
      providerId: null,
      statusJson,
    };
  }

  function metric(id: string): MemberWorkSyncMetricEventRecord {
    return {
      teamName: 'sandbox',
      memberKey: 'alice',
      memberName: 'alice',
      id,
      kind: 'report_accepted',
      recordedAt: '2026-09-10T00:00:00.000Z',
      eventJson: '{}',
    };
  }

  function commit(
    expectedStatusJson: string | null,
    statusJson: string,
    events: MemberWorkSyncMetricEventRecord[] = []
  ): MemberWorkSyncStatusCompareAndWriteResult {
    return handleMemberWorkSyncOp(ops, 'mws.status.compareAndWrite', {
      expectedStatusJson,
      record: record(statusJson),
      events,
    }) as MemberWorkSyncStatusCompareAndWriteResult;
  }

  it('allows one initial insert and no accepted metric from the losing writer', () => {
    expect(commit(null, '{"revision":1}', [metric('first')]).committed).toBe(true);
    expect(commit(null, '{"revision":2}', [metric('loser')])).toEqual({
      committed: false,
      current: record('{"revision":1}'),
    });
    expect(ops.metricEventsList('sandbox').map((event) => event.id)).toEqual(['first']);
  });

  it('compares raw bytes and keeps a different member independent', () => {
    const raw = '{ "memberName": " Alice ", "revision": 1 }';
    expect(commit(null, raw).committed).toBe(true);
    expect(commit(JSON.stringify(JSON.parse(raw)), '{"revision":2}').committed).toBe(false);
    expect(
      ops.statusCompareAndWrite({
        expectedStatusJson: null,
        record: record('{}', 'bob'),
        events: [],
      }).committed
    ).toBe(true);
    expect(commit(raw, '{"revision":2}').committed).toBe(true);
    expect(ops.statusRead('sandbox', 'bob')?.statusJson).toBe('{}');
  });

  it('rejects a stale snapshot from a second connection even after domain fields return to A', () => {
    const first = '{"state":"A","nonce":"one"}';
    commit(null, first);
    const competitor = connect();
    const stale = competitor.statusRead('sandbox', 'alice')!;
    commit(first, '{"state":"B","nonce":"two"}');
    const latest = '{"state":"A","nonce":"three"}';
    commit('{"state":"B","nonce":"two"}', latest);
    expect(
      competitor.statusCompareAndWrite({
        expectedStatusJson: stale.statusJson,
        record: record('{"state":"stale"}'),
        events: [metric('stale')],
      })
    ).toEqual({
      committed: false,
      current: record(latest),
    });
    expect(ops.metricEventsList('sandbox')).toEqual([]);
  });

  it('does not reinterpret a corrupt existing row as an absent status', () => {
    ops.statusWrite(record('{broken'), []);
    expect(commit(null, '{}')).toEqual({ committed: false, current: record('{broken') });
  });

  it('returns absent conflict for an update after deletion without inserting a replacement', () => {
    commit(null, '{"revision":1}');
    databases[0].exec('DELETE FROM member_work_sync_status');
    expect(commit('{"revision":1}', '{"revision":2}')).toEqual({ committed: false, current: null });
    expect(ops.statusRead('sandbox', 'alice')).toBeNull();
  });

  it('rolls status and metrics back together when a metric write fails', () => {
    commit(null, '{"revision":1}', [metric('before')]);
    databases[0].exec(
      "CREATE TRIGGER fail_metric BEFORE INSERT ON member_work_sync_metric_events BEGIN SELECT RAISE(ABORT, 'test metric fault'); END"
    );
    expect(() => commit('{"revision":1}', '{"revision":2}', [metric('after')])).toThrow(
      'test metric fault'
    );
    expect(ops.statusRead('sandbox', 'alice')?.statusJson).toBe('{"revision":1}');
    expect(ops.metricEventsList('sandbox').map((event) => event.id)).toEqual(['before']);
    databases[0].exec('DROP TRIGGER fail_metric');
    expect(commit('{"revision":1}', '{"revision":2}', [metric('after')]).committed).toBe(true);
  });
});
