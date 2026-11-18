import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { BackendSelectingMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncStore';
import { MemberWorkSyncStatusDecodeError } from '@features/member-work-sync/main/infrastructure/decodeMemberWorkSyncStoredStatus';
import {
  buildPendingReportIntentId,
  isMemberWorkSyncStoreSnapshot,
  JsonMemberWorkSyncStore,
} from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncSqliteImporter } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncSqliteImporter';
import {
  recordsToSnapshot,
  snapshotToRecords,
} from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { MemberWorkSyncStatusAuthority } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';
import {
  getVerifiedTeamRootBirthtimeMs,
  healStaleIncarnationStatuses,
} from '@features/member-work-sync/main/infrastructure/memberWorkSyncStaleIncarnationHeal';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { SqliteMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/SqliteMemberWorkSyncStore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';
import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStoreSnapshot } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';

// Exercise success and refusal paths independent of host tmpfs birthtime semantics.
const rootAgeFixture = vi.hoisted(() => ({ known: true }));
vi.mock('node:fs/promises', async (loadOriginal) => {
  const fs = await loadOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const result = await fs.lstat(...args);
      if (String(args[0]).replaceAll('\\', '/').endsWith('/teams/sandbox')) {
        const birthtimeMs = Date.parse('2024-01-01T00:00:00.000Z');
        return Object.assign(result, {
          birthtimeMs,
          ctimeMs: rootAgeFixture.known ? birthtimeMs + 1000 : birthtimeMs,
        });
      }
      return result;
    },
  };
});

const TEAM = 'sandbox';
const CURRENT = 'inc-1';
const FOREIGN = 'old-inc';
const OLD = '2020-01-01T00:00:00.000Z';
const identity = { teamName: TEAM, incarnation: CURRENT, mutation: false };

function mk(
  memberName: string,
  incarnation: string,
  evaluatedAt = OLD,
  teamName = TEAM
): MemberWorkSyncStatus {
  const owner = { teamName, memberName };
  return {
    ...owner,
    state: 'needs_sync',
    evaluatedAt,
    diagnostics: [],
    agenda: { ...owner, generatedAt: evaluatedAt, fingerprint: 'f', items: [], diagnostics: [] },
    statusRevision: { incarnation, lineageId: 'lineage', sequence: 1, nonce: `n-${memberName}` },
  };
}
function snap(statuses: MemberWorkSyncStatus[]): MemberWorkSyncStoreSnapshot {
  return { statuses, reportIntents: [], outboxItems: [], metricEvents: [], filesToArchive: [] };
}

const roots: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
afterEach(async () => {
  rootAgeFixture.known = true;
  vi.restoreAllMocks();
  for (const core of cores.splice(0)) core.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(
  kind: 'json' | 'sqlite' = 'sqlite',
  opts: { config?: Record<string, unknown> | null; fallbackRequiresReplica?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'mws-stale-heal-'));
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
  const warn = vi.fn();
  const store = new BackendSelectingMemberWorkSyncStore(selector, sqlite, json, {
    gateway,
    paths,
    fallbackRequiresReplica: opts.fallbackRequiresReplica ?? false,
    logger: { warn },
  });
  const replica = new InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>(
    (team) => paths.getSqliteFallbackReplicaPath(team),
    isMemberWorkSyncStoreSnapshot
  );
  // The team directory is created NOW, after the stale rows' evaluatedAt, like a recreated team.
  const teamRoot = paths.getTeamRootDir(TEAM);
  await mkdir(teamRoot, { recursive: true });
  if (opts.config !== null)
    await writeFile(
      join(teamRoot, 'config.json'),
      JSON.stringify(opts.config ?? { name: TEAM, _backupIdentityId: CURRENT })
    );
  return { root, paths, gateway, json, sqlite, store, replica, warn, teamRoot };
}
type H = Awaited<ReturnType<typeof setup>>;

async function writeReplica(
  h: H,
  state: 'clean' | 'dirty',
  incarnation: string,
  snapshot: MemberWorkSyncStoreSnapshot,
  updatedAt = OLD
) {
  const path = h.paths.getSqliteFallbackReplicaPath(TEAM);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, state, updatedAt, snapshot, incarnation }, null, 2)}\n`
  );
}
const primary = (h: H, team = TEAM) => h.gateway.listTeamSnapshot(team);
const importPrimary = (h: H, statuses: MemberWorkSyncStatus[], team = TEAM) =>
  h.gateway.importTeam(team, snapshotToRecords(team, snap(statuses)));
const memberKeys = async (h: H) => (await primary(h)).statuses.map((row) => row.memberName).sort();
const quarantineFiles = async (h: H) =>
  (await readdir(h.paths.getTeamDir(TEAM)).catch(() => [] as string[])).filter((name) =>
    name.startsWith('stale-incarnation-')
  );
const prepare = (h: H, mutation = true) =>
  h.store.withPreparedBackend({ ...identity, mutation }, async () => 'ran');

describe('verified team directory creation time', () => {
  const directory = (birthtimeMs: number, ctimeMs: number, isDirectory = true) => ({
    birthtimeMs,
    ctimeMs,
    isDirectory: () => isDirectory,
  });

  it('refuses ctime fallback, invalid timestamps and non-directory paths', () => {
    expect(getVerifiedTeamRootBirthtimeMs(directory(1_000, 1_000))).toBeNull();
    expect(getVerifiedTeamRootBirthtimeMs(directory(0, 2_000))).toBeNull();
    expect(getVerifiedTeamRootBirthtimeMs(directory(Number.NaN, 2_000))).toBeNull();
    expect(getVerifiedTeamRootBirthtimeMs(directory(1_000, Number.NaN))).toBeNull();
    expect(getVerifiedTeamRootBirthtimeMs(directory(2_000, 1_000))).toBeNull();
    expect(getVerifiedTeamRootBirthtimeMs(directory(1_000, 2_000, false))).toBeNull();
  });

  it('accepts only creation time strictly preceding a later metadata change', () => {
    expect(getVerifiedTeamRootBirthtimeMs(directory(1_000, 2_000))).toBe(1_000);
  });
});

describe('targeted self-heal of status rows left by an earlier team identity', () => {
  it('removes only stale status rows and keeps current rows, other domains and the token secret', async () => {
    const h = await setup('sqlite');
    const value = snap([mk('alice', FOREIGN), mk('bob', CURRENT)]);
    value.metricEvents.push({
      id: 'm1',
      teamName: TEAM,
      memberName: 'bob',
      kind: 'status_evaluated',
      state: 'needs_sync',
      agendaFingerprint: 'f',
      recordedAt: OLD,
      actionableCount: 0,
    });
    value.reportIntents.push({
      teamName: TEAM,
      memberName: 'bob',
      id: 'i1',
      request: {
        teamName: TEAM,
        memberName: 'bob',
        state: 'still_working',
        agendaFingerprint: 'f',
      },
      reason: 'keep',
      status: 'pending',
      recordedAt: OLD,
    });
    await h.gateway.importTeam(TEAM, snapshotToRecords(TEAM, value));
    const secretPath = join(h.paths.getTeamDir(TEAM), 'report-token-secret.json');
    await mkdir(dirname(secretPath), { recursive: true });
    await writeFile(secretPath, '{"secret":"keep-me"}');
    const before = await primary(h);

    await expect(prepare(h)).resolves.toBe('ran');

    const after = await primary(h);
    expect(after.statuses.map((row) => row.memberName)).toEqual(['bob']);
    expect(after.statuses[0]).toEqual(before.statuses.find((row) => row.memberName === 'bob'));
    expect(after.metricEvents).toEqual(before.metricEvents);
    expect(after.reportIntents).toEqual(before.reportIntents);
    expect(after.outboxItems).toEqual(before.outboxItems);
    expect(await readFile(secretPath, 'utf8')).toBe('{"secret":"keep-me"}');
    const [quarantine] = await quarantineFiles(h);
    const record = JSON.parse(await readFile(join(h.paths.getTeamDir(TEAM), quarantine), 'utf8'));
    expect(JSON.stringify(record)).toContain('alice');
    expect(JSON.stringify(record)).toContain(FOREIGN);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale'),
      expect.objectContaining({ teamName: TEAM, incarnation: CURRENT, removed: 1 })
    );
    const envelope = JSON.parse(await readFile(h.paths.getSqliteFallbackReplicaPath(TEAM), 'utf8'));
    expect(envelope).toMatchObject({ state: 'clean', incarnation: CURRENT });
    expect(envelope.snapshot.statuses.map((s: MemberWorkSyncStatus) => s.memberName)).toEqual([
      'bob',
    ]);
  });

  it('heals a team whose every status is stale and stays healed (idempotent, no repeat work)', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    await expect(prepare(h)).resolves.toBe('ran');
    expect(await memberKeys(h)).toEqual([]);
    const imported = vi.spyOn(h.gateway, 'statusDeleteMatching');
    await expect(prepare(h, false)).resolves.toBe('ran');
    await expect(prepare(h, false)).resolves.toBe('ran');
    expect(imported).not.toHaveBeenCalled();
    expect(await quarantineFiles(h)).toHaveLength(1);
  });

  it('heals stale active JSON files and archived generations in one pass and keeps current JSON statuses', async () => {
    const h = await setup('sqlite');
    await h.json.write(mk('carol', FOREIGN));
    await h.json.write(mk('bob', CURRENT));
    const carolPath = h.paths.getMemberStatusPath(TEAM, 'carol');
    await copyFile(carolPath, `${carolPath}.pre-sqlite`);
    const bobPath = h.paths.getMemberStatusPath(TEAM, 'bob');
    const bobRaw = await readFile(bobPath, 'utf8');

    await expect(prepare(h)).resolves.toBe('ran');

    // Current-incarnation JSON status written during a fallback period survives and is imported.
    expect(await memberKeys(h)).toEqual(['bob']);
    expect(JSON.parse((await primary(h)).statuses[0].statusJson).statusRevision.incarnation).toBe(
      CURRENT
    );
    expect(bobRaw).toContain('"bob"');
    const names = await readdir(dirname(carolPath));
    expect(names.filter((name) => name.includes('.stale-incarnation.'))).toHaveLength(2);
    expect(names).not.toContain('status.json');
    expect(names).not.toContain('status.json.pre-sqlite');
    // A second preparation needs no further healing.
    await expect(prepare(h, false)).resolves.toBe('ran');
    expect(await quarantineFiles(h)).toHaveLength(1);
  });

  it('removes only stale entries of a legacy members map', async () => {
    const h = await setup('json');
    const legacyPath = h.paths.getLegacyStatusPath(TEAM);
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        members: { alice: mk('alice', FOREIGN), bob: mk('bob', CURRENT) },
      })
    );
    await expect(prepare(h)).resolves.toBe('ran');
    const kept = JSON.parse(await readFile(legacyPath, 'utf8'));
    expect(Object.keys(kept.members)).toEqual(['bob']);
  });

  it('preserves legacy metrics when every legacy status is stale', async () => {
    const h = await setup('sqlite');
    const legacyPath = h.paths.getLegacyStatusPath(TEAM);
    const metric = {
      id: 'legacy-only-metric',
      teamName: TEAM,
      memberName: 'alice',
      kind: 'status_evaluated' as const,
      state: 'needs_sync' as const,
      agendaFingerprint: 'f',
      recordedAt: OLD,
      actionableCount: 0,
    };
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        members: { alice: mk('alice', FOREIGN) },
        metrics: { recentEvents: [metric] },
      })
    );
    const outcome = await healStaleIncarnationStatuses({
      teamName: TEAM,
      incarnation: CURRENT,
      backend: 'sqlite',
      error: new MemberWorkSyncStatusDecodeError('incarnation_mismatch', FOREIGN),
      gateway: h.gateway,
      paths: h.paths,
      replica: h.replica,
      logger: { warn: h.warn },
    });
    expect(outcome).toBe('healed');
    expect(JSON.parse(await readFile(legacyPath, 'utf8'))).toMatchObject({
      members: {},
      metrics: { recentEvents: [metric] },
    });
    await expect(prepare(h)).resolves.toBe('ran');
    expect((await primary(h)).statuses).toEqual([]);
    expect((await primary(h)).metricEvents).toEqual([
      expect.objectContaining({ id: metric.id, memberName: metric.memberName }),
    ]);
  });

  it('refuses to promote a foreign replica without the SQLite primary available', async () => {
    const h = await setup('json');
    await h.json.write(mk('bob', CURRENT));
    await h.json.write(mk('alice', FOREIGN));
    await writeReplica(h, 'clean', FOREIGN, snap([mk('bob', CURRENT)]));
    const bobPath = h.paths.getMemberStatusPath(TEAM, 'bob');
    const alicePath = h.paths.getMemberStatusPath(TEAM, 'alice');
    const replicaPath = h.paths.getSqliteFallbackReplicaPath(TEAM);
    const bobRaw = await readFile(bobPath, 'utf8');
    const aliceRaw = await readFile(alicePath, 'utf8');
    const replicaRaw = await readFile(replicaPath, 'utf8');

    await expect(prepare(h)).rejects.toThrow();

    expect(await readFile(bobPath, 'utf8')).toBe(bobRaw);
    expect(await readFile(alicePath, 'utf8')).toBe(aliceRaw);
    expect(await readFile(replicaPath, 'utf8')).toBe(replicaRaw);
    expect(await quarantineFiles(h)).toEqual([]);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'foreign_replica_requires_primary' })
    );
  });

  it('keeps SQLite-only current status readable through JSON fallback after cleanup crash', async () => {
    const h = await setup('sqlite', { fallbackRequiresReplica: true });
    await importPrimary(h, [mk('bob', CURRENT)]);
    await writeReplica(h, 'clean', FOREIGN, snap([mk('alice', FOREIGN)]));
    const heal = await healStaleIncarnationStatuses({
      teamName: TEAM,
      incarnation: CURRENT,
      backend: 'sqlite',
      error: new MemberWorkSyncStatusDecodeError('incarnation_mismatch', FOREIGN),
      gateway: h.gateway,
      paths: h.paths,
      replica: h.replica,
      logger: { warn: h.warn },
    });
    expect(heal).toBe('healed');
    // Simulate process death here: there is no authority preparation retry.
    const envelope = JSON.parse(
      await readFile(h.paths.getSqliteFallbackReplicaPath(TEAM), 'utf8')
    ) as { state: string; incarnation: string; snapshot: MemberWorkSyncStoreSnapshot };
    expect(envelope.state).toBe('clean');
    expect(envelope.incarnation).toBe(CURRENT);
    expect(envelope.snapshot.statuses.map((status) => status.memberName)).toEqual(['bob']);

    const jsonFallback = new BackendSelectingMemberWorkSyncStore(
      new InternalStorageBackendSelector(() => Promise.reject(new Error('SQLite unavailable'))),
      h.sqlite,
      h.json,
      { gateway: h.gateway, paths: h.paths, fallbackRequiresReplica: true }
    );
    const authority = new MemberWorkSyncStatusAuthority({
      identity: createTestWorkSyncIdentity(CURRENT),
      withPreparedBackend: (binding, operation) =>
        jsonFallback.withPreparedBackend(binding, operation),
    });
    const read = authority.startRead({ teamName: TEAM, memberName: 'bob' });
    const result = await read.result;
    await read.settled;
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        status: { memberName: 'bob', statusRevision: { incarnation: CURRENT } },
      },
    });
  });

  it('refuses a foreign dirty replica without a candidate before deleting SQLite statuses', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const path = h.paths.getSqliteFallbackReplicaPath(TEAM);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, state: 'dirty', incarnation: FOREIGN, updatedAt: OLD })
    );
    const before = await primary(h);
    await expect(prepare(h)).rejects.toThrow();
    expect(await primary(h)).toEqual(before);
    expect(await quarantineFiles(h)).toEqual([]);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'dirty_replica_from_another_identity' })
    );
  });

  it('refuses conflicting lineages among retained foreign-replica statuses', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const bob = mk('bob', CURRENT);
    const conflicting = {
      ...mk('Bob', CURRENT),
      statusRevision: { ...bob.statusRevision!, lineageId: 'another-lineage' },
    };
    await writeReplica(h, 'clean', FOREIGN, snap([bob, conflicting]));
    const before = await primary(h);
    const replicaPath = h.paths.getSqliteFallbackReplicaPath(TEAM);
    const replicaBefore = await readFile(replicaPath, 'utf8');
    await expect(prepare(h)).rejects.toThrow();
    expect(await primary(h)).toEqual(before);
    expect(await readFile(replicaPath, 'utf8')).toBe(replicaBefore);
    expect(await quarantineFiles(h)).toEqual([]);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'replica_retained_state_invalid' })
    );
  });

  it('never touches other teams, even ones that look stale', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const otherStatus = mk('zed', FOREIGN, OLD, 'other');
    await importPrimary(h, [otherStatus], 'other');
    await h.json.write(otherStatus);
    const otherPath = h.paths.getMemberStatusPath('other', 'zed');
    const otherRaw = await readFile(otherPath, 'utf8');
    const otherRows = await primary(h, 'other');

    await expect(prepare(h)).resolves.toBe('ran');

    expect(await primary(h, 'other')).toEqual(otherRows);
    expect(await readFile(otherPath, 'utf8')).toBe(otherRaw);
  });

  it('waits for in-flight storage writers before changing anything', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const order: string[] = [];
    const listed = h.gateway.listTeamSnapshot.bind(h.gateway);
    vi.spyOn(h.gateway, 'listTeamSnapshot').mockImplementation(async (...args) => {
      order.push('list');
      return listed(...args);
    });
    let finishSettling!: () => void;
    const settling = new Promise<void>((resolve) => { finishSettling = resolve; });
    (h.gateway as { waitForSettling?: () => Promise<void> }).waitForSettling = async () => {
      order.push('settle');
      await settling;
    };
    const deleteMatching = h.gateway.statusDeleteMatching.bind(h.gateway);
    vi.spyOn(h.gateway, 'statusDeleteMatching').mockImplementation(async (...args) => {
      order.push('delete');
      return deleteMatching(...args);
    });
    const pending = prepare(h);
    try {
      await vi.waitFor(() => expect(order).toEqual(['list', 'settle']));
    } finally {
      finishSettling();
    }
    await pending;
    // Initial detection, physical settlement, fresh snapshot, then the targeted deletion.
    expect(order.slice(0, 4)).toEqual(['list', 'settle', 'list', 'delete']);
  });

  describe.each([
    ['no team config', { config: null }],
    ['config without an identity marker', { config: { name: TEAM } }],
    ['config naming another identity', { config: { name: TEAM, _backupIdentityId: 'other-inc' } }],
  ] as const)('stays fail-closed with %s', (_label, opts) => {
    it('changes nothing', async () => {
      const h = await setup('sqlite', { config: opts.config as never });
      await importPrimary(h, [mk('alice', FOREIGN), mk('bob', CURRENT)]);
      const before = await primary(h);
      const imported = vi.spyOn(h.gateway, 'statusDeleteMatching');
      await expect(prepare(h)).rejects.toMatchObject({ reason: 'incarnation_mismatch' });
      expect(await primary(h)).toEqual(before);
      expect(imported).not.toHaveBeenCalled();
      expect(await quarantineFiles(h)).toEqual([]);
    });
  });

  it('refuses when the stale rows are not older than the current team directory', async () => {
    const h = await setup('sqlite');
    // Stands in for a team whose identity marker was lost and re-minted: the rows are newer
    // than the directory, so they cannot be proven to belong to an earlier team.
    await importPrimary(h, [mk('alice', FOREIGN, '2999-01-01T00:00:00.000Z')]);
    const before = await primary(h);
    await expect(prepare(h)).rejects.toMatchObject({ reason: 'incarnation_mismatch' });
    expect(await primary(h)).toEqual(before);
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('refuses a foreign status evaluated at the same instant as team creation', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN, '2024-01-01T00:00:00.000Z')]);
    const before = await primary(h);
    await expect(prepare(h)).rejects.toMatchObject({ reason: 'incarnation_mismatch' });
    expect(await primary(h)).toEqual(before);
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('refuses while a purge of this team is pending', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const marker = h.paths.getPendingPrimaryPurgePath(TEAM);
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(
      marker,
      JSON.stringify({
        schemaVersion: 2,
        teamName: TEAM,
        deletionIdentityId: 'gone',
        teamRootIdentity: null,
        activeJsonStateCleared: false,
      })
    );
    const before = await primary(h);
    await expect(prepare(h)).rejects.toThrow();
    expect(await primary(h)).toEqual(before);
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('does not heal on backup restore or preflight', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const before = await primary(h);
    const candidate = {
      identity,
      history: snap([mk('bob', CURRENT)]),
      replica: { state: 'absent' as const },
      secretJson: null,
    };
    await expect(h.store.preflightValidatedBackup(candidate)).rejects.toThrow();
    await expect(h.store.restoreValidatedBackup(candidate)).rejects.toThrow();
    expect(await primary(h)).toEqual(before);
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('refuses a dirty replica from another incarnation (continuity cannot be proven)', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    await writeReplica(h, 'dirty', FOREIGN, snap([mk('alice', FOREIGN)]));
    const replicaPath = h.paths.getSqliteFallbackReplicaPath(TEAM);
    const replicaBefore = await readFile(replicaPath, 'utf8');
    const before = await primary(h);
    await expect(prepare(h)).rejects.toThrow('incarnation mismatch');
    expect(await primary(h)).toEqual(before);
    expect(await readFile(replicaPath, 'utf8')).toBe(replicaBefore);
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('converges after a crash between the primary cleanup and the replica rewrite', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN), mk('bob', CURRENT)]);
    await writeReplica(h, 'clean', FOREIGN, snap([mk('alice', FOREIGN), mk('bob', CURRENT)]));
    vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean').mockRejectedValueOnce(
      new Error('simulated crash')
    );
    await expect(prepare(h)).rejects.toThrow();
    expect(await memberKeys(h)).toEqual(['bob']);

    await h.store.invalidatePreparedTeam(TEAM);
    await expect(prepare(h)).resolves.toBe('ran');
    expect(await memberKeys(h)).toEqual(['bob']);
    const envelope = JSON.parse(await readFile(h.paths.getSqliteFallbackReplicaPath(TEAM), 'utf8'));
    expect(envelope).toMatchObject({ state: 'clean', incarnation: CURRENT });
  });

  it('lets the authority read a surviving member right after healing', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN), mk('bob', CURRENT)]);
    const authority = new MemberWorkSyncStatusAuthority({
      identity: createTestWorkSyncIdentity(CURRENT),
      withPreparedBackend: (binding, operation) => h.store.withPreparedBackend(binding, operation),
    });
    const read = authority.startRead({ teamName: TEAM, memberName: 'bob' });
    const result = await read.result;
    await read.settled;
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        status: {
          teamName: TEAM,
          memberName: 'bob',
          statusRevision: { incarnation: CURRENT },
        },
      },
    });
  });

  it('keeps the identity fence until an interrupted cleanup import settles', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    let settle!: () => void;
    const physical = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const interrupted = new InternalStorageOperationInterruptedError(
      'interrupted cleanup import',
      'unknown',
      physical
    );
    vi.spyOn(h.gateway, 'statusDeleteMatching').mockRejectedValueOnce(interrupted);
    const owner = createTestWorkSyncIdentity(CURRENT);
    const originalWithCurrent = owner.withCurrent.bind(owner);
    let held = false;
    const authority = new MemberWorkSyncStatusAuthority({
      identity: {
        ...owner,
        withCurrent: async (teamName, incarnation, operation) => {
          held = true;
          try {
            return await originalWithCurrent(teamName, incarnation, operation);
          } finally {
            held = false;
          }
        },
      },
      withPreparedBackend: (binding, operation) => h.store.withPreparedBackend(binding, operation),
    });
    const read = authority.startRead({ teamName: TEAM, memberName: 'bob' });
    try {
      await expect(read.result).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
      expect(held).toBe(true);
    } finally {
      settle();
      await read.settled;
    }
    expect(held).toBe(false);
  });

  it('refuses when creation time cannot be distinguished from ctime', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    rootAgeFixture.known = false;
    const before = await primary(h);
    await expect(prepare(h)).rejects.toThrow();
    expect(await primary(h)).toEqual(before);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'team_root_age_unknown' })
    );
  });

  it('does not rebind a foreign replica carrying an older outbox', async () => {
    const h = await setup('sqlite');
    const snapshot = snap([mk('alice', FOREIGN)]);
    snapshot.outboxItems.push({
      id: 'foreign-pending',
      teamName: TEAM,
      memberName: 'alice',
      agendaFingerprint: 'f',
      payloadHash: 'untrusted',
      payload: {
        from: 'system',
        to: 'alice',
        messageKind: 'member_work_sync_nudge',
        source: 'member-work-sync',
        actionMode: 'do',
        workSyncIntent: 'agenda_sync',
        text: 'old identity',
        taskRefs: [],
      },
      status: 'pending',
      attemptGeneration: 0,
      createdAt: OLD,
      updatedAt: OLD,
    });
    await writeReplica(h, 'clean', FOREIGN, snapshot);
    await importPrimary(h, [mk('bob', CURRENT)]);
    const before = await primary(h);
    const replicaPath = h.paths.getSqliteFallbackReplicaPath(TEAM);
    const replicaBefore = await readFile(replicaPath, 'utf8');
    await expect(prepare(h)).rejects.toThrow();
    expect(await primary(h)).toEqual(before);
    expect(await readFile(replicaPath, 'utf8')).toBe(replicaBefore);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'foreign_replica_non_status_data' })
    );
  });

  it('reports a foreign dirty replica even without stale status entries', async () => {
    const h = await setup('sqlite');
    await writeReplica(h, 'dirty', FOREIGN, snap([mk('bob', CURRENT)]));
    await expect(prepare(h)).rejects.toThrow();
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'dirty_replica_from_another_identity' })
    );
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('rolls back the whole SQLite deletion when any exact payload is stale', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN), mk('bob', FOREIGN)]);
    const before = await primary(h);
    const targets = before.statuses.map((row) => ({
      teamName: row.teamName,
      memberKey: row.memberKey,
      statusJson: row.statusJson,
    }));
    await expect(
      h.gateway.statusDeleteMatching(TEAM, [
        targets[0],
        { ...targets[1], statusJson: 'unexpected newer status' },
      ])
    ).rejects.toThrow('changed before deletion');
    expect(await primary(h)).toEqual(before);

    await expect(
      h.gateway.statusDeleteMatching(TEAM, [{ ...targets[0], teamName: 'another-team' }])
    ).rejects.toThrow('Invalid member-work-sync status deletion target');
    expect(await primary(h)).toEqual(before);
  });

  it('preserves a current legacy status keyed by __proto__ during cleanup', async () => {
    const h = await setup('json');
    const path = h.paths.getLegacyStatusPath(TEAM);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        members: Object.fromEntries([
          ['alice', mk('alice', FOREIGN)],
          ['__proto__', mk('__proto__', CURRENT)],
        ]),
      })
    );
    const result = await healStaleIncarnationStatuses({
      teamName: TEAM,
      incarnation: CURRENT,
      backend: 'json',
      error: new MemberWorkSyncStatusDecodeError('incarnation_mismatch', FOREIGN),
      gateway: h.gateway,
      paths: h.paths,
      replica: h.replica,
    });
    expect(result).toBe('healed');
    const after = JSON.parse(await readFile(path, 'utf8')) as { members: Record<string, MemberWorkSyncStatus> };
    expect(Object.keys(after.members)).toEqual(['__proto__']);
    expect(Object.hasOwn(after.members, '__proto__')).toBe(true);
    expect(after.members.__proto__.statusRevision?.incarnation).toBe(CURRENT);
  });

  it('refuses a primary status row with a mismatched member key', async () => {
    const h = await setup('sqlite');
    const source = snapshotToRecords(TEAM, snap([mk('bob', FOREIGN)]));
    const record = source.statuses[0];
    await h.gateway.importTeam(TEAM, {
      ...source,
      statuses: [{ ...record, memberKey: 'alice' }],
    });
    const before = await primary(h);
    const result = await healStaleIncarnationStatuses({
      teamName: TEAM,
      incarnation: CURRENT,
      backend: 'sqlite',
      error: new MemberWorkSyncStatusDecodeError('incarnation_mismatch', FOREIGN),
      gateway: h.gateway,
      paths: h.paths,
      replica: h.replica,
      logger: { warn: h.warn },
    });
    expect(result).toBe('refused');
    expect(await primary(h)).toEqual(before);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'primary_member_key_mismatch' })
    );
    expect(await quarantineFiles(h)).toEqual([]);
  });

  it('refuses a foreign replica with an unbound surviving status', async () => {
    const h = await setup('sqlite');
    const legacy = mk('bob', CURRENT);
    delete legacy.statusRevision;
    await writeReplica(h, 'clean', FOREIGN, snap([legacy]));
    const replicaPath = h.paths.getSqliteFallbackReplicaPath(TEAM);
    const before = await readFile(replicaPath, 'utf8');
    await expect(prepare(h)).rejects.toThrow();
    expect(await readFile(replicaPath, 'utf8')).toBe(before);
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'foreign_replica_unbound_status' })
    );
  });

  it('refuses a non-string replica incarnation rather than adopting its payload', async () => {
    const h = await setup('sqlite');
    const path = h.paths.getSqliteFallbackReplicaPath(TEAM);
    await mkdir(dirname(path), { recursive: true });
    const snapshot = snap([mk('bob', CURRENT)]);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        state: 'clean',
        updatedAt: OLD,
        incarnation: null,
        snapshot,
      })
    );
    await expect(prepare(h)).rejects.toThrow();
    const result = await readFile(path, 'utf8');
    expect(JSON.parse(result)).toMatchObject({ incarnation: null });
    expect(h.warn).toHaveBeenCalledWith(
      'member-work-sync stale status cleanup refused',
      expect.objectContaining({ reason: 'replica_incarnation_invalid' })
    );
  });

  it('deletes selected aliased SQLite statuses without rewriting other domain rows', async () => {
    const h = await setup('sqlite');
    const old = snap([
      mk('alice', FOREIGN, OLD, 'Sandbox'),
      mk('bob', CURRENT, OLD, 'Sandbox'),
    ]);
    old.metricEvents.push({
      id: 'legacy-metric',
      teamName: 'Sandbox',
      memberName: 'bob',
      kind: 'status_evaluated',
      state: 'needs_sync',
      agendaFingerprint: 'f',
      recordedAt: OLD,
      actionableCount: 0,
    });
    await h.gateway.importTeam('Sandbox', snapshotToRecords('Sandbox', old));
    const before = await primary(h);
    const result = await healStaleIncarnationStatuses({
      teamName: TEAM,
      incarnation: CURRENT,
      backend: 'sqlite',
      error: new MemberWorkSyncStatusDecodeError('incarnation_mismatch', FOREIGN),
      gateway: h.gateway,
      paths: h.paths,
      replica: h.replica,
      logger: { warn: h.warn },
    });
    expect(result).toBe('healed');
    const after = await primary(h);
    expect(after).toEqual({
      ...before,
      statuses: before.statuses.filter((row) => row.memberName !== 'alice'),
    });
    expect(after.metricEvents[0].teamName).toBe('Sandbox');
  });

  it('keeps the removed payloads in a quarantine record so nothing is unrecoverable', async () => {
    const h = await setup('sqlite');
    await importPrimary(h, [mk('alice', FOREIGN)]);
    const removed = (await primary(h)).statuses[0].statusJson;
    await prepare(h);
    const [name] = await quarantineFiles(h);
    const record = JSON.parse(await readFile(join(h.paths.getTeamDir(TEAM), name), 'utf8'));
    expect(record).toMatchObject({ schemaVersion: 1, teamName: TEAM, incarnation: CURRENT });
    expect(record.entries).toEqual([
      expect.objectContaining({
        source: 'primary',
        memberName: 'alice',
        foreignIncarnation: FOREIGN,
        statusJson: removed,
      }),
    ]);
    expect(recordsToSnapshot(TEAM, await primary(h)).statuses).toEqual([]);
  });
});
