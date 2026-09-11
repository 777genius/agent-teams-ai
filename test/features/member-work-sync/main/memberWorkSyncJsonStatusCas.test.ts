import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import * as persistence from '@features/member-work-sync/main/infrastructure/memberWorkSyncJsonStatusPersistence';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import * as atomicWrite from '@main/utils/atomicWrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

describe('JSON canonical status CAS', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  let store: JsonMemberWorkSyncStore;
  const identity = { teamName: 'sandbox', memberName: 'alice' };
  const now = '2026-09-10T00:00:00.000Z';

  function status(nonce: string): MemberWorkSyncStatus {
    return {
      ...identity,
      state: 'needs_sync',
      evaluatedAt: now,
      diagnostics: [nonce],
      agenda: { ...identity, fingerprint: 'agenda', generatedAt: now, items: [], diagnostics: [] },
      shadow: { reconciledBy: 'queue', wouldNudge: false, fingerprintChanged: false },
      statusRevision: { incarnation: 'team-incarnation', lineageId: 'lineage', sequence: 1, nonce },
    };
  }

  function commit(expectedRaw: string | null, nonce: string) {
    return store.compareAndWriteCanonicalStatus({
      expectedRaw,
      mutationId: nonce,
      nextStatus: status(nonce),
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-json-cas-'));
    paths = new MemberWorkSyncStorePaths(root);
    store = new JsonMemberWorkSyncStore(paths);
    await paths.ensureMemberWorkSyncDir(identity.teamName, identity.memberName);
    await mkdir(paths.getMemberWorkSyncDir(identity.teamName, identity.memberName), {
      recursive: true,
    });
    await mkdir(dirname(paths.getMetricsIndexPath(identity.teamName)), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('serializes two store instances and refuses the stale initial insert', async () => {
    const other = new JsonMemberWorkSyncStore(paths);
    const results = await Promise.all([
      commit(null, 'first'),
      other.compareAndWriteCanonicalStatus({
        expectedRaw: null,
        mutationId: 'other',
        nextStatus: status('other'),
      }),
    ]);
    expect(results.filter((result) => result.committed === true)).toHaveLength(1);
    expect(results.filter((result) => result.committed === false)).toHaveLength(1);
    expect((await store.readTeamMetrics(identity.teamName)).recentEvents).toHaveLength(1);
  });

  it.each(['{broken', 'null', '{"schemaVersion":2,"status":[]}'])(
    'preserves corrupt bytes: %s',
    async (raw) => {
      const path = paths.getMemberStatusPath(identity.teamName, identity.memberName);
      await writeFile(path, raw);
      expect(await store.readCanonicalStatusSnapshot(identity)).toEqual({ state: 'corrupt', raw });
      expect(await commit(null, 'new')).toEqual({ committed: false, reason: 'corrupt' });
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  );

  it('distinguishes unreadable storage from an absent canonical file', async () => {
    expect(await store.readCanonicalStatusSnapshot(identity)).toEqual({
      state: 'absent',
      raw: null,
    });
    await mkdir(paths.getMemberStatusPath(identity.teamName, identity.memberName));
    expect(await store.readCanonicalStatusSnapshot(identity)).toEqual({ state: 'unavailable' });
    expect(await commit(null, 'new')).toEqual({ committed: false, reason: 'unavailable' });
  });

  it('compares exact envelope bytes across service recreation', async () => {
    const raw = JSON.stringify({ schemaVersion: 2, status: status('legacy') });
    await writeFile(paths.getMemberStatusPath(identity.teamName, identity.memberName), raw);
    store = new JsonMemberWorkSyncStore(paths);
    expect(await commit(`${raw}\n`, 'bad')).toMatchObject({ committed: false, reason: 'conflict' });
    expect(await commit(raw, 'good')).toMatchObject({ committed: true });
    expect(await commit(raw, 'stale')).toMatchObject({ committed: false, reason: 'conflict' });
  });

  it('retains live ownership when fsync exceeds the old 30-second lock lease', async () => {
    const path = paths.getMemberStatusPath(identity.teamName, identity.memberName);
    const open = fs.promises.open.bind(fs.promises);
    let entered!: () => void;
    let release!: () => void;
    const enteredSync = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (
        !blocked &&
        dirname(String(args[0])) === dirname(path) &&
        String(args[0]).includes('/.tmp.')
      ) {
        blocked = true;
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          entered();
          await barrier;
          return sync();
        });
      }
      return handle;
    });
    const first = commit(null, 'slow');
    await enteredSync;
    const later = Date.now() + 31_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const other = new JsonMemberWorkSyncStore(paths);
    const second = other.compareAndWriteCanonicalStatus({
      expectedRaw: null,
      mutationId: 'competitor',
      nextStatus: status('competitor'),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await store.readCanonicalStatusSnapshot(identity)).toEqual({
        state: 'absent',
        raw: null,
      });
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(await first).toMatchObject({ committed: true });
    expect(await second).toMatchObject({ committed: false, reason: 'conflict' });
  });

  it('surfaces a failed queued operation once and continues the next write', async () => {
    const failure = vi
      .spyOn(persistence, 'compareAndWriteMemberWorkSyncJsonStatus')
      .mockRejectedValueOnce(new Error('test queue failure'));
    await expect(commit(null, 'failed')).rejects.toThrow('test queue failure');
    failure.mockRestore();
    expect(await commit(null, 'next')).toMatchObject({ committed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('returns committed with degraded metrics after authority publication', async () => {
    const write = atomicWrite.atomicWriteAsync;
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementation(async (path, data, options) => {
      if (path === paths.getMetricsIndexPath(identity.teamName))
        throw new Error('metrics unavailable');
      return write(path, data, options);
    });
    expect(await commit(null, 'accepted')).toMatchObject({
      committed: true,
      projectionDegraded: true,
    });
    expect(await commit(null, 'duplicate')).toMatchObject({ committed: false, reason: 'conflict' });
    expect((await store.readCanonicalStatusSnapshot(identity)).state).toBe('present');
  });

  it.each(['file_sync', 'directory_sync'])(
    'classifies real atomic-write fault at %s',
    async (cut) => {
      const path = paths.getMemberStatusPath(identity.teamName, identity.memberName);
      const open = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        const target = String(args[0]);
        if (
          (cut === 'file_sync' && dirname(target) === dirname(path) && target.includes('/.tmp.')) ||
          (cut === 'directory_sync' && target === dirname(path))
        ) {
          vi.spyOn(handle, 'sync').mockRejectedValue(
            Object.assign(new Error('test EIO'), { code: 'EIO' })
          );
        }
        return handle;
      });
      const result = await commit(null, 'faulted');
      expect(result).toEqual(
        cut === 'file_sync'
          ? { committed: false, reason: 'write_failed' }
          : { committed: 'unknown', reason: 'commit_unknown', mutationId: 'faulted' }
      );
      const observed = await store.readCanonicalStatusSnapshot(identity);
      expect(observed.state).toBe(cut === 'file_sync' ? 'absent' : 'present');
      if (cut === 'directory_sync') {
        expect(await commit(null, 'unsafe-retry')).toMatchObject({
          committed: false,
          reason: 'conflict',
        });
      }
    }
  );
});
