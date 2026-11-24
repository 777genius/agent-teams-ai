import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { InternalStorageOperationInterruptedError, KeyedMutex } from '@features/internal-storage/main';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { buildMemberWorkSyncNudgePayloadHash } from '@features/member-work-sync/core/domain/MemberWorkSyncNudge';
import { createMemberWorkSyncRestoreParticipant } from '@features/member-work-sync/main/composition/createMemberWorkSyncRestoreParticipant';
import { BackendSelectingMemberWorkSyncReportJournal } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncReportJournal';
import { BackendSelectingMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncStore';
import { HmacMemberWorkSyncReportTokenAdapter } from '@features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import { internalStorageInterruption } from '@features/member-work-sync/main/infrastructure/internalStorageInterruption';
import {
  buildPendingReportIntentId,
  isMemberWorkSyncStoreSnapshot,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { readFailureDetail } from '@features/member-work-sync/main/infrastructure/memberWorkSyncPreparationDiagnostics';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { recordsToSnapshot, snapshotToRecords } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { MemberWorkSyncStatusAuthority } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';
import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

import type { MemberWorkSyncOutboxEnsureInput, MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStoreSnapshot } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';

const identity = { teamName: 'sandbox', incarnation: 'inc-1', mutation: false };
const member = { teamName: identity.teamName, memberName: 'alice' };
function status(sequence = 1): MemberWorkSyncStatus {
  return {
    ...member,
    state: 'needs_sync',
    evaluatedAt: '2026-09-10T00:00:00.000Z',
    diagnostics: [],
    agenda: {
      ...member,
      generatedAt: '2026-09-10T00:00:00.000Z',
      fingerprint: 'f',
      items: [],
      diagnostics: [],
    },
    statusRevision: {
      incarnation: identity.incarnation,
      lineageId: 'lineage',
      sequence,
      nonce: `nonce-${sequence}`,
    },
  };
}
function snapshot(value = status()): MemberWorkSyncStoreSnapshot {
  return {
    statuses: [value],
    reportIntents: [],
    outboxItems: [],
    metricEvents: [],
    filesToArchive: [],
  };
}
const roots: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(
  kind: 'json' | 'sqlite' = 'sqlite',
  logger?: { warn: (message: string, metadata?: Record<string, unknown>) => void }
) {
  const root = await mkdtemp(join(tmpdir(), 'mws-prepared-sandbox-'));
  roots.push(root);
  const paths = new MemberWorkSyncStorePaths(join(root, 'teams'));
  const core = new InternalStorageWorkerCore({
    databasePath: join(root, 'app.db'),
    createDatabase: (file) => new Database(file),
  });
  cores.push(core);
  const gateway = new InProcessGateway(core);
  const selector = new InternalStorageBackendSelector(() =>
    kind === 'sqlite'
      ? Promise.resolve({
          driver: 'better-sqlite3',
          databasePath: join(root, 'app.db'),
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
    logger,
  });
  const replica = new InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>(
    (team) => paths.getSqliteFallbackReplicaPath(team),
    isMemberWorkSyncStoreSnapshot
  );
  return { root, paths, gateway, selector, json, sqlite, store, replica };
}

describe('prepared backend production storage path', () => {
  const emptyClaim = {
    teamName: identity.teamName,
    claimedBy: 'TEST-empty-dispatch',
    nowIso: status().evaluatedAt,
    limit: 10,
  };
  async function publishBoundStatus(h: Awaited<ReturnType<typeof setup>>) {
    const nextStatus: MemberWorkSyncStatus = {
      ...status(),
      state: 'caught_up',
      diagnostics: ['agenda_empty'],
      shadow: { reconciledBy: 'queue', wouldNudge: false, fingerprintChanged: false },
    };
    const committed = await h.store.withPreparedBackend(
      { ...identity, mutation: true },
      (backend) =>
        backend.compareAndWrite({
          expectedRaw: null,
          mutationId: 'TEST-startup-scan',
          nextStatus,
        })
    );
    expect(committed.committed).toBe(true);
    return nextStatus;
  }

  function coldStores(h: Awaited<ReturnType<typeof setup>>) {
    const sqlite = new SqliteMemberWorkSyncStore({
      gateway: h.gateway,
      buildReportIntentId: buildPendingReportIntentId,
      importer: new MemberWorkSyncSqliteImporter({ gateway: h.gateway, jsonStore: h.json }),
    });
    return { sqlite, store: new BackendSelectingMemberWorkSyncStore(h.selector, sqlite, h.json, {
      gateway: h.gateway, paths: h.paths, fallbackRequiresReplica: false,
    }) };
  }
  function coldStore(h: Awaited<ReturnType<typeof setup>>) {
    return coldStores(h).store;
  }

  it.each(['warm', 'cold'] as const)(
    'review regression: recovers an empty bound primary after a pre-action failure (%s)',
    async (restart) => {
      const h = await setup();
      await h.store.withPreparedBackend(identity, async () => undefined);
      const error = new Error('TEST empty primary action interruption');
      vi.spyOn(h.sqlite, 'claimDue').mockRejectedValueOnce(error);
      await expect(h.store.claimDue(emptyClaim)).rejects.toBe(error);
      const active = restart === 'cold' ? coldStore(h) : h.store;
      await expect(active.readTeamMetrics(identity.teamName)).resolves.toBeDefined();
      await expect(h.replica.readBoundClean(identity.teamName)).resolves.toMatchObject({
        incarnation: identity.incarnation, snapshot: { statuses: [], outboxItems: [] },
      });
    }
  );

  it('review regression: a failed dirty fence leaves the primary and original clean input unchanged', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    const original = snapshot(status(2));
    await h.replica.writeClean(identity.teamName, original, identity.incarnation);
    const before = await h.gateway.listTeamSnapshot(identity.teamName);
    const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
    const cleanBytes = await readFile(path, 'utf8');
    const error = new Error('TEST dirty publication rejected');
    vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty').mockRejectedValueOnce(error);
    vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate')
      .mockRejectedValueOnce(error);
    const imported = vi.spyOn(h.gateway, 'importTeam');
    const action = vi.spyOn(h.sqlite, 'readTeamMetrics');
    await expect(h.store.readTeamMetrics(identity.teamName)).rejects.toBe(error);
    expect(imported).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(before);
    expect(await readFile(path, 'utf8')).toBe(cleanBytes);
  });

  it.each(['active', 'archive'] as const)(
    'review regression: rejects a mixed-incarnation %s snapshot before any import or action',
    async (source) => {
      const h = await setup();
      await publishBoundStatus(h);
      const foreign = status();
      foreign.memberName = 'TEST-foreign-member';
      foreign.agenda.memberName = foreign.memberName;
      foreign.statusRevision!.incarnation = 'TEST-foreign-incarnation';
      const mixed = { ...snapshot(), statuses: [status(), foreign] };
      vi.spyOn(h.json, source === 'active' ? 'readSnapshotForImport' : 'readArchivedSnapshotForImport')
        .mockResolvedValue(mixed);
      if (source === 'archive') vi.spyOn(h.gateway, 'hasStoreImport').mockResolvedValue(false);
      const before = await h.gateway.listTeamSnapshot(identity.teamName);
      const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
      const cleanBytes = await readFile(path, 'utf8');
      const imported = vi.spyOn(h.gateway, 'importTeam');
      const cold = coldStores(h);
      const action = vi.spyOn(cold.sqlite, 'claimDue');
      await expect(cold.store.claimDue(emptyClaim)).rejects.toThrow();
      expect(imported).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
      expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(before);
      expect(await readFile(path, 'utf8')).toBe(cleanBytes);
    }
  );

  it.each(['before commit', 'after commit'] as const)(
    'review regression: preserves the cold input and original error when import rejects %s',
    async (failure) => {
      const h = await setup();
      await publishBoundStatus(h);
      const original = snapshot(status(2));
      await h.replica.writeClean(identity.teamName, original, identity.incarnation);
      const before = await h.gateway.listTeamSnapshot(identity.teamName);
      const importTeam = h.gateway.importTeam.bind(h.gateway);
      const error = new Error(`TEST import ${failure}`);
      vi.spyOn(h.gateway, 'importTeam').mockImplementationOnce(async (...args) => {
        if (failure === 'after commit') await importTeam(...args);
        throw error;
      });
      const action = vi.spyOn(h.sqlite, 'claimDue');
      await expect(h.store.claimDue(emptyClaim)).rejects.toBe(error);
      expect(action).not.toHaveBeenCalled();
      await expect(h.replica.readBoundClean(identity.teamName)).resolves.toEqual({
        incarnation: identity.incarnation,
        snapshot: failure === 'before commit' ? original : {
          ...original, metricEvents: recordsToSnapshot(identity.teamName, before).metricEvents,
        },
      });
      if (failure === 'before commit')
        expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(before);
      const fresh = coldStore(h);
      await expect(fresh.claimDue(emptyClaim)).resolves.toEqual([]);
      expect(recordsToSnapshot(identity.teamName,
        await h.gateway.listTeamSnapshot(identity.teamName)).statuses).toEqual(original.statuses);
    }
  );

  it.each(['clean empty', 'dirty nonempty'] as const)(
    'migrates pre-v8 %s ownership proof without relying on the new marker', async (source) => {
      const h = await setup();
      if (source === 'clean empty') {
        await h.replica.writeClean(identity.teamName,
          { ...snapshot(), statuses: [] }, identity.incarnation);
      } else {
        await h.gateway.importTeam(identity.teamName, snapshotToRecords(identity.teamName, snapshot()));
        await h.replica.markDirty(identity.teamName, identity.incarnation);
      }
      expect(await h.gateway.readPrimaryIncarnation(identity.teamName)).toBeNull();
      await coldStore(h).readTeamMetrics(identity.teamName);
      expect(await h.gateway.readPrimaryIncarnation(' SANDBOX ')).toBe(identity.incarnation);
      expect(await h.replica.readBoundClean(identity.teamName)).toMatchObject({ incarnation: identity.incarnation });
    }
  );

  it('does not reopen already-consumed archives while preparing a bound cold store', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    const archive = vi.spyOn(h.json, 'readArchivedSnapshotForImport')
      .mockRejectedValue(new Error('TEST obsolete archive must not be read'));
    await coldStore(h).readTeamMetrics(identity.teamName);
    expect(archive).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unbound'] as const)(
    'refuses a %s replica and foreign legacy source while SQLite remains bound', async (kind) => {
      const h = await setup();
      await h.store.withPreparedBackend(identity, async () => undefined);
      if (kind === 'missing') await rm(h.paths.getSqliteFallbackReplicaPath(identity.teamName));
      else await h.replica.writeClean(identity.teamName, { ...snapshot(), statuses: [] });
      const foreign = snapshot();
      foreign.statuses[0]!.statusRevision!.incarnation = 'TEST-foreign';
      vi.spyOn(h.json, 'readSnapshotForImport').mockResolvedValue(foreign);
      const imported = vi.spyOn(h.gateway, 'importTeam');
      const claim = vi.spyOn(h.gateway, 'outboxClaimDue');
      await expect(coldStore(h).claimDue(emptyClaim)).rejects.toThrow();
      await expect(new MemberWorkSyncSqliteImporter({ gateway: h.gateway, jsonStore: h.json })
        .ensureImported(identity.teamName)).rejects.toThrow();
      expect(imported).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(await h.gateway.readPrimaryIncarnation(identity.teamName)).toBe(identity.incarnation);
      expect((await h.gateway.listTeamSnapshot(identity.teamName)).statuses).toEqual([]);
    }
  );

  it('keeps owner and rows atomic across aliases, failed imports, purge and recreation', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    const before = await h.gateway.listTeamSnapshot(identity.teamName);
    await expect(async () => h.gateway.importTeam(' SANDBOX ', before)).rejects.toThrow('incarnation mismatch');
    await expect(async () => h.gateway.importTeam('SANDBOX', before, { incarnation: 'TEST-foreign' }))
      .rejects.toThrow('incarnation mismatch');
    await expect(async () => h.gateway.importTeam(identity.teamName,
      { ...before, statuses: [...before.statuses, ...before.statuses] },
      { incarnation: identity.incarnation })).rejects.toThrow();
    expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(before);
    await expect(async () => h.gateway.importTeam('TEST-new-owner',
      { ...before, statuses: [...before.statuses, ...before.statuses] },
      { incarnation: identity.incarnation })).rejects.toThrow();
    expect(await h.gateway.readPrimaryIncarnation('TEST-new-owner')).toBeNull();
    expect(await h.gateway.readPrimaryIncarnation(' SANDBOX ')).toBe(identity.incarnation);
    await h.gateway.importTeam('other-team', { statuses: [], reportIntents: [], outboxItems: [], metricEvents: [] },
      { incarnation: 'other-incarnation' });
    await h.store.purgeTeam(identity.teamName);
    expect(await h.gateway.readPrimaryIncarnation(identity.teamName)).toBeNull();
    expect(await h.gateway.readPrimaryIncarnation('other-team')).toBe('other-incarnation');
    await h.store.withPreparedBackend({ ...identity, incarnation: 'next-incarnation' }, async () => undefined);
    expect(await h.gateway.readPrimaryIncarnation('SANDBOX')).toBe('next-incarnation');
  });

  it.each(['before commit', 'late commit', 'recovered replacement'] as const)(
    'waits for physical import settlement and preserves the original error (%s)', async (mode) => {
      const h = await setup();
      await publishBoundStatus(h);
      const source = snapshot(status(2));
      const preimage = recordsToSnapshot(identity.teamName, await h.gateway.listTeamSnapshot(identity.teamName));
      await h.replica.writeClean(identity.teamName, source, identity.incarnation);
      let release!: () => void;
      let reached!: () => void;
      const settled = new Promise<void>((resolve) => { release = resolve; });
      const atImport = new Promise<void>((resolve) => { reached = resolve; });
      const error = new InternalStorageOperationInterruptedError('TEST uncertain import', 'unknown', settled);
      const original = h.gateway.importTeam.bind(h.gateway);
      let args!: Parameters<typeof original>;
      vi.spyOn(h.gateway, 'importTeam').mockImplementationOnce(async (...captured) => {
        args = captured;
        reached();
        throw error;
      });
      const action = vi.spyOn(h.sqlite, 'claimDue');
      const clean = vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean');
      let completed = false;
      const outcome = h.store.claimDue(emptyClaim).catch((failure: unknown) => {
        completed = true;
        return failure;
      });
      await atImport;
      await expect(h.replica.readBoundClean(identity.teamName)).rejects.toThrow();
      expect(completed).toBe(false);
      expect(action).not.toHaveBeenCalled();
      expect(clean).not.toHaveBeenCalled();
      if (mode !== 'before commit') await original(...args);
      if (mode === 'recovered replacement') {
        const info = await h.gateway.ping();
        vi.spyOn(h.gateway, 'ping').mockResolvedValue({ ...info, integrity: 'recovered' });
      }
      release();
      expect(await outcome).toBe(error);
      expect(action).not.toHaveBeenCalled();
      if (mode === 'recovered replacement') {
        expect(clean).not.toHaveBeenCalled();
        await expect(h.replica.readBoundClean(identity.teamName)).rejects.toThrow();
      } else {
        await expect(h.replica.readBoundClean(identity.teamName)).resolves.toEqual({
          incarnation: identity.incarnation,
          snapshot: mode === 'before commit' ? source : { ...source, metricEvents: preimage.metricEvents },
        });
        expect(clean).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each(['public cold read', 'direct authority'] as const)(
    'recovers the verified legacy empty import after the first action fails through %s', async (recovery) => {
    const h = await setup();
    await h.replica.writeClean(identity.teamName, { ...snapshot(), statuses: [] }, identity.incarnation);
    const error = new Error('TEST first upgraded action failed');
    vi.spyOn(h.sqlite, 'claimDue').mockRejectedValueOnce(error);
    await expect(h.store.claimDue(emptyClaim)).rejects.toBe(error);
    expect(await h.gateway.readPrimaryIncarnation(identity.teamName)).toBe(identity.incarnation);
    await expect(h.replica.readBoundPublication(identity.teamName)).resolves.toEqual({
      state: 'dirty', incarnation: identity.incarnation,
    });
    if (recovery === 'direct authority')
      await expect(h.store.withPreparedBackend(identity, (backend) => backend.read(member.memberName)))
        .resolves.toEqual({ state: 'absent', raw: null });
    else await coldStore(h).readTeamMetrics(identity.teamName);
    expect((await h.replica.readBoundClean(identity.teamName))?.snapshot.statuses).toEqual([]);
  });

  it('recovers the committed import when publishing its bare action fence fails', async () => {
    const h = await setup();
    await h.replica.writeClean(identity.teamName, { ...snapshot(), statuses: [] }, identity.incarnation);
    const error = new Error('TEST bare action fence failed');
    vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty').mockRejectedValueOnce(error);
    const action = vi.spyOn(h.sqlite, 'claimDue');
    await expect(h.store.claimDue(emptyClaim)).rejects.toBe(error);
    expect(action).not.toHaveBeenCalled();
    expect(await h.gateway.readPrimaryIncarnation(identity.teamName)).toBe(identity.incarnation);
    await expect(h.replica.readBoundClean(identity.teamName)).resolves.toMatchObject({
      incarnation: identity.incarnation, snapshot: { statuses: [] },
    });
    await expect(coldStore(h).claimDue(emptyClaim)).resolves.toEqual([]);
  });

  it('recognizes its persisted candidate without rewriting raw journal metadata proof', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    const value = snapshot();
    value.reportIntents.push({ ...member, id: 'TEST-raw-journal',
      request: { ...member, state: 'still_working', agendaFingerprint: 'f' },
      reason: 'journal', status: 'pending', recordedAt: status().evaluatedAt,
      journal: { incarnation: identity.incarnation, requestDigest: 'digest',
        firstRecordedAt: status().evaluatedAt, origin: 'online' },
    });
    const primary = await h.gateway.listTeamSnapshot(identity.teamName);
    const report = snapshotToRecords(identity.teamName, value).reportIntents[0]!;
    report.journalJson = JSON.stringify(JSON.parse(report.journalJson!), null, 2);
    await h.gateway.importTeam(identity.teamName, { ...primary, reportIntents: [report] },
      { incarnation: identity.incarnation });
    await h.replica.writeClean(identity.teamName, snapshot(status(2)), identity.incarnation);
    const original = h.gateway.importTeam.bind(h.gateway);
    const error = new Error('TEST import committed before reply failure');
    vi.spyOn(h.gateway, 'importTeam').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw error;
    });
    const action = vi.spyOn(h.sqlite, 'claimDue');
    await expect(h.store.claimDue(emptyClaim)).rejects.toBe(error);
    expect(action).not.toHaveBeenCalled();
    const actual = await h.gateway.listTeamSnapshot(identity.teamName);
    expect(actual.reportIntents[0]!.journalJson).toBe(report.journalJson);
    await expect(h.replica.readBoundClean(identity.teamName)).resolves.toEqual({
      incarnation: identity.incarnation, snapshot: recordsToSnapshot(identity.teamName, actual),
    });
  });

  it('does not repair a replaced bare fence after an uncertain preparation settles', async () => {
    const h = await setup();
    await h.store.withPreparedBackend(identity, async () => undefined);
    let release!: () => void;
    let reached!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const error = new InternalStorageOperationInterruptedError('TEST uncertain finalize', 'unknown', settled);
    vi.spyOn(h.sqlite, 'prepareCanonicalStatus').mockImplementationOnce(async () => {
      reached();
      throw error;
    });
    const clean = vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean');
    const outcome = h.store.claimDue(emptyClaim).catch((failure: unknown) => failure);
    await entered;
    await h.replica.markDirty(identity.teamName);
    release();
    expect(await outcome).toBe(error);
    expect(clean).not.toHaveBeenCalled();
    await expect(h.replica.readBoundPublication(identity.teamName)).resolves.toBeNull();
  });

  it('prevalidates a cold report-journal read before its importer can touch foreign legacy rows', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    const foreign = snapshot();
    foreign.statuses[0]!.statusRevision!.incarnation = 'TEST-foreign';
    vi.spyOn(h.json, 'readSnapshotForImport').mockResolvedValue(foreign);
    const cold = coldStores(h);
    const journal = new BackendSelectingMemberWorkSyncReportJournal(
      h.selector, cold.sqlite.createReportJournal(), h.json.createReportJournal(), cold.store);
    const imported = vi.spyOn(h.gateway, 'importTeam');
    const read = vi.spyOn(h.gateway, 'reportsJournalRead');
    const before = await h.gateway.listTeamSnapshot(identity.teamName);
    await expect(journal.read({ ...member, incarnation: identity.incarnation, intentId: 'TEST-journal', requestDigest: 'digest' }))
      .rejects.toThrow();
    expect(imported).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(before);
  });

  it('retains the authority binding through the next empty dispatch claim and a cold metrics read', async () => {
    const h = await setup();
    // Production startup: dispatch, startup-scan reconcile, then another dispatch.
    await expect(h.store.claimDue(emptyClaim)).resolves.toEqual([]);
    const nextStatus = await publishBoundStatus(h);
    await expect(h.store.claimDue(emptyClaim)).resolves.toEqual([]);
    const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      state: 'clean',
      incarnation: identity.incarnation,
      snapshot: { statuses: [nextStatus] },
    });
    const restarted = new BackendSelectingMemberWorkSyncStore(h.selector, h.sqlite, h.json, {
      gateway: h.gateway,
      paths: h.paths,
      fallbackRequiresReplica: false,
    });
    await restarted.readTeamMetrics(identity.teamName);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      state: 'clean',
      incarnation: identity.incarnation,
      snapshot: { statuses: [nextStatus] },
    });
  });

  it('keeps an unbound public replica unbound even when a status carries an incarnation', async () => {
    const h = await setup();
    await h.replica.writeClean(identity.teamName, snapshot());
    await h.store.claimDue(emptyClaim);
    const envelope = JSON.parse(
      await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')
    );
    expect(envelope).not.toHaveProperty('incarnation');
    expect(envelope.snapshot.statuses[0].statusRevision.incarnation).toBe(identity.incarnation);
  });

  it.each(['dirty', 'malformed', 'foreign'] as const)(
    'refuses a warm %s bound replica before a public claim overwrites its evidence',
    async (kind) => {
      const h = await setup();
      await publishBoundStatus(h);
      await h.store.readTeamMetrics(identity.teamName);
      const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
      const envelope = JSON.parse(await readFile(path, 'utf8'));
      if (kind === 'dirty') envelope.state = 'dirty';
      if (kind === 'malformed') envelope.snapshot.statuses = null;
      if (kind === 'foreign') envelope.incarnation = 'foreign';
      const before = JSON.stringify(envelope);
      await writeFile(path, before);
      const claim = vi.spyOn(h.sqlite, 'claimDue');
      const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty');
      await expect(h.store.claimDue(emptyClaim)).rejects.toThrow();
      expect(claim).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  );

  it('refuses a warm foreign canonical status before dirty publication or claim', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    await h.store.readTeamMetrics(identity.teamName);
    const foreign = status();
    foreign.statusRevision = { ...foreign.statusRevision!, incarnation: 'foreign' };
    await h.gateway.importTeam(
      identity.teamName,
      snapshotToRecords(identity.teamName, snapshot(foreign)),
      { incarnation: identity.incarnation }
    );
    const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
    const before = await readFile(path, 'utf8');
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty');
    const claim = vi.spyOn(h.sqlite, 'claimDue');
    await expect(h.store.claimDue(emptyClaim)).rejects.toThrow();
    expect(dirty).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each(['replica', 'primary'] as const)(
    'validates the actual cold %s merge input before import can normalize a foreign member',
    async (source) => {
      const h = await setup();
      await publishBoundStatus(h);
      const foreign = status();
      foreign.memberName = 'foreign-member';
      foreign.agenda = { ...foreign.agenda, memberName: foreign.memberName };
      foreign.statusRevision = { ...foreign.statusRevision!, incarnation: 'foreign' };
      const foreignSnapshot = snapshot(foreign);
      if (source === 'replica') {
        vi.spyOn(InternalStorageJsonReplica.prototype, 'readForPrimary').mockResolvedValueOnce(
          foreignSnapshot
        );
      } else {
        const canonical = await h.gateway.listTeamSnapshot(identity.teamName);
        vi.spyOn(h.gateway, 'listTeamSnapshot')
          .mockResolvedValueOnce(canonical)
          .mockResolvedValueOnce(snapshotToRecords(identity.teamName, foreignSnapshot));
      }
      const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
      const before = await readFile(path, 'utf8');
      const imported = vi.spyOn(h.gateway, 'importTeam');
      const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty');
      await expect(h.store.readTeamMetrics(identity.teamName)).rejects.toThrow();
      expect(imported).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  );

  it('leaves a bound dirty fence when the public mutation produces foreign canonical ownership', async () => {
    const warn = vi.fn();
    const h = await setup('sqlite', { warn });
    await publishBoundStatus(h);
    await h.store.readTeamMetrics(identity.teamName);
    vi.spyOn(h.sqlite, 'claimDue').mockImplementationOnce(async () => {
      const foreign = status();
      foreign.statusRevision = { ...foreign.statusRevision!, incarnation: 'foreign' };
      await h.gateway.importTeam(
        identity.teamName,
        snapshotToRecords(identity.teamName, snapshot(foreign)),
        { incarnation: identity.incarnation }
      );
      return [];
    });
    const clean = vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean');
    await expect(h.store.claimDue(emptyClaim)).resolves.toEqual([]);
    expect(clean).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'member-work-sync fallback replica publication failed',
      expect.any(Object)
    );
    expect(
      JSON.parse(await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8'))
    ).toMatchObject({
      state: 'dirty',
      incarnation: identity.incarnation,
    });
    await expect(h.replica.readBoundClean(identity.teamName)).rejects.toThrow();
  });

  it('does not carry the previous bound incarnation through a legitimate team purge', async () => {
    const h = await setup();
    await publishBoundStatus(h);
    await h.store.purgeTeam(identity.teamName);
    await h.store.claimDue(emptyClaim);
    const envelope = JSON.parse(
      await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')
    );
    expect(envelope).not.toHaveProperty('incarnation');
    expect(envelope.snapshot.statuses).toEqual([]);
    expect(envelope.snapshot.outboxItems).toEqual([]);
  });

  for (const recovery of ['warm claim', 'fresh store read'] as const) {
    it.each(['before action', 'after committed claim', 'clean publication'] as const)(
      `recovers a public bare dirty fence after %s through ${recovery} without replaying committed work`,
      async (failure) => {
        const warn = vi.fn();
        const h = await setup('sqlite', { warn });
        await publishBoundStatus(h);
        const payload: MemberWorkSyncOutboxEnsureInput['payload'] = {
          from: 'system', to: member.memberName, messageKind: 'member_work_sync_nudge',
          source: 'member-work-sync', actionMode: 'do', workSyncIntent: 'agenda_sync',
          text: 'TEST original nudge', taskRefs: [],
        };
        const input = { ...member, id: 'TEST-original-nudge', agendaFingerprint: 'f', payload,
          payloadHash: buildMemberWorkSyncNudgePayloadHash({
            sha256Hex: (value) => createHash('sha256').update(value).digest('hex'),
          }, payload), nowIso: status().evaluatedAt };
        await h.store.ensurePending(input);
        const originalClaim = h.sqlite.claimDue.bind(h.sqlite);
        const claimed = vi.spyOn(h.sqlite, 'claimDue');
        const gatewayClaims = vi.spyOn(h.gateway, 'outboxClaimDue');
        const error = new Error('TEST transient public storage failure');
        if (failure === 'before action') claimed.mockRejectedValueOnce(error);
        if (failure === 'after committed claim') claimed.mockImplementationOnce(async (request) => {
          await originalClaim(request);
          throw error;
        });
        if (failure === 'clean publication')
          vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean').mockRejectedValueOnce(error);
        const first = h.store.claimDue(emptyClaim);
        if (failure === 'clean publication') {
          await expect(first).resolves.toMatchObject([{ id: input.id, attemptGeneration: 1 }]);
          expect(warn).toHaveBeenCalledWith(
            'member-work-sync fallback replica publication failed', expect.any(Object)
          );
        } else await expect(first).rejects.toBe(error);
        const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
          state: 'dirty', incarnation: identity.incarnation,
        });
        expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('snapshot');
        const committed = recordsToSnapshot(identity.teamName,
          await h.gateway.listTeamSnapshot(identity.teamName)).outboxItems[0]!;
        expect(committed).toMatchObject({ id: input.id,
          status: failure === 'before action' ? 'pending' : 'claimed',
          attemptGeneration: failure === 'before action' ? 0 : 1,
        });
        const cold = recovery === 'fresh store read' ? coldStores(h) : undefined;
        const coldClaims = cold ? vi.spyOn(cold.sqlite, 'claimDue') : undefined;
        const active = cold?.store ?? h.store;
        const claimsBeforeRecovery = gatewayClaims.mock.calls.length;
        if (recovery === 'fresh store read') {
          await active.readTeamMetrics(identity.teamName);
          expect(claimed).toHaveBeenCalledTimes(1);
          expect(coldClaims).toHaveBeenCalledTimes(0);
          expect(gatewayClaims).toHaveBeenCalledTimes(claimsBeforeRecovery);
          expect(recordsToSnapshot(identity.teamName,
            await h.gateway.listTeamSnapshot(identity.teamName)).outboxItems).toEqual([committed]);
        }
        const retry = await active.claimDue({ ...emptyClaim, claimedBy: 'TEST-next-dispatch' });
        expect(claimed).toHaveBeenCalledTimes(recovery === 'warm claim' ? 2 : 1);
        if (coldClaims) expect(coldClaims).toHaveBeenCalledTimes(1);
        expect(gatewayClaims).toHaveBeenCalledTimes(claimsBeforeRecovery + 1);
        if (failure === 'before action') expect(retry).toMatchObject([
          { id: input.id, attemptGeneration: 1, claimedBy: 'TEST-next-dispatch' },
        ]);
        else expect(retry).toEqual([]);
        const canonical = recordsToSnapshot(identity.teamName,
          await h.gateway.listTeamSnapshot(identity.teamName));
        if (failure !== 'before action') expect(canonical.outboxItems).toEqual([committed]);
        await expect(h.replica.readBoundClean(identity.teamName)).resolves.toEqual({
          incarnation: identity.incarnation, snapshot: canonical,
        });
      }
    );
  }

  it.each([
    'JSON fallback', 'recovered primary', 'empty primary without ownership evidence',
    'unversioned primary without ownership evidence', 'foreign primary', 'foreign wrapper',
    'malformed wrapper', 'authority recovery candidate', 'unavailable primary',
  ] as const)('preserves a public dirty fence and refuses %s before import, rewrite or action', async (reason) => {
    const h = await setup();
    await publishBoundStatus(h);
    await h.store.readTeamMetrics(identity.teamName);
    await h.replica.markDirty(identity.teamName, identity.incarnation);
    if (reason === 'authority recovery candidate') {
      const candidate = snapshot(status(2));
      candidate.statuses[0]!.memberName = 'TEST-unimported';
      candidate.statuses[0]!.agenda.memberName = 'TEST-unimported';
      await h.replica.markDirtyWithRecoveryCandidate(identity.teamName, identity.incarnation, candidate);
    }
    if (reason === 'empty primary without ownership evidence') {
      await h.gateway.importTeam(identity.teamName, { statuses: [], reportIntents: [], outboxItems: [], metricEvents: [] }, { resetPrimaryIncarnation: true });
    } else if (reason === 'unversioned primary without ownership evidence' || reason === 'foreign primary') {
      const value = status();
      if (reason === 'foreign primary') value.statusRevision!.incarnation = 'TEST-foreign';
      else delete value.statusRevision;
      await h.gateway.importTeam(
        identity.teamName, snapshotToRecords(identity.teamName, snapshot(value)),
        reason === 'foreign primary'
          ? { incarnation: identity.incarnation }
          : { resetPrimaryIncarnation: true }
      );
      expect(await h.gateway.readPrimaryIncarnation(identity.teamName)).toBe(
        reason === 'foreign primary' ? identity.incarnation : null
      );
    }
    const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
    if (reason === 'foreign wrapper' || reason === 'malformed wrapper') {
      const envelope = JSON.parse(await readFile(path, 'utf8'));
      if (reason === 'foreign wrapper') envelope.incarnation = 'TEST-foreign';
      else envelope.updatedAt = 'invalid';
      await writeFile(path, JSON.stringify(envelope));
    }
    const before = await readFile(path, 'utf8');
    const primary = await h.gateway.listTeamSnapshot(identity.teamName);
    const selector = reason === 'JSON fallback' || reason === 'recovered primary'
      ? new InternalStorageBackendSelector(() => reason === 'JSON fallback'
          ? Promise.reject(new Error('TEST SQLite unavailable'))
          : Promise.resolve({ driver: 'better-sqlite3', databasePath: join(h.root, 'app.db'),
              schemaVersion: 4, integrity: 'recovered' }))
      : h.selector;
    const cold = new BackendSelectingMemberWorkSyncStore(selector, h.sqlite, h.json, {
      gateway: h.gateway, paths: h.paths, fallbackRequiresReplica: false,
    });
    if (reason === 'unavailable primary')
      vi.spyOn(h.gateway, 'listTeamSnapshot').mockRejectedValueOnce(new Error('TEST primary read failed'));
    const imported = vi.spyOn(h.gateway, 'importTeam');
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty');
    const clean = vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean');
    const sqliteRead = vi.spyOn(h.sqlite, 'readTeamMetrics');
    const jsonRead = vi.spyOn(h.json, 'readTeamMetrics');
    await expect(cold.readTeamMetrics(identity.teamName)).rejects.toThrow();
    expect(imported).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
    expect(sqliteRead).not.toHaveBeenCalled();
    expect(jsonRead).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(primary);
  });

  it('preserves bound journal metadata through SQLite and refuses legacy overwrites', async () => {
    const h = await setup('sqlite');
    const value = snapshot();
    const journal = {incarnation: identity.incarnation, requestDigest: 'digest', firstRecordedAt: status().evaluatedAt, origin: 'online' as const};
    value.reportIntents.push({...member, id: 'journal-i1', request: {...member, state: 'still_working', agendaFingerprint: 'f'}, reason: 'journal', status: 'pending', recordedAt: status().evaluatedAt, journal});
    const records = snapshotToRecords(identity.teamName, value);
    await h.gateway.importTeam(identity.teamName, records);
    await expect(async () =>
      h.gateway.reportsAppend({
        ...records.reportIntents[0],
        journalJson: null,
        requestJson: JSON.stringify({ ...member, state: 'caught_up', agendaFingerprint: 'f' }),
      })
    ).rejects.toThrow('Bound report intent requires strict journal API');
    const restored = recordsToSnapshot(
      identity.teamName,
      await h.gateway.listTeamSnapshot(identity.teamName)
    );
    expect(restored.reportIntents[0]).toMatchObject({
      status: 'pending',
      journal,
      request: { state: 'still_working' },
    });
    await h.store.withPreparedBackend(identity, async () => undefined);
  });

  it.each(['json', 'sqlite'] as const)('rejects a lone pending receipt before %s replica publication', async (kind) => {
    const h = await setup(kind);
    const value = snapshot();
    const time = status().evaluatedAt;
    value.reportIntents.push({ ...member, id: 'malformed-journal', request: { ...member, state: 'still_working', agendaFingerprint: 'f' }, reason: 'journal', status: 'pending', recordedAt: time,
      journal: { incarnation: identity.incarnation, requestDigest: 'digest', firstRecordedAt: time, origin: 'online', receipt: { intentId: 'malformed-journal', incarnation: identity.incarnation, requestDigest: 'digest', acceptedAt: time, appliedStatusRevision: status().statusRevision! } } });
    await h.replica.writeClean(identity.teamName, value, identity.incarnation);
    const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
    const before = await readFile(path, 'utf8');
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate');
    const imported = vi.spyOn(h.gateway, 'importTeam');
    const operation = vi.fn();
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
    expect(dirty).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await h.gateway.listTeamSnapshot(identity.teamName)).reportIntents).toEqual([]);
  });

  it('rejects foreign-incarnation journal metadata before backend publication', async () => {
    const h = await setup('sqlite');
    const value = snapshot();
    value.reportIntents.push({...member, id: 'foreign-journal', request: {...member, state: 'still_working', agendaFingerprint: 'f'}, reason: 'journal', status: 'pending', recordedAt: status().evaluatedAt, journal: {incarnation: 'old-inc', requestDigest: 'digest', firstRecordedAt: status().evaluatedAt, origin: 'online'}});
    const imported = vi.spyOn(h.gateway, 'importTeam');
    await expect(h.store.restoreValidatedBackup({identity, history: value, replica: {state: 'absent'}, secretJson: null})).rejects.toThrow();
    expect(imported).not.toHaveBeenCalled();
  });

  it.each(['json', 'sqlite'] as const)(
    'commits report receipt and revision atomically through %s authority',
    async (kind) => {
      const h = await setup(kind);
      const authority = new MemberWorkSyncStatusAuthority({
        diagnosticDetail: readFailureDetail,
      interruption: internalStorageInterruption,
        identity: createTestWorkSyncIdentity(identity.incarnation),
        withPreparedBackend: (binding, operation) =>
          h.store.withPreparedBackend(binding, operation),
      });
      const read = authority.startRead(member);
      const observed = await read.result;
      await read.settled;
      if (!observed.ok) throw new Error(observed.reason);
      const acceptedAt = status().evaluatedAt;
      const report = {
        ...member,
        state: 'still_working' as const,
        agendaFingerprint: 'f',
        reportedAt: acceptedAt,
        accepted: true,
      };
      const commit = authority.startCompareAndWrite({
        ...member,
        incarnation: identity.incarnation,
        expectedToken: observed.snapshot.token,
        mutationId: 'receipt-write',
        nextStatus: { ...status(), state: 'still_working', report, lastAcceptedReport: report },
        reportReceipt: {
          intentId: 'i1',
          incarnation: identity.incarnation,
          requestDigest: 'digest',
          acceptedAt,
        },
      });
      const result = await commit.result;
      await commit.settled;
      expect(result.committed).toBe(true);
      if (result.committed !== true) throw new Error('receipt write failed');
      expect(result.snapshot.status?.pendingReportReceipt?.appliedStatusRevision).toEqual(
        result.snapshot.status?.statusRevision
      );
      const receipt = result.snapshot.status!.pendingReportReceipt;
      const reconcile = authority.startCompareAndWrite({
        ...member,
        incarnation: identity.incarnation,
        expectedToken: result.snapshot.token,
        mutationId: 'later-status',
        nextStatus: {
          ...result.snapshot.status!,
          pendingReportReceipt: undefined,
          diagnostics: ['later'],
        },
      });
      const later = await reconcile.result;
      await reconcile.settled;
      expect(later.committed).toBe(true);
      if (later.committed !== true) throw new Error('carry-forward failed');
      expect(later.snapshot.status?.pendingReportReceipt).toEqual(receipt);
      expect(later.snapshot.status?.statusRevision?.sequence).toBe(2);
      const readBack = authority.startRead(member);
      await expect(readBack.result).resolves.toMatchObject({
        ok: true,
        snapshot: { status: { pendingReportReceipt: receipt } },
      });
      await readBack.settled;
    }
  );

  it.each(['plain-json', 'json', 'sqlite'] as const)(
    'rejects dirty backup during participant prepare without target writes: %s',
    async (kind) => {
      const h = await setup(kind === 'sqlite' ? 'sqlite' : 'json');
      const backupRoot = join(h.root, 'backup-teams');
      const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
      const source = new InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>(
        (team) => backupPaths.getSqliteFallbackReplicaPath(team),
        isMemberWorkSyncStoreSnapshot
      );
      await source.markDirtyWithRecoveryCandidate(
        identity.teamName,
        identity.incarnation,
        snapshot()
      );
      const before = await readFile(
        backupPaths.getSqliteFallbackReplicaPath(identity.teamName),
        'utf8'
      );
      const importSpy = vi.spyOn(h.gateway, 'importTeam');
      const writeSpy = vi.spyOn(h.json, 'restoreReplicaSnapshot');
      const tokens = new HmacMemberWorkSyncReportTokenAdapter(
        h.paths,
        createTestWorkSyncIdentity('inc-1')
      );
      const secretSpy = vi.spyOn(tokens, 'restoreBackupSecret');
      const participant = createMemberWorkSyncRestoreParticipant(
        kind === 'plain-json' ? h.json : h.store,
        tokens,
        h.paths
      );
      await expect(
        participant.prepare({ ...identity, backupTeamsRoot: backupRoot })
      ).rejects.toThrow();
      expect(importSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(secretSpy).not.toHaveBeenCalled();
      expect(
        await readFile(backupPaths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')
      ).toBe(before);
      await expect(
        readFile(h.paths.getReportTokenSecretPath(identity.teamName))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it.each(['stale', 'corrupt', 'foreign'] as const)(
    'plain JSON preflight validates live secret without preventing stale incarnation rotation: %s',
    async (kind) => {
      const h = await setup('json');
      const backupRoot = join(h.root, 'backup-teams');
      const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
      await new JsonMemberWorkSyncStore(backupPaths).write(status());
      const target = h.paths.getReportTokenSecretPath(identity.teamName);
      await mkdir(h.paths.getTeamDir(identity.teamName), { recursive: true });
      const raw =
        kind === 'corrupt'
          ? '{broken'
          : JSON.stringify({
              schemaVersion: 2,
              teamName: kind === 'foreign' ? 'foreign-team' : identity.teamName,
              incarnation: 'old-incarnation',
              secret: 'a'.repeat(32),
            });
      await writeFile(target, raw);
      const participant = createMemberWorkSyncRestoreParticipant(
        h.json,
        new HmacMemberWorkSyncReportTokenAdapter(
          h.paths,
          createTestWorkSyncIdentity(identity.incarnation)
        ),
        h.paths
      );
      const prepare = participant.prepare({ ...identity, backupTeamsRoot: backupRoot });
      if (kind !== 'stale') {
        await expect(prepare).rejects.toThrow();
        expect(await readFile(target, 'utf8')).toBe(raw);
        return;
      }
      const prepared = await prepare;
      expect(await readFile(target, 'utf8')).toBe(raw);
      await prepared.importAndVerify();
      const live = JSON.parse(await readFile(target, 'utf8'));
      expect(live).toMatchObject({
        schemaVersion: 2,
        teamName: identity.teamName,
        incarnation: identity.incarnation,
      });
      expect(live.secret).not.toBe('a'.repeat(32));
    }
  );

  it('admits dirty SQLite backup with canonical continuity without publishing it', async () => {
    const h = await setup('sqlite');
    await h.gateway.importTeam(identity.teamName, snapshotToRecords(identity.teamName, snapshot()));
    const importSpy = vi.spyOn(h.gateway, 'importTeam');
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate');
    await h.store.preflightValidatedBackup({
      identity,
      history: { ...snapshot(), statuses: [] },
      replica: { state: 'dirty', candidate: snapshot() },
      secretJson: null,
    });
    expect(importSpy).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
  });

  it('imports the captured backup after its source bytes change', async () => {
    const h = await setup('sqlite');
    const backupRoot = join(h.root, 'backup-teams');
    const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
    await new JsonMemberWorkSyncStore(backupPaths).write(status());
    const participant = createMemberWorkSyncRestoreParticipant(
      h.store,
      new HmacMemberWorkSyncReportTokenAdapter(h.paths, createTestWorkSyncIdentity('inc-1')),
      h.paths
    );
    const prepared = await participant.prepare({ ...identity, backupTeamsRoot: backupRoot });
    await writeFile(
      backupPaths.getMemberStatusPath(identity.teamName, member.memberName),
      '{broken'
    );
    await prepared.importAndVerify();
    expect(
      await h.store.withPreparedBackend(identity, (backend) => backend.read(member.memberName))
    ).toMatchObject({ state: 'present', payload: { statusRevision: status().statusRevision } });
  });

  it.each(['plain-json', 'sqlite'] as const)(
    'restores backup status and secret through the bound feature participant %s',
    async (kind) => {
      const h = await setup('sqlite');
      const backupRoot = join(h.root, 'backup-teams');
      const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
      await new JsonMemberWorkSyncStore(backupPaths).write(status());
      const secret = JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) });
      await mkdir(backupPaths.getTeamDir(identity.teamName), { recursive: true });
      await writeFile(backupPaths.getReportTokenSecretPath(identity.teamName), secret);
      const participant = createMemberWorkSyncRestoreParticipant(
        kind === 'plain-json' ? h.json : h.store,
        new HmacMemberWorkSyncReportTokenAdapter(h.paths, createTestWorkSyncIdentity('inc-1')),
        h.paths
      );
      const prepared = await participant.prepare({ ...identity, backupTeamsRoot: backupRoot });
      await prepared.importAndVerify();
      const liveSecret = JSON.parse(
        await readFile(h.paths.getReportTokenSecretPath(identity.teamName), 'utf8')
      );
      expect(liveSecret).toMatchObject({
        schemaVersion: 2,
        teamName: identity.teamName,
        incarnation: identity.incarnation,
      });
      expect(liveSecret.secret).not.toBe('a'.repeat(32));
      expect(
        await h.store.withPreparedBackend(identity, (backend) => backend.read(member.memberName))
      ).toMatchObject({ state: 'present', payload: { statusRevision: status().statusRevision } });
      expect(await readFile(backupPaths.getReportTokenSecretPath(identity.teamName), 'utf8')).toBe(
        secret
      );
    }
  );

  it('reissues restored report tokens when restore rotates the signing key', async () => {
    const h = await setup('sqlite');
    const backupRoot = join(h.root, 'backup-teams');
    const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
    const backupTokens = new HmacMemberWorkSyncReportTokenAdapter(
      backupPaths,
      createTestWorkSyncIdentity('inc-1')
    );
    await backupTokens.restoreBackupSecret(
      identity.teamName,
      JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) }),
      { teamName: identity.teamName, incarnation: identity.incarnation }
    );
    const backupIssued = await backupTokens.create({
      teamName: identity.teamName,
      memberName: member.memberName,
      agendaFingerprint: 'f',
      issuedAt: '2026-09-10T00:00:00.000Z',
    });
    await new JsonMemberWorkSyncStore(backupPaths).write({
      ...status(),
      reportToken: backupIssued.token,
      reportTokenExpiresAt: backupIssued.expiresAt,
    });
    const liveTokens = new HmacMemberWorkSyncReportTokenAdapter(
      h.paths,
      createTestWorkSyncIdentity('inc-1')
    );
    const prepared = await createMemberWorkSyncRestoreParticipant(
      h.store,
      liveTokens,
      h.paths
    ).prepare({ ...identity, backupTeamsRoot: backupRoot });
    await prepared.importAndVerify();
    const restored = await h.store.read(member);
    expect(restored?.reportToken).toBeTruthy();
    expect(restored?.reportToken).not.toBe(backupIssued.token);
    expect(restored?.statusRevision).toMatchObject({
      incarnation: identity.incarnation,
      lineageId: status().statusRevision?.lineageId,
      sequence: (status().statusRevision?.sequence ?? 0) + 1,
    });
    expect(restored?.statusRevision?.nonce).not.toBe(status().statusRevision?.nonce);
    await expect(
      liveTokens.verify({
        teamName: identity.teamName,
        memberName: member.memberName,
        agendaFingerprint: 'f',
        token: restored?.reportToken ?? '',
        nowIso: '2026-09-10T00:00:00.000Z',
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it('reissues restored report tokens while the identity fence is held', async () => {
    const h = await setup('sqlite');
    const mutex = new KeyedMutex();
    const baseIdentity = createTestWorkSyncIdentity(identity.incarnation);
    const fencedIdentity = {
      ...baseIdentity,
      readCurrent: (teamName: string) =>
        mutex.run(identity.teamName, () => baseIdentity.readCurrent(teamName)),
      adoptLegacy: (teamName: string) =>
        mutex.run(identity.teamName, () => baseIdentity.adoptLegacy(teamName)),
      withCurrent: <T>(teamName: string, expected: string, operation: () => Promise<T>) =>
        mutex.run(identity.teamName, () => baseIdentity.withCurrent(teamName, expected, operation)),
    };
    const backupRoot = join(h.root, 'backup-teams');
    const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
    const backupTokens = new HmacMemberWorkSyncReportTokenAdapter(
      backupPaths,
      createTestWorkSyncIdentity('inc-1')
    );
    await backupTokens.restoreBackupSecret(
      identity.teamName,
      JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) }),
      { teamName: identity.teamName, incarnation: identity.incarnation }
    );
    const backupIssued = await backupTokens.create({
      teamName: identity.teamName,
      memberName: member.memberName,
      agendaFingerprint: 'f',
      issuedAt: '2026-09-10T00:00:00.000Z',
    });
    await new JsonMemberWorkSyncStore(backupPaths).write({
      ...status(),
      reportToken: backupIssued.token,
      reportTokenExpiresAt: backupIssued.expiresAt,
    });
    const liveTokens = new HmacMemberWorkSyncReportTokenAdapter(h.paths, fencedIdentity);
    const prepared = await createMemberWorkSyncRestoreParticipant(
      h.store,
      liveTokens,
      h.paths
    ).prepare({ ...identity, backupTeamsRoot: backupRoot });
    await Promise.race([
      mutex.run(identity.teamName, () => prepared.importAndVerify()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('restore reissue deadlocked on identity fence')), 3000);
      }),
    ]);
    const restored = await h.store.read(member);
    expect(restored?.reportToken).toBeTruthy();
    expect(restored?.reportToken).not.toBe(backupIssued.token);
  });

  it.each(['plain-json', 'sqlite'] as const)(
    'reissues live-only merged statuses after restore rotates the signing key %s',
    async (kind) => {
      const h = await setup('sqlite');
      const liveStore = kind === 'plain-json' ? h.json : h.store;
      const backupRoot = join(h.root, 'backup-teams');
      const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
      const backupTokens = new HmacMemberWorkSyncReportTokenAdapter(
        backupPaths,
        createTestWorkSyncIdentity('inc-1')
      );
      await backupTokens.restoreBackupSecret(
        identity.teamName,
        JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) }),
        { teamName: identity.teamName, incarnation: identity.incarnation }
      );
      const backupIssued = await backupTokens.create({
        teamName: identity.teamName,
        memberName: member.memberName,
        agendaFingerprint: 'f',
        issuedAt: '2026-09-10T00:00:00.000Z',
      });
      await new JsonMemberWorkSyncStore(backupPaths).write({
        ...status(),
        reportToken: backupIssued.token,
        reportTokenExpiresAt: backupIssued.expiresAt,
      });
      await mkdir(h.paths.getTeamDir(identity.teamName), { recursive: true });
      await writeFile(
        h.paths.getReportTokenSecretPath(identity.teamName),
        JSON.stringify({
          schemaVersion: 2,
          teamName: identity.teamName,
          incarnation: 'old-incarnation',
          secret: 'b'.repeat(32),
        })
      );
      const staleTokens = new HmacMemberWorkSyncReportTokenAdapter(
        h.paths,
        createTestWorkSyncIdentity('old-incarnation')
      );
      const liveOnly = {
        ...status(2),
        memberName: 'bob',
        evaluatedAt: '2026-09-11T00:00:00.000Z',
        agenda: { ...status(2).agenda, memberName: 'bob' },
        statusRevision: {
          incarnation: identity.incarnation,
          lineageId: 'bob-lineage',
          sequence: 2,
          nonce: 'nonce-bob',
        },
      };
      const liveIssued = await staleTokens.create({
        teamName: identity.teamName,
        memberName: liveOnly.memberName,
        agendaFingerprint: liveOnly.agenda.fingerprint,
        issuedAt: '2026-09-10T00:00:00.000Z',
      });
      await liveStore.write({
        ...liveOnly,
        reportToken: liveIssued.token,
        reportTokenExpiresAt: liveIssued.expiresAt,
      });
      const liveTokens = new HmacMemberWorkSyncReportTokenAdapter(
        h.paths,
        createTestWorkSyncIdentity('inc-1')
      );
      const prepared = await createMemberWorkSyncRestoreParticipant(
        liveStore,
        liveTokens,
        h.paths
      ).prepare({ ...identity, backupTeamsRoot: backupRoot });
      await prepared.importAndVerify();
      const restoredLive = await liveStore.read({
        teamName: identity.teamName,
        memberName: liveOnly.memberName,
      });
      expect(restoredLive?.reportToken).toBeTruthy();
      expect(restoredLive?.reportToken).not.toBe(liveIssued.token);
      await expect(
        liveTokens.verify({
          teamName: identity.teamName,
          memberName: liveOnly.memberName,
          agendaFingerprint: liveOnly.agenda.fingerprint,
          token: restoredLive?.reportToken ?? '',
          nowIso: '2026-09-10T00:00:00.000Z',
        })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        liveTokens.verify({
          teamName: identity.teamName,
          memberName: liveOnly.memberName,
          agendaFingerprint: liveOnly.agenda.fingerprint,
          token: liveIssued.token,
          nowIso: '2026-09-10T00:00:00.000Z',
        })
      ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    }
  );

  it('reissues leftover live tokens on restore retry after the key already rotated', async () => {
    const h = await setup('sqlite');
    const backupRoot = join(h.root, 'backup-teams');
    const backupPaths = new MemberWorkSyncStorePaths(backupRoot);
    const backupTokens = new HmacMemberWorkSyncReportTokenAdapter(
      backupPaths,
      createTestWorkSyncIdentity('inc-1')
    );
    await backupTokens.restoreBackupSecret(
      identity.teamName,
      JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) }),
      { teamName: identity.teamName, incarnation: identity.incarnation }
    );
    const backupIssued = await backupTokens.create({
      teamName: identity.teamName,
      memberName: member.memberName,
      agendaFingerprint: 'f',
      issuedAt: '2026-09-10T00:00:00.000Z',
    });
    await new JsonMemberWorkSyncStore(backupPaths).write({
      ...status(),
      reportToken: backupIssued.token,
      reportTokenExpiresAt: backupIssued.expiresAt,
    });
    const liveTokens = new HmacMemberWorkSyncReportTokenAdapter(
      h.paths,
      createTestWorkSyncIdentity('inc-1')
    );
    await liveTokens.restoreBackupSecret(
      identity.teamName,
      JSON.stringify({ schemaVersion: 1, secret: 'c'.repeat(32) }),
      { teamName: identity.teamName, incarnation: identity.incarnation }
    );
    const liveOnly = {
      ...status(2),
      memberName: 'bob',
      evaluatedAt: '2026-09-11T00:00:00.000Z',
      agenda: { ...status(2).agenda, memberName: 'bob' },
      statusRevision: {
        incarnation: identity.incarnation,
        lineageId: 'bob-lineage',
        sequence: 2,
        nonce: 'nonce-bob',
      },
    };
    await h.store.write({
      ...liveOnly,
      reportToken: backupIssued.token,
      reportTokenExpiresAt: backupIssued.expiresAt,
    });
    const secretSpy = vi.spyOn(liveTokens, 'restoreBackupSecret');
    const participant = createMemberWorkSyncRestoreParticipant(h.store, liveTokens, h.paths);
    const first = await participant.prepare({ ...identity, backupTeamsRoot: backupRoot });
    await first.importAndVerify();
    await expect(secretSpy.mock.results.at(-1)?.value).resolves.toEqual({ rotated: false });
    const afterFirst = await h.store.read({
      teamName: identity.teamName,
      memberName: liveOnly.memberName,
    });
    expect(afterFirst?.reportToken).toBeTruthy();
    expect(afterFirst?.reportToken).not.toBe(backupIssued.token);
    await expect(
      liveTokens.verify({
        teamName: identity.teamName,
        memberName: liveOnly.memberName,
        agendaFingerprint: liveOnly.agenda.fingerprint,
        token: afterFirst?.reportToken ?? '',
        nowIso: '2026-09-10T00:00:00.000Z',
      })
    ).resolves.toMatchObject({ ok: true });
    const second = await participant.prepare({ ...identity, backupTeamsRoot: backupRoot });
    await second.importAndVerify();
    const afterSecond = await h.store.read({
      teamName: identity.teamName,
      memberName: liveOnly.memberName,
    });
    expect(afterSecond?.reportToken).toBe(afterFirst?.reportToken);
    expect(afterSecond?.statusRevision).toEqual(afterFirst?.statusRevision);
  });

  it.each(['json', 'sqlite'] as const)(
    'restores external clean backup into %s and preserves revision',
    async (kind) => {
      const h = await setup(kind);
      await h.store.restoreValidatedBackup({
        identity,
        history: snapshot(),
        replica: { state: 'absent' },
        secretJson: null,
      });
      const observed = await h.store.withPreparedBackend(identity, (backend) =>
        backend.read(member.memberName)
      );
      expect(observed).toMatchObject({
        state: 'present',
        payload: { statusRevision: status().statusRevision },
      });
    }
  );

  it.each(['json', 'sqlite'] as const)(
    'rejects dirty backup without proven live continuity on %s',
    async (kind) => {
      const h = await setup(kind);
      const empty = { ...snapshot(), statuses: [] };
      await expect(
        h.store.restoreValidatedBackup({
          identity,
          history: empty,
          replica: { state: 'dirty', candidate: snapshot() },
          secretJson: null,
        })
      ).rejects.toThrow();
      expect((await h.gateway.listTeamSnapshot(identity.teamName)).statuses).toEqual([]);
    }
  );

  it.each(['json', 'sqlite'] as const)(
    'imports a clean snapshot without reseeding revision on %s',
    async (kind) => {
      const h = await setup(kind);
      await h.replica.writeClean(identity.teamName, snapshot(), identity.incarnation);
      const observed = await h.store.withPreparedBackend(identity, (backend) =>
        backend.read(member.memberName)
      );
      expect(observed).toMatchObject({
        state: 'present',
        payload: { statusRevision: status().statusRevision },
      });
      const again = await h.store.withPreparedBackend(identity, (backend) =>
        backend.read(member.memberName)
      );
      expect(again).toEqual(observed);
    }
  );

  it('persists dirty with sole candidate before the first SQLite import; failed import preserves evidence', async () => {
    const h = await setup();
    await h.replica.writeClean(identity.teamName, snapshot(), identity.incarnation);
    const operation = vi.fn();
    vi.spyOn(h.gateway, 'importTeam').mockImplementation(async () => {
      const source = await h.replica.readForAuthorityPreparation(
        identity.teamName,
        identity.incarnation
      );
      expect(source).toMatchObject({ state: 'dirty', candidate: { statuses: [status()] } });
      throw new Error('injected import failure');
    });
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow(
      'injected import failure'
    );
    expect(operation).not.toHaveBeenCalled();
    expect(
      await h.replica.readForAuthorityPreparation(identity.teamName, identity.incarnation)
    ).toMatchObject({ state: 'dirty', candidate: snapshot() });
  });

  it('does not infer primary continuity from a fresh database reporting integrity ok', async () => {
    const h = await setup();
    await h.replica.markDirtyWithRecoveryCandidate(
      identity.teamName,
      identity.incarnation,
      snapshot()
    );
    const before = await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8');
    const operation = vi.fn();
    const importSpy = vi.spyOn(h.gateway, 'importTeam');
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
    expect(await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')).toBe(
      before
    );
  });

  it('retains a newer primary revision when rebuilding dirty replica', async () => {
    const h = await setup();
    await h.gateway.importTeam(
      identity.teamName,
      snapshotToRecords(identity.teamName, snapshot(status(2)))
    );
    await h.replica.markDirtyWithRecoveryCandidate(
      identity.teamName,
      identity.incarnation,
      snapshot()
    );
    const observed = await h.store.withPreparedBackend(identity, (backend) =>
      backend.read(member.memberName)
    );
    expect(observed).toMatchObject({
      state: 'present',
      payload: { statusRevision: { sequence: 2 } },
    });
    expect(
      await h.replica.readForAuthorityPreparation(identity.teamName, identity.incarnation)
    ).toMatchObject({ state: 'clean', snapshot: snapshot(status(2)) });
  });

  it('rejects wrong nested replica ownership before normalization or dirty publication', async () => {
    const h = await setup();
    const value = snapshot();
    value.statuses[0].agenda.memberName = 'bob';
    await h.replica.writeClean(identity.teamName, value, identity.incarnation);
    const before = await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8');
    const operation = vi.fn();
    const importSpy = vi.spyOn(h.gateway, 'importTeam');
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
    expect(await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')).toBe(
      before
    );
  });

  it('preserves a malformed local status even with a clean replica available', async () => {
    const h = await setup();
    await h.replica.writeClean(identity.teamName, snapshot(), identity.incarnation);
    const file = h.paths.getMemberStatusPath(identity.teamName, member.memberName);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{broken');
    const operation = vi.fn();
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
  it('does not publish dirty or clean again for a stable prepared read', async () => {
    const h = await setup();
    await h.gateway.importTeam(identity.teamName, snapshotToRecords(identity.teamName, snapshot()));
    await h.replica.writeClean(identity.teamName, snapshot(), identity.incarnation);
    await h.store.withPreparedBackend(identity, (backend) => backend.read(member.memberName));
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate');
    const clean = vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean');
    const importSpy = vi.spyOn(h.gateway, 'importTeam');
    await h.store.withPreparedBackend(identity, (backend) => backend.read(member.memberName));
    expect(dirty).not.toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('uses one capped merge for preparation and read-back', async () => {
    const h = await setup();
    const left = snapshot();
    const right = snapshot();
    const events = (prefix: string) =>
      Array.from({ length: 150 }, (_, index) => ({
        ...member,
        id: `${prefix}-${index}`,
        kind: 'status_evaluated' as const,
        state: 'needs_sync' as const,
        agendaFingerprint: 'f',
        actionableCount: 0,
        recordedAt: `2026-09-10T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }));
    left.metricEvents = events('primary');
    right.metricEvents = events('replica');
    await h.gateway.importTeam(identity.teamName, snapshotToRecords(identity.teamName, left));
    await h.replica.writeClean(identity.teamName, right, identity.incarnation);
    const result = await h.store.withPreparedBackend(identity, (backend) =>
      backend.read(member.memberName)
    );
    expect(result.state).toBe('present');
    expect((await h.gateway.listTeamSnapshot(identity.teamName)).metricEvents).toHaveLength(200);
  });

  it.each(['payload-shape', 'recipient', 'hash'] as const)(
    'rejects a malformed trailing outbox before any import: %s',
    async (defect) => {
      const h = await setup();
      const value = snapshot();
      value.outboxItems.push({
        id: 'outbox-1',
        ...member,
        agendaFingerprint: 'f',
        payloadHash: 'invalid',
        status: 'pending',
        attemptGeneration: 0,
        createdAt: status().evaluatedAt,
        updatedAt: status().evaluatedAt,
        payload:
          defect === 'payload-shape'
            ? { to: member.memberName }
            : {
                from: 'system',
                to: defect === 'recipient' ? 'bob' : member.memberName,
                messageKind: 'member_work_sync_nudge',
                source: 'member-work-sync',
                actionMode: 'do',
                workSyncIntent: 'agenda_sync',
                text: 'sync',
                taskRefs: [],
              },
      } as MemberWorkSyncStoreSnapshot['outboxItems'][number]);
      await h.replica.writeClean(identity.teamName, value, identity.incarnation);
      const before = await readFile(
        h.paths.getSqliteFallbackReplicaPath(identity.teamName),
        'utf8'
      );
      const importSpy = vi.spyOn(h.gateway, 'importTeam');
      const operation = vi.fn();
      await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(importSpy).not.toHaveBeenCalled();
      expect(await h.gateway.listTeamSnapshot(identity.teamName)).toMatchObject({
        statuses: [],
        outboxItems: [],
      });
      expect(await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')).toBe(
        before
      );
    }
  );
  it('accepts stored same-team case aliases before controlled normalization', async () => {
    const h = await setup();
    await h.gateway.importTeam(identity.teamName, snapshotToRecords(identity.teamName, snapshot()));
    const read = h.gateway.listTeamSnapshot.bind(h.gateway);
    vi.spyOn(h.gateway, 'listTeamSnapshot').mockImplementationOnce(async (team) => {
      const value = await read(team);
      value.statuses[0].teamName = 'SANDBOX';
      const payload = JSON.parse(value.statuses[0].statusJson);
      payload.teamName = 'SANDBOX';
      payload.agenda.teamName = 'SANDBOX';
      value.statuses[0].statusJson = JSON.stringify(payload);
      return value;
    });
    const result = await h.store.withPreparedBackend(identity, (backend) =>
      backend.read(member.memberName)
    );
    expect(result).toMatchObject({
      state: 'present',
      payload: { statusRevision: status().statusRevision },
    });
  });

  it('rejects foreign raw primary ownership before normalization', async () => {
    const h = await setup();
    const records = snapshotToRecords(identity.teamName, snapshot());
    records.statuses[0].teamName = 'other-team';
    vi.spyOn(h.gateway, 'listTeamSnapshot').mockResolvedValue(records);
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate');
    const operation = vi.fn();
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
  });

  it('rejects invalid metric ownership before dirty publication or import', async () => {
    const h = await setup();
    const value = snapshot();
    value.metricEvents.push({
      ...member,
      memberName: '',
      id: 'bad-metric',
      kind: 'status_evaluated',
      state: 'needs_sync',
      agendaFingerprint: 'f',
      recordedAt: status().evaluatedAt,
      actionableCount: 0,
    });
    await h.replica.writeClean(identity.teamName, value, identity.incarnation);
    const before = await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8');
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate');
    const importSpy = vi.spyOn(h.gateway, 'importTeam');
    const operation = vi.fn();
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow();
    expect(dirty).not.toHaveBeenCalled();
    expect(importSpy).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(h.paths.getSqliteFallbackReplicaPath(identity.teamName), 'utf8')).toBe(
      before
    );
  });

  it('bounds same-incarnation preparation failures and allows retry after cooldown or privileged invalidation', async () => {
    const h = await setup();
    await h.json.write(status());
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const finalize = vi
      .spyOn(h.sqlite, 'prepareCanonicalStatus')
      .mockRejectedValue(new Error('archive unavailable'));
    const dirty = vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirtyWithRecoveryCandidate');
    const operation = vi.fn();
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow(
      'archive unavailable'
    );
    for (let index = 0; index < 100; index++)
      await expect(
        h.store.withPreparedBackend(
          { ...identity, teamName: index % 2 ? 'SANDBOX' : identity.teamName },
          operation
        )
      ).rejects.toThrow('archive unavailable');
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledTimes(1);
    now += 60_001;
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow(
      'archive unavailable'
    );
    expect(finalize).toHaveBeenCalledTimes(2);
    await h.store.invalidatePreparedTeam('SANDBOX');
    await expect(h.store.withPreparedBackend(identity, operation)).rejects.toThrow(
      'archive unavailable'
    );
    expect(finalize).toHaveBeenCalledTimes(3);
    expect(operation).not.toHaveBeenCalled();
  });

  it('retries privileged restore immediately after a preparation failure is repaired', async () => {
    const h = await setup();
    const backup = {
      identity,
      history: snapshot(),
      replica: { state: 'absent' as const },
      secretJson: null,
    };
    const finalize = vi.spyOn(h.sqlite, 'prepareCanonicalStatus');
    finalize.mockRejectedValueOnce(new Error('temporary archive failure'));
    await expect(h.store.restoreValidatedBackup(backup)).rejects.toThrow(
      'temporary archive failure'
    );
    await h.store.restoreValidatedBackup(backup);
    expect(
      await h.store.withPreparedBackend(identity, (backend) => backend.read(member.memberName))
    ).toMatchObject({
      state: 'present',
      payload: { statusRevision: status().statusRevision },
    });
  });

  it('does not reuse a previous incarnation preparation failure', async () => {
    const h = await setup();
    await h.replica.writeClean(identity.teamName, snapshot(), identity.incarnation);
    const source = vi.spyOn(InternalStorageJsonReplica.prototype, 'readForAuthorityPreparation');
    vi.spyOn(h.gateway, 'importTeam').mockRejectedValue(new Error('old import failure'));
    await expect(h.store.withPreparedBackend(identity, vi.fn())).rejects.toThrow(
      'old import failure'
    );
    await expect(h.store.withPreparedBackend(identity, vi.fn())).rejects.toThrow(
      'old import failure'
    );
    expect(source).toHaveBeenCalledTimes(1);
    await expect(
      h.store.withPreparedBackend({ ...identity, incarnation: 'new-incarnation' }, vi.fn())
    ).rejects.toThrow('incarnation mismatch');
    expect(source).toHaveBeenCalledTimes(2);
  });
  describe('incarnation mismatch diagnostics (fail-closed, nothing is deleted)', () => {
    const stale = (): MemberWorkSyncStatus => ({
      ...status(),
      statusRevision: { ...status().statusRevision!, incarnation: 'old-inc' },
    });
    const logged = (warn: ReturnType<typeof vi.fn>) =>
      warn.mock.calls.filter(([message]) => String(message).includes('another team identity'));
    const authorityOf = (h: Awaited<ReturnType<typeof setup>>) =>
      new MemberWorkSyncStatusAuthority({
        diagnosticDetail: readFailureDetail,
        identity: createTestWorkSyncIdentity(identity.incarnation),
        withPreparedBackend: (binding, operation) =>
          h.store.withPreparedBackend(binding, operation),
      });

    it('reports the source and foreign incarnation for stale SQLite rows and keeps every row', async () => {
      const warn = vi.fn();
      const h = await setup('sqlite', { warn });
      const bob = { ...snapshot(stale()).statuses[0], memberName: 'bob', statusRevision: status().statusRevision };
      await h.gateway.importTeam(identity.teamName, snapshotToRecords(identity.teamName, snapshot(stale())));
      await h.json.write(bob as MemberWorkSyncStatus);
      const primaryBefore = await h.gateway.listTeamSnapshot(identity.teamName);
      const activeBefore = await h.json.readSnapshotForImport(identity.teamName);
      const operation = vi.fn();
      await expect(h.store.withPreparedBackend({ ...identity, mutation: true }, operation)).rejects.toMatchObject({
        reason: 'incarnation_mismatch',
        foreignIncarnation: 'old-inc',
      });
      expect(operation).not.toHaveBeenCalled();
      expect(logged(warn)).toHaveLength(1);
      expect(logged(warn)[0][1]).toMatchObject({
        teamName: identity.teamName,
        incarnation: identity.incarnation,
        foreignIncarnation: 'old-inc',
        source: 'primary',
        detail: 'incarnation_mismatch',
        hint: expect.stringContaining('Nothing was changed'),
      });
      expect(await h.gateway.listTeamSnapshot(identity.teamName)).toEqual(primaryBefore);
      expect(await h.json.readSnapshotForImport(identity.teamName)).toEqual(activeBefore);
      // The failure cache still applies: a repeat within the window is not re-logged.
      await expect(h.store.withPreparedBackend({ ...identity, mutation: true }, operation)).rejects.toThrow();
      expect(logged(warn)).toHaveLength(1);
      // The public contract keeps `reason: corrupt` and only adds an optional detail.
      const read = authorityOf(h).startRead(member);
      await expect(read.result).resolves.toEqual({ ok: false, reason: 'corrupt', detail: 'incarnation_mismatch' });
      await read.settled;
    });

    it('reports a stale status inside a JSON replica and leaves the replica file untouched', async () => {
      const warn = vi.fn();
      const h = await setup('json', { warn });
      await h.replica.writeClean(identity.teamName, snapshot(stale()), identity.incarnation);
      const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
      const before = await readFile(path, 'utf8');
      await expect(h.store.withPreparedBackend(identity, vi.fn())).rejects.toMatchObject({
        reason: 'incarnation_mismatch',
        foreignIncarnation: 'old-inc',
      });
      expect(logged(warn)[0][1]).toMatchObject({ source: 'replica', foreignIncarnation: 'old-inc' });
      expect(await readFile(path, 'utf8')).toBe(before);
    });

    it('reports a replica written for another incarnation (wrapper) with its foreign incarnation', async () => {
      const warn = vi.fn();
      const h = await setup('json', { warn });
      await h.replica.writeClean(identity.teamName, snapshot(), 'old-inc');
      const path = h.paths.getSqliteFallbackReplicaPath(identity.teamName);
      const before = await readFile(path, 'utf8');
      await expect(h.store.withPreparedBackend(identity, vi.fn())).rejects.toThrow('incarnation mismatch');
      expect(logged(warn)[0][1]).toMatchObject({
        source: 'replica_wrapper',
        foreignIncarnation: 'old-inc',
        detail: 'incarnation_mismatch',
      });
      expect(await readFile(path, 'utf8')).toBe(before);
      const read = authorityOf(h).startRead(member);
      await expect(read.result).resolves.toEqual({ ok: false, reason: 'unavailable', detail: 'incarnation_mismatch' });
      await read.settled;
    });

    it('does not label unrelated preparation failures as an incarnation mismatch', async () => {
      const warn = vi.fn();
      const h = await setup('sqlite', { warn });
      vi.spyOn(h.gateway, 'listTeamSnapshot').mockRejectedValueOnce(new Error('disk offline'));
      await expect(h.store.withPreparedBackend(identity, vi.fn())).rejects.toThrow('disk offline');
      expect(logged(warn)).toHaveLength(0);
      const read = authorityOf(h).startRead(member);
      const result = await read.result;
      await read.settled;
      expect(result).not.toHaveProperty('detail');
    });
  });
});
