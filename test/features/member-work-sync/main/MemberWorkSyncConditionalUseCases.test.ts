import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InternalStorageOperationInterruptedError,
  KeyedMutex,
} from '@features/internal-storage/main';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { MemberWorkSyncNudgeOutboxPlanner } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanner';
import { hasActiveAcceptedWorkLease } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeRecoveryPolicy';
import {
  finalizeMemberWorkSyncAgenda,
  MemberWorkSyncReconciler,
} from '@features/member-work-sync/core/application/MemberWorkSyncReconciler';
import { MemberWorkSyncReporter } from '@features/member-work-sync/core/application/MemberWorkSyncReporter';
import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { createAdmittedMemberWorkSyncStatusPort } from '@features/member-work-sync/main/composition/createAdmittedMemberWorkSyncStatusPort';
import { getAcceptedWorkLeaseStaleness } from '@features/member-work-sync/main/composition/memberWorkSyncStatusRefreshPolicy';
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
import type {
  MemberWorkSyncAgendaSourceResult,
  MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application/ports';
import type { MemberWorkSyncStatusAuthorityDeps } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';

const member = { teamName: 'sandbox', memberName: 'alice' };
const incarnation = 'inc-conditional';
const initialTime = '2026-09-10T00:00:00.000Z';
const roots: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(kind: 'json' | 'sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'mws-usecase-sandbox-'));
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
  // Lifecycle owner is controlled here; preparation, raw CAS and worker handlers are production.
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
  const deps: MemberWorkSyncUseCaseDeps = {
    clock: { now: () => new Date(now) },
    hash: { sha256Hex: (value) => createHash('sha256').update(value).digest('hex') },
    agendaSource: { loadAgenda: vi.fn(async () => structuredClone(source)) },
    statusStore: {
      read: () => {
        throw new Error('blind read forbidden');
      },
      write: () => {
        throw new Error('blind write forbidden');
      },
    },
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
  Object.assign(initial, { independentEvidence: { intentId: 'retained', stopped: true } });
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
    note: 'accepted B',
  };
  return {
    source,
    deps,
    json,
    sqlite,
    store,
    authority,
    gate,
    initial,
    run,
    read,
    request,
    setTime: (time: string) => {
      now = time;
    },
  };
}

describe.each(['json', 'sqlite'] as const)('conditional use cases on real %s storage', (kind) => {
  it('recomputes stale reconcile and preserves the concurrent accepted report', async () => {
    const h = await setup(kind);
    const reached = deferred();
    const release = deferred();
    const start = h.authority.startCompareAndWrite.bind(h.authority);
    const attempts: string[] = [];
    vi.spyOn(h.authority, 'startCompareAndWrite').mockImplementation((input) => {
      attempts.push(input.mutationId);
      return start(input);
    });
    const planned = vi.spyOn(MemberWorkSyncNudgeOutboxPlanner.prototype, 'plan');
    const reconcile = h.run(async (deps) => {
      let reads = 0;
      const port = deps.statusMutations!;
      const statusMutations = {
        ...port,
        readSnapshot: async (input: typeof member) => {
          const result = await port.readSnapshot(input);
          if (++reads === 1) {
            reached.resolve();
            await release.promise;
          }
          return result;
        },
      };
      return new MemberWorkSyncReconciler({ ...deps, statusMutations }).execute(member);
    });
    let accepted!: Awaited<ReturnType<MemberWorkSyncReporter['execute']>>;
    try {
      await reached.promise;
      h.setTime('2026-09-10T00:01:00.000Z');
      accepted = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
      expect(accepted.accepted).toBe(true);
      expect(accepted.status.statusRevision?.sequence).toBe(11);
      expect(planned).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    const result = await reconcile;
    expect(result.state).toBe('still_working');
    expect(result.lastAcceptedReport).toEqual(accepted.status.lastAcceptedReport);
    expect(result.report).toEqual(accepted.status.report);
    expect(result.statusRevision?.sequence).toBe(12);
    expect(result).toMatchObject({ independentEvidence: { intentId: 'retained', stopped: true } });
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toBe(attempts[2]);
    expect(attempts[0]).not.toBe(attempts[1]);
    expect(h.deps.agendaSource.loadAgenda).toHaveBeenCalledTimes(3);
    expect(planned).toHaveBeenCalledTimes(1);
    const persisted = await h.read();
    expect(persisted).toEqual(result);
    const metrics = await h.store.readTeamMetrics(member.teamName);
    expect(metrics.recentEvents.filter((event) => event.kind === 'report_accepted')).toHaveLength(
      1
    );
  });

  it('records durable attention without allocating a recovery reservation', async () => {
    const h = await setup(kind);
    const first = await h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member));
    expect(first.recoveryHealth?.episodes[0]?.phase).toBe('observing');
    expect(first.recoveryHealth?.unresolvedIntentId).toBeUndefined();
    h.setTime('2026-09-10T00:20:00.000Z');
    const later = await h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member));
    expect(later.recoveryHealth?.episodes[0]?.phase).toBe('attention');
    expect(later.recoveryHealth?.episodes[0]?.firstObservedAt).toBe(
      first.recoveryHealth?.episodes[0]?.firstObservedAt
    );
    expect(later.recoveryHealth?.unresolvedIntentId).toBeUndefined();
    expect((await h.read()).recoveryHealth).toEqual(later.recoveryHealth);
  });

  it('a rejected report retains the accepted lease but cannot extend its expiry', async () => {
    const h = await setup(kind);
    const accepted = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
    h.setTime('2026-09-10T00:02:00.000Z');
    const rejected = await h.run((deps) =>
      new MemberWorkSyncReporter(deps).execute({ ...h.request, taskIds: ['foreign'] })
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.status.report).toMatchObject({
      accepted: false,
      rejectionCode: 'foreign_task_id',
    });
    expect(rejected.status.lastAcceptedReport).toEqual(accepted.status.lastAcceptedReport);
    expect(hasActiveAcceptedWorkLease(rejected.status)).toBe(true);
    expect(
      getAcceptedWorkLeaseStaleness(rejected.status, Date.parse('2026-09-10T00:16:00.000Z'))
    ).toBe('expired');
    h.setTime('2026-09-10T00:16:00.000Z');
    const expired = await h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member));
    expect(expired.state).toBe('needs_sync');
    expect(expired.lastAcceptedReport).toEqual(accepted.status.lastAcceptedReport);
    expect(expired.report).toEqual(rejected.status.report);
    expect(hasActiveAcceptedWorkLease(expired)).toBe(false);
    const metrics = await h.store.readTeamMetrics(member.teamName);
    expect(metrics.recentEvents.filter((event) => event.kind === 'report_accepted')).toHaveLength(
      1
    );
    expect(metrics.recentEvents.filter((event) => event.kind === 'report_rejected')).toHaveLength(
      1
    );
  });

  it('does not recount a retained rejection when the member has never reported accepted work', async () => {
    const h = await setup(kind);
    const rejected = await h.run((deps) =>
      new MemberWorkSyncReporter(deps).execute({ ...h.request, taskIds: ['foreign'] })
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.status.lastAcceptedReport).toBeUndefined();
    for (const time of ['2026-09-10T00:02:00.000Z', '2026-09-10T00:04:00.000Z']) {
      h.setTime(time);
      const status = await h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member));
      expect(status.report).toEqual(rejected.status.report);
    }
    const metrics = await h.store.readTeamMetrics(member.teamName);
    expect(metrics.recentEvents.filter((event) => event.kind === 'report_rejected')).toHaveLength(
      1
    );
  });

  it('a delayed Reporter conflict cannot renew the original lease', async () => {
    const h = await setup(kind);
    const writes: MemberWorkSyncStatus[] = [];
    const accepted = await h.run(async (deps) => {
      const port = deps.statusMutations!;
      return new MemberWorkSyncReporter({
        ...deps,
        statusMutations: {
          ...port,
          compareAndWrite: async (input) => {
            writes.push(input.nextStatus);
            if (writes.length === 1) {
              await h.run((other) => new MemberWorkSyncReconciler(other).execute(member));
              h.setTime('2026-09-10T00:10:00.000Z');
            }
            return port.compareAndWrite(input);
          },
        },
      }).execute(h.request);
    });
    expect(accepted.accepted).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0].report?.reportedAt).toBe(initialTime);
    expect(writes[1].report).toEqual(writes[0].report);
    expect(accepted.status.lastAcceptedReport?.expiresAt).toBe('2026-09-10T00:15:00.000Z');
  });

  it('does not restart an exhausted nested reconcile from rejected Reporter', async () => {
    const h = await setup(kind);
    const planned = vi.spyOn(MemberWorkSyncNudgeOutboxPlanner.prototype, 'plan');
    const writes: MemberWorkSyncStatus[] = [];
    const result = h.run(async (deps) => {
      const port = deps.statusMutations!;
      return new MemberWorkSyncReporter({
        ...deps,
        statusMutations: {
          ...port,
          compareAndWrite: async (input) => {
            writes.push(input.nextStatus);
            await h.run((other) => new MemberWorkSyncReporter(other).execute(h.request));
            return port.compareAndWrite(input);
          },
        },
      }).execute({ ...h.request, taskIds: ['foreign'] });
    });
    await expect(result).rejects.toMatchObject({ reason: 'conflict', retryExhausted: true });
    expect(writes).toHaveLength(2);
    expect(writes.every((status) => status.report?.accepted !== false)).toBe(true);
    expect(planned).not.toHaveBeenCalled();
    expect((await h.read()).statusRevision?.sequence).toBe(12);
  });

  it('stops after two actual stale-snapshot conflicts and does not plan an outbox', async () => {
    const h = await setup(kind);
    const planned = vi.spyOn(MemberWorkSyncNudgeOutboxPlanner.prototype, 'plan');
    const mutationIds: string[] = [];
    const result = h.run(async (deps) => {
      const port = deps.statusMutations!;
      return new MemberWorkSyncReconciler({
        ...deps,
        statusMutations: {
          ...port,
          compareAndWrite: async (input) => {
            mutationIds.push(input.mutationId);
            await h.run((other) => new MemberWorkSyncReporter(other).execute(h.request));
            return port.compareAndWrite(input);
          },
        },
      }).execute(member);
    });
    await expect(result).rejects.toMatchObject({ reason: 'conflict' });
    expect(mutationIds).toHaveLength(2);
    expect(new Set(mutationIds).size).toBe(1);
    expect(planned).not.toHaveBeenCalled();
    expect((await h.read()).statusRevision?.sequence).toBe(12);
  });
});

describe('conditional outcomes through admitted use cases', () => {
  it('an early worker unknown does not retry or release deletion drain before the real late write', async () => {
    const h = await setup('sqlite');
    await h.read();
    const release = deferred();
    const original = h.sqlite.compareAndWriteCanonicalStatus.bind(h.sqlite);
    const write = vi
      .spyOn(h.sqlite, 'compareAndWriteCanonicalStatus')
      .mockImplementationOnce(async (input) => {
        const physical = release.promise.then(() => original(input)).then(() => undefined);
        throw new InternalStorageOperationInterruptedError(
          'injected worker timeout',
          'unknown',
          physical
        );
      });
    const planned = vi.spyOn(MemberWorkSyncNudgeOutboxPlanner.prototype, 'plan');
    let drained = false;
    let drain: Promise<void> | undefined;
    try {
      await expect(
        h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member))
      ).rejects.toMatchObject({ reason: 'commit_unknown', mutationId: expect.any(String) });
      expect(write).toHaveBeenCalledTimes(1);
      expect(planned).not.toHaveBeenCalled();
      const before = await h.sqlite.readCanonicalStatusRecord(member);
      expect(JSON.parse(before!.statusJson).statusRevision.sequence).toBe(10);
      h.gate.beginTeamQuiesce(member.teamName);
      drain = h.gate.awaitTeamIdle(member.teamName).then(() => {
        drained = true;
      });
      await h.gate.run('other-sandbox', async () => undefined);
      expect(drained).toBe(false);
    } finally {
      release.resolve();
      await drain;
      await h.gate.awaitTeamIdle(member.teamName);
    }
    expect(drained).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(planned).not.toHaveBeenCalled();
    h.gate.resumeTeam(member.teamName);
    expect((await h.read()).statusRevision?.sequence).toBe(11);
  });

  it('a known JSON commit with projection degradation is not retried or projected as a nudge', async () => {
    const h = await setup('json');
    const original = h.json.compareAndWriteCanonicalStatus.bind(h.json);
    const write = vi
      .spyOn(h.json, 'compareAndWriteCanonicalStatus')
      .mockImplementation(async (input) => {
        const result = await original(input);
        return result.committed === true ? { ...result, projectionDegraded: true } : result;
      });
    const planned = vi.spyOn(MemberWorkSyncNudgeOutboxPlanner.prototype, 'plan');
    const reconciled = await h.run((deps) => new MemberWorkSyncReconciler(deps).execute(member));
    expect(reconciled.statusRevision?.sequence).toBe(11);
    expect(planned).not.toHaveBeenCalled();
    const accepted = await h.run((deps) => new MemberWorkSyncReporter(deps).execute(h.request));
    expect(accepted.accepted).toBe(true);
    expect(accepted.status.statusRevision?.sequence).toBe(12);
    expect(write).toHaveBeenCalledTimes(2);
    expect((await h.read()).lastAcceptedReport).toEqual(accepted.status.lastAcceptedReport);
  });
});
