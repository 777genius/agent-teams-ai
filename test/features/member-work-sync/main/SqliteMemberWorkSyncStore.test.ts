import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { snapshotToRecords } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

import type {
  MemberWorkSyncMetricEvent,
  MemberWorkSyncNudgePayload,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStoreSnapshot } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';

const T0 = '2026-07-07T10:00:00.000Z';
const T1 = '2026-07-07T10:01:00.000Z';
const T2 = '2026-07-07T10:02:00.000Z';
const STALE = '2026-07-07T10:07:00.000Z'; // 6 minutes after T1

function makeStatus(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: T0,
      fingerprint: 'agenda:v1:abc',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Ship UI',
          kind: 'work',
          assignee: 'bob',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'bob' },
        },
      ],
      diagnostics: [],
    },
    shadow: { reconciledBy: 'queue', wouldNudge: true, fingerprintChanged: false },
    evaluatedAt: T0,
    diagnostics: [],
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<MemberWorkSyncNudgePayload> = {}
): MemberWorkSyncNudgePayload {
  return {
    from: 'system',
    to: 'bob',
    messageKind: 'member_work_sync_nudge',
    source: 'member-work-sync',
    actionMode: 'do',
    workSyncIntent: 'agenda_sync',
    text: 'Work sync check: continue the current task or report a blocker.',
    taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
    ...overrides,
  };
}

function makeReportRequest(
  overrides: Partial<MemberWorkSyncReportRequest> = {}
): MemberWorkSyncReportRequest {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'caught_up',
    agendaFingerprint: 'agenda:v1:abc',
    ...overrides,
  };
}

function makeMemberStatus(
  memberName: string,
  overrides: Partial<MemberWorkSyncStatus> = {}
): MemberWorkSyncStatus {
  const base = makeStatus();
  return makeStatus({
    memberName,
    agenda: { ...base.agenda, memberName },
    ...overrides,
  });
}

function makeReportIntent(
  id: string,
  memberName: string,
  reason = `reason:${id}`
): MemberWorkSyncReportIntent {
  return {
    id,
    teamName: 'team-a',
    memberName,
    request: makeReportRequest({ memberName }),
    reason,
    status: 'pending',
    recordedAt: T0,
  };
}

function makeOutboxItem(
  id: string,
  memberName: string,
  payloadHash = `hash:${id}`
): MemberWorkSyncOutboxItem {
  return {
    id,
    teamName: 'team-a',
    memberName,
    agendaFingerprint: 'agenda:v1:abc',
    payloadHash,
    payload: makePayload({ to: memberName }),
    status: 'pending',
    attemptGeneration: 0,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeMetricEvent(
  id: string,
  memberName: string,
  actionableCount = 1
): MemberWorkSyncMetricEvent {
  return {
    id,
    teamName: 'team-a',
    memberName,
    kind: 'status_evaluated',
    state: 'needs_sync',
    agendaFingerprint: 'agenda:v1:abc',
    recordedAt: T0,
    actionableCount,
  };
}

function makeImportSnapshot(
  input: Omit<MemberWorkSyncStoreSnapshot, 'filesToArchive'> & { filesToArchive?: string[] }
): MemberWorkSyncStoreSnapshot {
  return { ...input, filesToArchive: input.filesToArchive ?? [] };
}

type StoreKind = 'json' | 'sqlite';

interface Harness {
  store: JsonMemberWorkSyncStore | SqliteMemberWorkSyncStore;
  jsonStore: JsonMemberWorkSyncStore;
  core: InternalStorageWorkerCore | null;
  gateway: InProcessGateway | null;
  root: string;
}

describe('SqliteMemberWorkSyncStore', () => {
  const cleanups: (() => Promise<void>)[] = [];

  async function makeHarness(kind: StoreKind): Promise<Harness> {
    const root = await mkdtemp(join(tmpdir(), `mws-${kind}-`));
    const paths = new MemberWorkSyncStorePaths(root);
    const jsonStore = new JsonMemberWorkSyncStore(paths);
    let core: InternalStorageWorkerCore | null = null;
    let gateway: InProcessGateway | null = null;
    let store: Harness['store'] = jsonStore;
    if (kind === 'sqlite') {
      core = new InternalStorageWorkerCore({
        databasePath: join(root, 'storage', 'app.db'),
        createDatabase: (file) => new Database(file),
      });
      gateway = new InProcessGateway(core);
      store = new SqliteMemberWorkSyncStore({
        gateway,
        importer: new MemberWorkSyncSqliteImporter({ gateway, jsonStore }),
        buildReportIntentId: buildPendingReportIntentId,
      });
    }
    cleanups.push(async () => {
      try {
        core?.close();
      } catch {
        // already closed
      }
      await rm(root, { recursive: true, force: true });
    });
    return { store, jsonStore, core, gateway, root };
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  // The same behavioral scenarios run against both backends — the sqlite
  // store must be indistinguishable from the JSON store for the use cases.
  describe.each<StoreKind>(['json', 'sqlite'])('behavior parity (%s)', (kind) => {
    it('runs the ensure -> claim -> deliver lifecycle with generation guards', async () => {
      const { store } = await makeHarness(kind);
      const ensured = await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload(),
        nowIso: T0,
      });
      expect(ensured.ok && ensured.outcome === 'created').toBe(true);

      const claimed = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'dispatcher-1',
        nowIso: T1,
        limit: 5,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0].status).toBe('claimed');
      expect(claimed[0].attemptGeneration).toBe(1);

      // A stale generation must not win the delivery race.
      await store.markDelivered({
        teamName: 'team-a',
        id: 'nudge-1',
        attemptGeneration: 99,
        deliveredMessageId: 'msg-wrong',
        nowIso: T1,
      });
      const second = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'dispatcher-2',
        nowIso: STALE,
        limit: 5,
      });
      expect(second).toHaveLength(1);
      expect(second[0].attemptGeneration).toBe(2);

      await store.markDelivered({
        teamName: 'team-a',
        id: 'nudge-1',
        attemptGeneration: 2,
        deliveredMessageId: 'msg-1',
        deliveryState: 'inbox_persisted',
        nowIso: STALE,
      });
      const after = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'dispatcher-3',
        nowIso: '2026-07-07T11:00:00.000Z',
        limit: 5,
      });
      expect(after).toHaveLength(0);
      expect(
        await store.countRecentDelivered({ teamName: 'team-a', memberName: 'bob', sinceIso: T0 })
      ).toBe(1);
    });

    it('resets a pending item when the payload hash changes and conflicts on delivered', async () => {
      const { store } = await makeHarness(kind);
      await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload(),
        nowIso: T0,
      });

      const reset = await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v2:def',
        payloadHash: 'hash-2',
        payload: makePayload({ text: 'updated' }),
        nowIso: T1,
      });
      expect(reset.ok && reset.outcome === 'existing').toBe(true);
      if (reset.ok) {
        expect(reset.item.payloadHash).toBe('hash-2');
        expect(reset.item.status).toBe('pending');
      }

      const [claimedItem] = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'd',
        nowIso: T1,
        limit: 1,
      });
      await store.markDelivered({
        teamName: 'team-a',
        id: 'nudge-1',
        attemptGeneration: claimedItem.attemptGeneration,
        deliveredMessageId: 'msg-1',
        nowIso: T2,
      });

      const conflict = await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v3:xyz',
        payloadHash: 'hash-3',
        payload: makePayload({ text: 'newer' }),
        nowIso: T2,
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) {
        expect(conflict.outcome).toBe('payload_conflict');
        expect(conflict.existingPayloadHash).toBe('hash-2');
        expect(conflict.requestedPayloadHash).toBe('hash-3');
      }
    });

    it('revives a superseded item with the same payload hash', async () => {
      const { store } = await makeHarness(kind);
      await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload(),
        nowIso: T0,
      });
      await store.markSuperseded({
        teamName: 'team-a',
        id: 'nudge-1',
        reason: 'agenda changed',
        nowIso: T1,
      });

      const revived = await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload(),
        nowIso: T2,
      });
      expect(revived.ok && revived.item.status === 'pending').toBe(true);
    });

    it('defers retryable failures until nextAttemptAt is due', async () => {
      const { store } = await makeHarness(kind);
      await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload(),
        nowIso: T0,
      });
      const [claimedItem] = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'd',
        nowIso: T0,
        limit: 1,
      });
      await store.markFailed({
        teamName: 'team-a',
        id: 'nudge-1',
        attemptGeneration: claimedItem.attemptGeneration,
        error: 'wake failed',
        retryable: true,
        nextAttemptAt: T2,
        nowIso: T1,
      });

      expect(
        await store.claimDue({ teamName: 'team-a', claimedBy: 'd', nowIso: T1, limit: 5 })
      ).toHaveLength(0);
      const retried = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'd',
        nowIso: T2,
        limit: 5,
      });
      expect(retried).toHaveLength(1);
      expect(retried[0].attemptGeneration).toBe(2);
    });

    it('keeps report intents idempotent across append/list/markProcessed', async () => {
      const { store } = await makeHarness(kind);
      const request = makeReportRequest();
      await store.appendPendingReport?.(request, 'agenda_mismatch');
      await store.appendPendingReport?.(request, 'other reason');

      const pending = await store.listPendingReports?.('team-a');
      expect(pending).toHaveLength(1);
      expect(pending?.[0].reason).toBe('agenda_mismatch');

      const id = pending?.[0].id ?? '';
      await store.markPendingReportProcessed?.('team-a', id, {
        status: 'accepted',
        resultCode: 'ok',
        processedAt: T1,
      });
      expect(await store.listPendingReports?.('team-a')).toHaveLength(0);

      // Re-appending the identical request after processing stays a no-op.
      await store.appendPendingReport?.(request, 'agenda_mismatch');
      expect(await store.listPendingReports?.('team-a')).toHaveLength(0);
    });

    it('writes statuses and aggregates team metrics identically', async () => {
      const { store } = await makeHarness(kind);
      await store.write(makeStatus({ providerId: 'opencode' }));
      await store.write(
        makeStatus({
          memberName: 'alice',
          state: 'caught_up',
          agenda: { ...makeStatus().agenda, memberName: 'alice', items: [] },
        })
      );

      const bob = await store.read({ teamName: 'team-a', memberName: 'bob' });
      expect(bob?.state).toBe('needs_sync');
      expect(bob?.providerId).toBe('opencode');

      const metrics = await store.readTeamMetrics?.('team-a');
      expect(metrics?.memberCount).toBe(2);
      expect(metrics?.stateCounts.needs_sync).toBe(1);
      expect(metrics?.stateCounts.caught_up).toBe(1);
      expect(metrics?.actionableItemCount).toBe(1);
      expect(metrics?.wouldNudgeCount).toBeGreaterThanOrEqual(1);
    });

    it('answers agenda counts and recovery lookups with exact since semantics', async () => {
      const { store } = await makeHarness(kind);
      await store.ensurePending({
        id: 'nudge-1',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload({ workSyncIntentKey: 'intent:task-1' }),
        nowIso: T0,
      });
      const [claimedItem] = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'd',
        nowIso: T0,
        limit: 1,
      });
      await store.markDelivered({
        teamName: 'team-a',
        id: 'nudge-1',
        attemptGeneration: claimedItem.attemptGeneration,
        deliveredMessageId: 'msg-1',
        nowIso: T1,
      });

      // countDeliveredForAgenda: strictly greater than sinceIso.
      expect(
        await store.countDeliveredForAgenda?.({
          teamName: 'team-a',
          memberName: 'bob',
          agendaFingerprint: 'agenda:v1:abc',
          sinceIso: T1,
        })
      ).toBe(0);
      expect(
        await store.countDeliveredForAgenda?.({
          teamName: 'team-a',
          memberName: 'bob',
          agendaFingerprint: 'agenda:v1:abc',
          sinceIso: T0,
        })
      ).toBe(1);
      // countRecentDelivered: greater-or-equal.
      expect(
        await store.countRecentDelivered({
          teamName: 'team-a',
          memberName: 'bob',
          sinceIso: T1,
          workSyncIntentKeyPrefix: 'intent:',
        })
      ).toBe(1);

      const recovery = await store.findRecentRecoveryByIntent?.({
        teamName: 'team-a',
        memberName: 'bob',
        intentKey: 'intent:task-1',
        sinceIso: T0,
      });
      expect(recovery?.id).toBe('nudge-1');
      expect(recovery?.status).toBe('delivered');
      expect(recovery?.deliveredMessageId).toBe('msg-1');
    });
  });

  describe('legacy import', () => {
    async function importSnapshot(
      gateway: InProcessGateway,
      snapshot: MemberWorkSyncStoreSnapshot
    ): Promise<void> {
      await new MemberWorkSyncSqliteImporter({
        gateway,
        jsonStore: {
          readSnapshotForImport: () => Promise.resolve(snapshot),
          readArchivedSnapshotForImport: () => Promise.resolve(null),
        },
      }).ensureImported('team-a');
    }

    function requireGateway(gateway: InProcessGateway | null): InProcessGateway {
      if (!gateway) {
        throw new Error('expected sqlite gateway');
      }
      return gateway;
    }

    function twoMemberSnapshot(): MemberWorkSyncStoreSnapshot {
      return makeImportSnapshot({
        statuses: [makeMemberStatus('alice'), makeMemberStatus('bob')],
        reportIntents: [makeReportIntent('report-a', 'alice'), makeReportIntent('report-b', 'bob')],
        outboxItems: [makeOutboxItem('outbox-a', 'alice'), makeOutboxItem('outbox-b', 'bob')],
        metricEvents: [makeMetricEvent('event-a', 'alice'), makeMetricEvent('event-b', 'bob')],
      });
    }

    it('preserves canonical rows missing from an unchanged JSON subset', async () => {
      const harness = await makeHarness('sqlite');
      const gateway = requireGateway(harness.gateway);
      const canonical = twoMemberSnapshot();
      await gateway.importTeam('team-a', snapshotToRecords('team-a', canonical));

      await importSnapshot(
        gateway,
        makeImportSnapshot({
          statuses: [canonical.statuses[1]],
          reportIntents: [canonical.reportIntents[1]],
          outboxItems: [canonical.outboxItems[1]],
          metricEvents: [canonical.metricEvents[1]],
        })
      );

      const result = await gateway.listTeamSnapshot('team-a');
      expect(result.statuses.map((row) => row.memberKey)).toEqual(['alice', 'bob']);
      expect(result.reportIntents.map((row) => row.id)).toEqual(['report-a', 'report-b']);
      expect(result.outboxItems.map((row) => row.id)).toEqual(['outbox-a', 'outbox-b']);
      expect(result.metricEvents.map((row) => row.id)).toEqual(['event-a', 'event-b']);
    });

    it('lets changed JSON identities replace canonical rows without deleting missing identities', async () => {
      const harness = await makeHarness('sqlite');
      const gateway = requireGateway(harness.gateway);
      await gateway.importTeam('team-a', snapshotToRecords('team-a', twoMemberSnapshot()));

      await importSnapshot(
        gateway,
        makeImportSnapshot({
          statuses: [makeMemberStatus('bob', { state: 'caught_up', evaluatedAt: T1 })],
          reportIntents: [makeReportIntent('report-b', 'bob', 'changed-report')],
          outboxItems: [makeOutboxItem('outbox-b', 'bob', 'changed-hash')],
          metricEvents: [makeMetricEvent('event-b', 'bob', 42)],
        })
      );

      const result = await gateway.listTeamSnapshot('team-a');
      expect(result.statuses).toHaveLength(2);
      expect(result.statuses.find((row) => row.memberKey === 'bob')).toMatchObject({
        state: 'caught_up',
        evaluatedAt: T1,
      });
      expect(result.reportIntents).toHaveLength(2);
      expect(result.reportIntents.find((row) => row.id === 'report-b')?.reason).toBe(
        'changed-report'
      );
      expect(result.outboxItems).toHaveLength(2);
      expect(result.outboxItems.find((row) => row.id === 'outbox-b')?.payloadHash).toBe(
        'changed-hash'
      );
      expect(result.metricEvents).toHaveLength(2);
      expect(
        JSON.parse(result.metricEvents.find((row) => row.id === 'event-b')?.eventJson ?? '{}')
      ).toMatchObject({ actionableCount: 42 });
    });

    it('keeps missing rows and adds new rows when changed plus new input has the old count', async () => {
      const harness = await makeHarness('sqlite');
      const gateway = requireGateway(harness.gateway);
      await gateway.importTeam('team-a', snapshotToRecords('team-a', twoMemberSnapshot()));

      await importSnapshot(
        gateway,
        makeImportSnapshot({
          statuses: [
            makeMemberStatus('bob', { state: 'caught_up', evaluatedAt: T1 }),
            makeMemberStatus('carol'),
          ],
          reportIntents: [
            makeReportIntent('report-b', 'bob', 'changed-report'),
            makeReportIntent('report-c', 'carol'),
          ],
          outboxItems: [
            makeOutboxItem('outbox-b', 'bob', 'changed-hash'),
            makeOutboxItem('outbox-c', 'carol'),
          ],
          metricEvents: [
            makeMetricEvent('event-b', 'bob', 42),
            makeMetricEvent('event-c', 'carol'),
          ],
        })
      );

      const result = await gateway.listTeamSnapshot('team-a');
      expect(result.statuses.map((row) => row.memberKey)).toEqual(['alice', 'bob', 'carol']);
      expect(result.reportIntents.map((row) => row.id)).toEqual([
        'report-a',
        'report-b',
        'report-c',
      ]);
      expect(result.outboxItems.map((row) => row.id)).toEqual(['outbox-a', 'outbox-b', 'outbox-c']);
      expect(result.metricEvents.map((row) => row.id)).toEqual(['event-a', 'event-b', 'event-c']);
    });

    it('sorts merged identities and deterministically lets the last duplicate win', async () => {
      const harness = await makeHarness('sqlite');
      const gateway = requireGateway(harness.gateway);

      await importSnapshot(
        gateway,
        makeImportSnapshot({
          statuses: [
            makeMemberStatus('zed'),
            makeMemberStatus('Bob'),
            makeMemberStatus('alpha'),
            makeMemberStatus('bob', { state: 'caught_up', evaluatedAt: T2 }),
          ],
          reportIntents: [
            makeReportIntent('z', 'zed'),
            makeReportIntent('duplicate', 'Bob', 'first'),
            makeReportIntent('a', 'alpha'),
            makeReportIntent('duplicate', 'bob', 'last'),
          ],
          outboxItems: [
            makeOutboxItem('z', 'zed'),
            makeOutboxItem('duplicate', 'Bob', 'first'),
            makeOutboxItem('a', 'alpha'),
            makeOutboxItem('duplicate', 'bob', 'last'),
          ],
          metricEvents: [
            makeMetricEvent('z', 'zed'),
            makeMetricEvent('duplicate', 'Bob', 1),
            makeMetricEvent('a', 'alpha'),
            makeMetricEvent('duplicate', 'bob', 99),
          ],
        })
      );

      const result = await gateway.listTeamSnapshot('team-a');
      expect(result.statuses.map((row) => row.memberKey)).toEqual(['alpha', 'bob', 'zed']);
      expect(result.statuses.find((row) => row.memberKey === 'bob')).toMatchObject({
        memberName: 'bob',
        state: 'caught_up',
        evaluatedAt: T2,
      });
      expect(result.reportIntents.map((row) => row.id)).toEqual(['a', 'duplicate', 'z']);
      expect(result.reportIntents.find((row) => row.id === 'duplicate')?.reason).toBe('last');
      expect(result.outboxItems.map((row) => row.id)).toEqual(['a', 'duplicate', 'z']);
      expect(result.outboxItems.find((row) => row.id === 'duplicate')?.payloadHash).toBe('last');
      expect(result.metricEvents.map((row) => row.id)).toEqual(['a', 'duplicate', 'z']);
      expect(
        JSON.parse(result.metricEvents.find((row) => row.id === 'duplicate')?.eventJson ?? '{}')
      ).toMatchObject({ memberName: 'bob', actionableCount: 99 });
    });

    it('retries a partial archive from the surviving JSON subset without deleting imported rows', async () => {
      const harness = await makeHarness('sqlite');
      const gateway = requireGateway(harness.gateway);
      const archivedFirst = join(harness.root, 'archive-first.json');
      const blockedArchive = join(harness.root, 'archive-blocked.json');
      await writeFile(archivedFirst, '{}');
      await writeFile(blockedArchive, '{}');
      await Promise.all(
        Array.from({ length: 100 }, (_, index) => {
          const suffix = index === 0 ? '.pre-sqlite' : `.pre-sqlite-${index + 1}`;
          return writeFile(`${blockedArchive}${suffix}`, '{}');
        })
      );

      const fullSnapshot = {
        ...twoMemberSnapshot(),
        filesToArchive: [archivedFirst, blockedArchive],
      };
      await expect(importSnapshot(gateway, fullSnapshot)).rejects.toThrow('No free archive slot');
      await expect(readFile(archivedFirst, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(`${archivedFirst}.pre-sqlite`, 'utf8')).toBe('{}');

      await importSnapshot(
        gateway,
        makeImportSnapshot({
          statuses: [
            makeMemberStatus('bob', { state: 'caught_up', evaluatedAt: T1 }),
            makeMemberStatus('carol'),
          ],
          reportIntents: [
            makeReportIntent('report-b', 'bob', 'retry-change'),
            makeReportIntent('report-c', 'carol'),
          ],
          outboxItems: [
            makeOutboxItem('outbox-b', 'bob', 'retry-change'),
            makeOutboxItem('outbox-c', 'carol'),
          ],
          metricEvents: [
            makeMetricEvent('event-b', 'bob', 77),
            makeMetricEvent('event-c', 'carol'),
          ],
        })
      );

      const result = await gateway.listTeamSnapshot('team-a');
      expect(result.statuses.map((row) => row.memberKey)).toEqual(['alice', 'bob', 'carol']);
      expect(result.reportIntents.map((row) => row.id)).toEqual([
        'report-a',
        'report-b',
        'report-c',
      ]);
      expect(result.outboxItems.map((row) => row.id)).toEqual(['outbox-a', 'outbox-b', 'outbox-c']);
      expect(result.metricEvents.map((row) => row.id)).toEqual(['event-a', 'event-b', 'event-c']);
      expect(result.statuses.find((row) => row.memberKey === 'bob')?.state).toBe('caught_up');
      expect(result.reportIntents.find((row) => row.id === 'report-b')?.reason).toBe(
        'retry-change'
      );
      expect(result.outboxItems.find((row) => row.id === 'outbox-b')?.payloadHash).toBe(
        'retry-change'
      );
      expect(
        JSON.parse(result.metricEvents.find((row) => row.id === 'event-b')?.eventJson ?? '{}')
      ).toMatchObject({ actionableCount: 77 });
    });

    it('imports JSON state on first access, verifies it and archives every file', async () => {
      const { store, jsonStore, root } = await makeHarness('sqlite');

      // Seed through the JSON store itself so v2 per-member files + indexes exist.
      await jsonStore.write(makeStatus());
      await jsonStore.appendPendingReport(makeReportRequest(), 'agenda_mismatch');
      await jsonStore.ensurePending({
        id: 'nudge-legacy',
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        payloadHash: 'hash-1',
        payload: makePayload(),
        nowIso: T0,
      });

      const status = await store.read({ teamName: 'team-a', memberName: 'bob' });
      expect(status?.state).toBe('needs_sync');
      expect(await store.listPendingReports?.('team-a')).toHaveLength(1);
      const claimed = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'd',
        nowIso: T1,
        limit: 5,
      });
      expect(claimed.map((item) => item.id)).toEqual(['nudge-legacy']);

      const memberDir = join(
        root,
        'team-a',
        'members',
        encodeURIComponent('bob'),
        '.member-work-sync'
      );
      const entries = await readdir(memberDir);
      expect(entries.some((name) => name.includes('.pre-sqlite'))).toBe(true);
      expect(entries.includes('status.json')).toBe(false);
      expect(entries.includes('outbox.json')).toBe(false);
    });

    it('imports large outboxes in chunks without losing items', async () => {
      const { store, jsonStore } = await makeHarness('sqlite');
      // 450 items span three insert chunks (chunk size 200).
      for (let index = 0; index < 450; index += 1) {
        await jsonStore.ensurePending({
          id: `nudge-${index}`,
          teamName: 'team-a',
          memberName: 'bob',
          agendaFingerprint: 'agenda:v1:abc',
          payloadHash: `hash-${index}`,
          payload: makePayload({ workSyncIntentKey: `intent:${index}` }),
          nowIso: T0,
        });
      }

      const claimed = await store.claimDue({
        teamName: 'team-a',
        claimedBy: 'd',
        nowIso: T1,
        limit: 2000,
      });
      expect(claimed).toHaveLength(450);
    }, 60_000);

    it('excludes foreign-team entries from the import and still verifies', async () => {
      const { store, jsonStore, root } = await makeHarness('sqlite');
      await jsonStore.write(makeStatus());

      // A foreign metric event smuggled into this team's metrics index must
      // not be imported (it would also break the verification read-back).
      const metricsPath = join(root, 'team-a', '.member-work-sync', 'indexes', 'metrics.json');
      const metrics = JSON.parse(await readFile(metricsPath, 'utf8')) as {
        recentEvents: { id: string; teamName: string }[];
      };
      metrics.recentEvents.push({
        id: 'foreign-event',
        teamName: 'other-team',
        memberName: 'mallory',
        kind: 'status_evaluated',
        state: 'unknown',
        agendaFingerprint: 'x',
        recordedAt: T0,
        actionableCount: 0,
      } as never);
      await writeFile(metricsPath, JSON.stringify(metrics, null, 2));

      const status = await store.read({ teamName: 'team-a', memberName: 'bob' });
      expect(status?.state).toBe('needs_sync');
      const metricsAfter = await store.readTeamMetrics?.('team-a');
      expect(metricsAfter?.recentEvents.some((event) => event.id === 'foreign-event')).toBe(false);
    });

    it('serializes concurrent claims so no item is double-claimed', async () => {
      const { store } = await makeHarness('sqlite');
      for (let index = 0; index < 10; index += 1) {
        await store.ensurePending({
          id: `nudge-${index}`,
          teamName: 'team-a',
          memberName: 'bob',
          agendaFingerprint: 'agenda:v1:abc',
          payloadHash: `hash-${index}`,
          payload: makePayload(),
          nowIso: T0,
        });
      }

      const batches = await Promise.all(
        Array.from({ length: 5 }, (_, worker) =>
          store.claimDue({
            teamName: 'team-a',
            claimedBy: `dispatcher-${worker}`,
            nowIso: T1,
            limit: 3,
          })
        )
      );
      const claimedIds = batches.flat().map((item) => item.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.length).toBeLessThanOrEqual(10);
    });
  });
});
