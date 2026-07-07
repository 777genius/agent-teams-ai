import Database from 'better-sqlite3-node';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

import type {
  MemberWorkSyncNudgePayload,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';

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

type StoreKind = 'json' | 'sqlite';

interface Harness {
  store: JsonMemberWorkSyncStore | SqliteMemberWorkSyncStore;
  jsonStore: JsonMemberWorkSyncStore;
  core: InternalStorageWorkerCore | null;
  root: string;
}

describe('SqliteMemberWorkSyncStore', () => {
  const cleanups: (() => Promise<void>)[] = [];

  async function makeHarness(kind: StoreKind): Promise<Harness> {
    const root = await mkdtemp(join(tmpdir(), `mws-${kind}-`));
    const paths = new MemberWorkSyncStorePaths(root);
    const jsonStore = new JsonMemberWorkSyncStore(paths);
    let core: InternalStorageWorkerCore | null = null;
    let store: Harness['store'] = jsonStore;
    if (kind === 'sqlite') {
      core = new InternalStorageWorkerCore({
        databasePath: join(root, 'storage', 'app.db'),
        createDatabase: (file) => new Database(file),
      });
      const gateway = new InProcessGateway(core);
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
    return { store, jsonStore, core, root };
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
