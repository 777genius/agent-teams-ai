import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { createMemberWorkSyncRestoreParticipant } from '@features/member-work-sync/main/composition/createMemberWorkSyncRestoreParticipant';
import { BackendSelectingMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncStore';
import { HmacMemberWorkSyncReportTokenAdapter } from '@features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import {
  buildPendingReportIntentId,
  isMemberWorkSyncStoreSnapshot,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import { recordsToSnapshot, snapshotToRecords } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { MemberWorkSyncStatusAuthority } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';
import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
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
async function setup(kind: 'json' | 'sqlite' = 'sqlite') {
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
  });
  const replica = new InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>(
    (team) => paths.getSqliteFallbackReplicaPath(team),
    isMemberWorkSyncStoreSnapshot
  );
  return { root, paths, gateway, json, sqlite, store, replica };
}

describe('prepared backend production storage path', () => {
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
});
