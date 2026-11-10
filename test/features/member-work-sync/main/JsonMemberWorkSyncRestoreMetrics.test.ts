import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemberWorkSyncMetricEvent } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStoreSnapshot } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';

const teamName = 'sandbox-metrics';
function event(id: string): MemberWorkSyncMetricEvent {
  return {
    id,
    teamName,
    memberName: 'bob',
    kind: 'status_evaluated',
    state: 'needs_sync',
    agendaFingerprint: 'agenda-1',
    actionableCount: 1,
    recordedAt: '2026-09-10T00:00:00.000Z',
  };
}
function snapshot(metricEvents: MemberWorkSyncMetricEvent[]): MemberWorkSyncStoreSnapshot {
  return { statuses: [], reportIntents: [], outboxItems: [], metricEvents, filesToArchive: [] };
}

describe('JSON replica metric restoration', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  let store: JsonMemberWorkSyncStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-restore-metrics-'));
    paths = new MemberWorkSyncStorePaths(root);
    store = new JsonMemberWorkSyncStore(paths);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('restores nonempty metrics and deduplicates identical replay', async () => {
    const candidate = snapshot([event('replica')]);
    await store.restoreReplicaSnapshot(teamName, candidate);
    const first = await readFile(paths.getMetricsIndexPath(teamName), 'utf8');
    expect((await store.readSnapshotForImport(teamName))?.metricEvents).toEqual(candidate.metricEvents);
    await store.restoreReplicaSnapshot(teamName, candidate);
    expect(await readFile(paths.getMetricsIndexPath(teamName), 'utf8')).toBe(first);
    expect((await store.readSnapshotForImport(teamName))?.metricEvents).toEqual(candidate.metricEvents);
  });

  it('preserves live event identities and gives live duplicate payload precedence', async () => {
    const live = { ...event('shared'), actionableCount: 7 };
    const index = paths.getMetricsIndexPath(teamName);
    await mkdir(dirname(index), { recursive: true });
    await writeFile(index, JSON.stringify({ schemaVersion: 2, members: {}, recentEvents: [live, event('live')] }));
    await store.restoreReplicaSnapshot(teamName, snapshot([event('shared'), event('replica')]));
    expect((await store.readSnapshotForImport(teamName))?.metricEvents).toEqual([
      event('live'), event('replica'), live,
    ]);
  });

  it('preserves the complete restore candidate above normal append retention', async () => {
    const events = Array.from({ length: 205 }, (_, i) => event(`event-${String(i).padStart(3, '0')}`));
    await store.restoreReplicaSnapshot(teamName, snapshot(events));
    expect((await store.readSnapshotForImport(teamName))?.metricEvents).toEqual(events);
    await store.restoreReplicaSnapshot(teamName, snapshot(events));
    expect((await store.readSnapshotForImport(teamName))?.metricEvents).toEqual(events);
  });
});
