import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { archiveFileWithGenerations } from '@features/internal-storage/main';
import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import * as atomicWrite from '@main/utils/atomicWrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

function status(sequence?: number): MemberWorkSyncStatus {
  return {
    teamName: 'sandbox',
    memberName: 'Alice Smith',
    state: 'needs_sync',
    evaluatedAt: '2026-09-10T00:00:00.000Z',
    diagnostics: [],
    agenda: {
      teamName: 'sandbox',
      memberName: 'Alice Smith',
      generatedAt: '2026-09-10T00:00:00.000Z',
      fingerprint: 'agenda',
      items: [],
      diagnostics: [],
    },
    ...(sequence === undefined
      ? {}
      : {
          statusRevision: {
            incarnation: 'inc',
            lineageId: 'lineage',
            sequence,
            nonce: `nonce-${sequence}`,
          },
        }),
  };
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

describe('JSON import source revision selection before snapshot overlay', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  let store: JsonMemberWorkSyncStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mws-import-source-revision-'));
    paths = new MemberWorkSyncStorePaths(root);
    store = new JsonMemberWorkSyncStore(paths);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const canonical = () => paths.getMemberStatusPath('sandbox', 'Alice Smith');
  const legacy = () => paths.getLegacyStatusPath('sandbox');

  it.each([
    [2, 3],
    [3, 2],
  ])(
    'chooses revision over active canonical-v2 / legacy-v1 precedence: %s, %s',
    async (canonicalSeq, legacySeq) => {
      await save(canonical(), { schemaVersion: 2, status: status(canonicalSeq) });
      await save(legacy(), { schemaVersion: 1, members: { 'alice smith': status(legacySeq) } });
      const before = await readFile(canonical(), 'utf8');
      expect((await store.readSnapshotForImport('sandbox'))?.statuses).toEqual([status(3)]);
      expect(await readFile(canonical(), 'utf8')).toBe(before);
    }
  );

  it('keeps the existing canonical precedence when both candidates are legacy', async () => {
    const existing = { ...status(), diagnostics: ['canonical'] };
    await save(canonical(), { schemaVersion: 2, status: existing });
    await save(legacy(), { schemaVersion: 1, members: { 'alice smith': status() } });
    expect((await store.readSnapshotForImport('sandbox'))?.statuses).toEqual([existing]);
  });

  it.each(['canonical', 'legacy'])(
    'preserves the versioned %s candidate over an unversioned source',
    async (versioned) => {
      await save(canonical(), {
        schemaVersion: 2,
        status: status(versioned === 'canonical' ? 3 : undefined),
      });
      await save(legacy(), {
        schemaVersion: 1,
        members: { 'alice smith': status(versioned === 'legacy' ? 3 : undefined) },
      });
      expect((await store.readSnapshotForImport('sandbox'))?.statuses).toEqual([status(3)]);
    }
  );

  it.each([
    [3, 2],
    [2, 3],
  ])(
    'folds every member archive generation independently of archive order: %s, %s',
    async (first, second) => {
      await save(canonical(), { schemaVersion: 2, status: status(first) });
      await archiveFileWithGenerations(canonical());
      await save(canonical(), { schemaVersion: 2, status: status(second) });
      await archiveFileWithGenerations(canonical());
      expect((await store.readArchivedSnapshotForImport('sandbox'))?.statuses).toEqual([status(3)]);
    }
  );

  it('compares legacy archives with member archives before selecting a winner', async () => {
    await save(legacy(), { schemaVersion: 1, members: { 'alice smith': status(4) } });
    await archiveFileWithGenerations(legacy());
    await save(canonical(), { schemaVersion: 2, status: status(3) });
    await archiveFileWithGenerations(canonical());
    expect((await store.readArchivedSnapshotForImport('sandbox'))?.statuses).toEqual([status(4)]);
  });

  it.each(['active', 'archived'])(
    'rejects equal-revision divergent payload without discarding %s evidence',
    async (kind) => {
      await save(canonical(), { schemaVersion: 2, status: status(3) });
      await save(legacy(), {
        schemaVersion: 1,
        members: { 'alice smith': { ...status(3), diagnostics: ['divergent'] } },
      });
      if (kind === 'archived') {
        await archiveFileWithGenerations(canonical());
        await archiveFileWithGenerations(legacy());
        await expect(store.readArchivedSnapshotForImport('sandbox')).rejects.toMatchObject({
          reason: 'revision_divergence',
        });
      } else {
        const before = await readFile(legacy(), 'utf8');
        await expect(store.readSnapshotForImport('sandbox')).rejects.toMatchObject({
          reason: 'revision_divergence',
        });
        expect(await readFile(legacy(), 'utf8')).toBe(before);
      }
    }
  );

  it.each(['active', 'archived'])(
    'accepts same-team spelling differences with equal revision in %s sources',
    async (kind) => {
      const original = status(3);
      const alias = {
        ...original,
        teamName: 'Sandbox',
        agenda: { ...original.agenda, teamName: 'Sandbox' },
      };
      await save(canonical(), { schemaVersion: 2, status: original });
      await save(legacy(), { schemaVersion: 1, members: { 'alice smith': alias } });
      if (kind === 'archived') {
        await archiveFileWithGenerations(canonical());
        await archiveFileWithGenerations(legacy());
        expect((await store.readArchivedSnapshotForImport('sandbox'))?.statuses).toEqual([alias]);
      } else {
        const before = await readFile(canonical(), 'utf8');
        expect((await store.readSnapshotForImport('sandbox'))?.statuses).toEqual([original]);
        expect(await readFile(canonical(), 'utf8')).toBe(before);
      }
    }
  );

  it('does not normalize foreign nested ownership into an equal revision', async () => {
    const original = status(3);
    await save(canonical(), { schemaVersion: 2, status: original });
    await save(legacy(), {
      schemaVersion: 1,
      members: {
        'alice smith': { ...original, agenda: { ...original.agenda, teamName: 'foreign' } },
      },
    });
    await expect(store.readSnapshotForImport('sandbox')).rejects.toMatchObject({
      reason: 'corrupt',
    });
  });

  it('rejects an invalid revision even if it is the only source', async () => {
    await save(canonical(), { schemaVersion: 2, status: { ...status(), statusRevision: null } });
    await expect(store.readSnapshotForImport('sandbox')).rejects.toMatchObject({
      reason: 'invalid_revision',
    });
  });
  it('restores canonical JSON through strict publication without generating a new revision or metric event', async () => {
    const snapshot = {
      statuses: [status(3)],
      reportIntents: [],
      outboxItems: [],
      metricEvents: [],
      filesToArchive: [],
    };
    const before = JSON.stringify(snapshot);
    await store.restoreReplicaSnapshot('sandbox', snapshot);
    await store.restoreReplicaSnapshot('sandbox', snapshot);
    const result = await store.readCanonicalStatusSnapshot({
      teamName: 'sandbox',
      memberName: 'Alice Smith',
    });
    expect(result).toMatchObject({ state: 'present', payload: status(3) });
    expect(JSON.stringify(snapshot)).toBe(before);
    const metrics = JSON.parse(await readFile(paths.getMetricsIndexPath('sandbox'), 'utf8'));
    expect(metrics.recentEvents).toEqual([]);
    expect(metrics.members[paths.getMemberKey('Alice Smith')].state).toBe('needs_sync');
  });

  it('keeps newer canonical authority when restoring an older replica', async () => {
    await save(canonical(), { schemaVersion: 2, status: status(4) });
    await store.restoreReplicaSnapshot('sandbox', {
      statuses: [status(3)],
      reportIntents: [],
      outboxItems: [],
      metricEvents: [],
      filesToArchive: [],
    });
    expect(JSON.parse(await readFile(canonical(), 'utf8')).status).toEqual(status(4));
  });

  it('fails preparation after uncertain publication and proves strict persistence on retry without incrementing revision', async () => {
    const original = atomicWrite.atomicWriteAsync;
    let fail = true;
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementation(async (...args) => {
      await original(...args);
      if (args[0] === canonical() && fail) {
        fail = false;
        throw new Error('post-publication sync error');
      }
    });
    const snapshot = {
      statuses: [status(3)],
      reportIntents: [],
      outboxItems: [],
      metricEvents: [],
      filesToArchive: [],
    };
    await expect(store.restoreReplicaSnapshot('sandbox', snapshot)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(JSON.parse(await readFile(canonical(), 'utf8')).status).toEqual(status(3));
    await store.restoreReplicaSnapshot('sandbox', snapshot);
    expect(JSON.parse(await readFile(canonical(), 'utf8')).status).toEqual(status(3));
  });
  it.each(['report-owner', 'outbox-envelope', 'status-agenda'])(
    'preflights all incoming state before any publication: %s',
    async (fault) => {
      const snapshot = {
        statuses: [status(3)],
        reportIntents: [],
        outboxItems: [],
        metricEvents: [],
        filesToArchive: [],
      };
      const bad: unknown =
        fault === 'report-owner'
          ? {
              ...snapshot,
              reportIntents: [
                {
                  id: 'report',
                  teamName: 'sandbox',
                  memberName: 'Alice Smith',
                  status: 'pending',
                  reason: 'retry',
                  recordedAt: '2026-09-10T00:00:00Z',
                  request: { teamName: 'sandbox', memberName: 'other' },
                },
              ],
            }
          : fault === 'outbox-envelope'
            ? { ...snapshot, outboxItems: [{ id: 'broken' }] }
            : { ...snapshot, statuses: [status(3), { ...status(4), memberName: 'bob' }] };
      await expect(store.restoreReplicaSnapshot('sandbox', bad as never)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }
  );
});
