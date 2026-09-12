import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeyedMutex } from '@features/internal-storage/main';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import {
  finalizeMemberWorkSyncAgenda,
  MemberWorkSyncReconciler,
} from '@features/member-work-sync/core/application/MemberWorkSyncReconciler';
import { MemberWorkSyncReporter } from '@features/member-work-sync/core/application/MemberWorkSyncReporter';
import {
  buildMemberWorkSyncReportRequestDigest,
  createMemberWorkSyncReportJournalInput,
} from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalProtocol';
import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { createAdmittedMemberWorkSyncStatusPort } from '@features/member-work-sync/main/composition/createAdmittedMemberWorkSyncStatusPort';
import { BackendSelectingMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncStore';
import {
  buildPendingReportIntentId,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { MemberWorkSyncStatusAuthority } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

import type {
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncReportJournalPort } from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalPort';
import type {
  MemberWorkSyncAgendaSourceResult,
  MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application/ports';
import type { MemberWorkSyncStatusAuthorityDeps } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';

const member = { teamName: 'sandbox', memberName: 'alice' };
const incarnation = 'inc-journal';
const initialTime = '2026-09-10T00:00:00.000Z';
const roots: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(kind: 'json' | 'sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'mws-reporter-journal-'));
  roots.push(root);
  const databasePath = join(root, 'app.db');
  const paths = new MemberWorkSyncStorePaths(join(root, 'teams'));
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
  cores.push(core);
  const gateway = new InProcessGateway(core);
  const selector = new InternalStorageBackendSelector(() =>
    kind === 'sqlite'
      ? Promise.resolve({
          driver: 'better-sqlite3',
          databasePath,
          schemaVersion: 4,
          integrity: 'ok',
        })
      : Promise.reject(new Error('test JSON backend'))
  );
  const json = new JsonMemberWorkSyncStore(paths);
  const sqlite = new SqliteMemberWorkSyncStore({
    gateway,
    buildReportIntentId: buildPendingReportIntentId,
    importer: new MemberWorkSyncSqliteImporter({ gateway, jsonStore: json }),
  });
  const store = new BackendSelectingMemberWorkSyncStore(selector, sqlite, json, {
    gateway,
    paths,
    fallbackRequiresReplica: false,
  });
  const mutex = new KeyedMutex();
  const identity: MemberWorkSyncStatusAuthorityDeps['identity'] = {
    readCurrent: async () => ({ status: 'identified', identityId: incarnation }),
    adoptLegacy: async () => ({ status: 'identified', identityId: incarnation }),
    withCurrent: async (_team, expected, operation) =>
      mutex.run(member.teamName, async () =>
        expected === incarnation
          ? { current: true, value: await operation() }
          : { current: false, identity: { status: 'identified', identityId: incarnation } }
      ),
  };
  const authority = new MemberWorkSyncStatusAuthority({
    identity,
    withPreparedBackend: (id, operation) => store.withPreparedBackend(id, operation),
  });
  const gate = new MemberWorkSyncTeamOperationGate();
  let now = initialTime;
  const hash = { sha256Hex: (value: string) => createHash('sha256').update(value).digest('hex') };
  const source: MemberWorkSyncAgendaSourceResult = {
    agenda: {
      ...member,
      generatedAt: initialTime,
      diagnostics: [],
      items: [
        {
          taskId: 'task-1',
          subject: 'Sandbox work',
          kind: 'work',
          assignee: 'alice',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { owner: 'alice', status: 'pending' },
        },
      ],
    },
    activeMemberNames: ['alice'],
    inactive: false,
    diagnostics: [],
    providerId: 'anthropic',
  };
  const reportJournal: MemberWorkSyncReportJournalPort =
    kind === 'sqlite' ? sqlite.createReportJournal() : json.createReportJournal();
  const deps: MemberWorkSyncUseCaseDeps = {
    clock: { now: () => new Date(now) },
    hash,
    agendaSource: { loadAgenda: vi.fn(async () => structuredClone(source)) },
    statusStore: {
      read: () => {
        throw new Error('blind read forbidden');
      },
      write: () => {
        throw new Error('blind write forbidden');
      },
    },
    reportJournal,
    reportToken: {
      create: async () => ({ token: 'test-token', expiresAt: '2026-09-10T01:00:00.000Z' }),
      verify: async () => ({ ok: true }),
    },
  };
  const initial: MemberWorkSyncStatus = {
    ...member,
    state: 'needs_sync',
    evaluatedAt: initialTime,
    diagnostics: [],
    agenda: finalizeMemberWorkSyncAgenda(deps, source),
    statusRevision: { incarnation, lineageId: 'lineage', sequence: 10, nonce: 'initial' },
  };
  await json.write(initial);
  const run = <T>(operation: (bound: MemberWorkSyncUseCaseDeps) => Promise<T>) =>
    gate.run(member.teamName, (admission) =>
      operation({
        ...deps,
        statusMutations: createAdmittedMemberWorkSyncStatusPort({
          teamName: member.teamName,
          admission,
          authority,
        }),
      })
    );
  const read = () =>
    run(async (bound) => {
      const result = await bound.statusMutations!.readSnapshot(member);
      if (!result.ok || !result.snapshot.status) throw new Error('read failed');
      return result.snapshot.status;
    });
  const request: MemberWorkSyncReportRequest = {
    ...member,
    state: 'still_working',
    agendaFingerprint: initial.agenda.fingerprint,
    taskIds: ['task-1'],
    reportToken: 'test-token',
    note: 'accepted I1',
  };
  return {
    hash,
    reportJournal,
    request,
    run,
    read,
    setTime: (time: string) => {
      now = time;
    },
  };
}

describe.each(['json', 'sqlite'] as const)(
  'reporter journal protocol on real %s storage',
  (kind) => {
    it('transfers I1 before I2 and replays I1 without renewing the current lease', async () => {
      const h = await setup(kind);
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      expect(first.accepted).toBe(true);
      const i1 = first.status.pendingReportReceipt;
      expect(i1?.intentId).toBeTruthy();
      h.setTime('2026-09-10T00:01:00.000Z');
      const second = await h.run((deps) =>
        new MemberWorkSyncReporter(deps).execute({ ...h.request, note: 'accepted I2' })
      );
      expect(second.accepted).toBe(true);
      const i2 = second.status.pendingReportReceipt;
      expect(i2?.intentId).toBeTruthy();
      expect(i2?.intentId).not.toBe(i1?.intentId);
      expect(second.status.lastAcceptedReport?.note).toBe('accepted I2');
      const replayed = await h.run((deps) =>
        new MemberWorkSyncReporter(deps).execute(h.request, {
          intentId: i1!.intentId,
          incarnation,
          requestDigest: i1!.requestDigest,
          receivedAt: i1!.acceptedAt,
          origin: 'online',
        })
      );
      expect(replayed.accepted).toBe(true);
      expect(replayed.status.pendingReportReceipt?.intentId).toBe(i2?.intentId);
      expect(replayed.status.lastAcceptedReport?.note).toBe('accepted I2');
      expect(replayed.status.lastAcceptedReport?.expiresAt).toBe(
        second.status.lastAcceptedReport?.expiresAt
      );
    });

    it('does not let an older pending I1 replay replace a newer accepted I2', async () => {
      const h = await setup(kind);
      const i1 = createMemberWorkSyncReportJournalInput({
        request: h.request,
        incarnation,
        receivedAt: initialTime,
        hash: h.hash,
      });
      expect((await h.reportJournal.ensure(i1)).state).toBe('present');
      expect((await h.read()).lastAcceptedReport).toBeUndefined();

      h.setTime('2026-09-10T00:01:00.000Z');
      const second = await h.run((deps) =>
        new MemberWorkSyncReporter(deps).execute({ ...h.request, note: 'accepted I2' })
      );
      expect(second.accepted).toBe(true);
      expect(second.status.lastAcceptedReport?.note).toBe('accepted I2');
      const i2 = second.status.pendingReportReceipt;
      expect(i2?.intentId).toBeTruthy();
      expect(i2?.intentId).not.toBe(i1.intentId);

      const replayed = await h.run((deps) =>
        new MemberWorkSyncReporter(deps).execute(h.request, {
          intentId: i1.intentId,
          incarnation,
          requestDigest: i1.requestDigest,
          receivedAt: i1.receivedAt,
          origin: 'online',
        })
      );
      expect(replayed.accepted).toBe(false);
      expect(replayed.code).toBe('superseded');
      expect(replayed.status.pendingReportReceipt?.intentId).toBe(i2?.intentId);
      expect(replayed.status.lastAcceptedReport?.note).toBe('accepted I2');
      expect(replayed.status.lastAcceptedReport?.expiresAt).toBe(
        second.status.lastAcceptedReport?.expiresAt
      );
      expect((await h.read()).lastAcceptedReport?.note).toBe('accepted I2');
    });

    it('reuses a digest-stable intent ID when the same online report is retried', async () => {
      const h = await setup(kind);
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      const second = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(true);
      expect(first.status.pendingReportReceipt?.intentId).toMatch(/^report:/);
      expect(second.status.pendingReportReceipt?.intentId).toBe(
        first.status.pendingReportReceipt?.intentId
      );
      expect(second.status.lastAcceptedReport?.expiresAt).toBe(
        first.status.lastAcceptedReport?.expiresAt
      );
    });

    it('allocates a new online report intent when a later heartbeat repeats the same payload', async () => {
      const h = await setup(kind);
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      h.setTime('2026-09-10T00:10:00.000Z');
      const second = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      expect(second.accepted).toBe(true);
      expect(second.status.pendingReportReceipt?.intentId).not.toBe(
        first.status.pendingReportReceipt?.intentId
      );
      expect(Date.parse(second.status.lastAcceptedReport?.expiresAt ?? '')).toBeGreaterThan(
        Date.parse(first.status.lastAcceptedReport?.expiresAt ?? '')
      );
    });

    it('repairs a checkpoint-backed replay after the live token expires without renewing the lease', async () => {
      const h = await setup(kind);
      vi.spyOn(h.reportJournal, 'transfer').mockResolvedValueOnce({ state: 'unavailable' });
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      expect(first.accepted).toBe(true);
      expect(first.projectionDegraded).toBe(true);
      const checkpoint = first.status.pendingReportReceipt!;
      h.setTime('2026-09-10T00:20:00.000Z');
      const replayed = await h.run((deps) =>
        new MemberWorkSyncReporter({
          ...deps,
          reportToken: {
            create: deps.reportToken!.create,
            verify: async () => ({ ok: false, reason: 'expired' }),
          },
        }).execute(h.request, {
          intentId: checkpoint.intentId,
          incarnation,
          requestDigest: checkpoint.requestDigest,
          receivedAt: checkpoint.acceptedAt,
          origin: 'online',
        })
      );
      expect(replayed.accepted).toBe(true);
      expect(replayed.status.pendingReportReceipt?.intentId).toBe(checkpoint.intentId);
      expect(replayed.status.lastAcceptedReport?.expiresAt).toBe(
        first.status.lastAcceptedReport?.expiresAt
      );
    });

    it('keeps the I1 checkpoint when transfer is unknown and later accepts I2', async () => {
      const h = await setup(kind);
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      const i1 = first.status.pendingReportReceipt!;
      const transfer = vi.spyOn(h.reportJournal, 'transfer').mockImplementationOnce(async () => ({
        state: 'commit_unknown',
      }));
      h.setTime('2026-09-10T00:01:00.000Z');
      await expect(
        h.run((deps) =>
          new MemberWorkSyncReporter(deps).execute({ ...h.request, note: 'accepted I2' })
        )
      ).rejects.toMatchObject({ reason: 'unavailable' });
      expect((await h.read()).pendingReportReceipt?.intentId).toBe(i1.intentId);
      transfer.mockRestore();
      const recovered = await h.run((deps) =>
        new MemberWorkSyncReporter(deps).execute({ ...h.request, note: 'accepted I2' })
      );
      expect(recovered.accepted).toBe(true);
      expect(recovered.status.pendingReportReceipt?.intentId).not.toBe(i1.intentId);
    });

    it('rejects the same intent id with a different digest without writing I2', async () => {
      const h = await setup(kind);
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      const i1 = first.status.pendingReportReceipt!;
      const otherRequest = { ...h.request, note: 'forged digest' };
      await expect(
        h.run((deps) =>
          new MemberWorkSyncReporter(deps).execute(otherRequest, {
            intentId: i1.intentId,
            incarnation,
            requestDigest: buildMemberWorkSyncReportRequestDigest(h.hash, otherRequest),
            receivedAt: i1.acceptedAt,
            origin: 'online',
          })
        )
      ).rejects.toMatchObject({ reason: 'conflict' });
      expect((await h.read()).pendingReportReceipt?.intentId).toBe(i1.intentId);
    });

    it('preserves a reconcile between I1 transfer and I2 CAS', async () => {
      const h = await setup(kind);
      await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      const original = h.reportJournal.ensure.bind(h.reportJournal);
      vi.spyOn(h.reportJournal, 'ensure').mockImplementationOnce(async (input) => {
        await h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member));
        return original(input);
      });
      h.setTime('2026-09-10T00:01:00.000Z');
      const second = await h.run((deps) =>
        new MemberWorkSyncReporter(deps).execute({ ...h.request, note: 'accepted I2' })
      );
      expect(second.accepted).toBe(true);
      expect(second.status.lastAcceptedReport?.note).toBe('accepted I2');
    });

    it('marks projection degraded when post-commit transfer fails after I1 is accepted', async () => {
      const h = await setup(kind);
      vi.spyOn(h.reportJournal, 'transfer').mockResolvedValue({ state: 'unavailable' });
      const first = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      expect(first.accepted).toBe(true);
      expect(first.projectionDegraded).toBe(true);
      expect(first.status.pendingReportReceipt?.intentId).toBeTruthy();
    });
  }
);
