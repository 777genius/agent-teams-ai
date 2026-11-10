import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InternalStorageFallbackUnsafeError,
  InternalStorageJsonReplica,
} from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import * as atomicWrite from '@main/utils/atomicWrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Snapshot = { teamName: string; value: number };
const TEAM = 'sandbox';
const INC = 'incarnation-1';
const snapshot: Snapshot = { teamName: TEAM, value: 4 };
const isSnapshot = (value: unknown, teamName: string): value is Snapshot => {
  const row = value as Snapshot | null;
  return !!row && row.teamName === teamName && Number.isInteger(row.value);
};

describe('opt-in replica recovery candidate', () => {
  let root: string;
  let path: string;
  let replica: InternalStorageJsonReplica<Snapshot>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mws-replica-recovery-'));
    path = join(root, 'replica.json');
    replica = new InternalStorageJsonReplica(() => path, isSnapshot);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('preserves the only snapshot across dirty publication and a new reader, without granting fallback', async () => {
    await replica.writeClean(TEAM, snapshot);
    await replica.markDirtyWithRecoveryCandidate(TEAM, INC, snapshot);
    const bytes = await readFile(path, 'utf8');
    const restarted = new InternalStorageJsonReplica(() => path, isSnapshot);
    await expect(restarted.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'dirty',
      candidate: snapshot,
    });
    await expect(restarted.readClean(TEAM, false)).rejects.toThrow(
      InternalStorageFallbackUnsafeError
    );
    await expect(restarted.readForPrimary(TEAM)).resolves.toBeNull();
    await expect(restarted.readForPrimary(TEAM, false)).rejects.toThrow(
      InternalStorageFallbackUnsafeError
    );
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('retains the previous clean bytes when dirty publication fails before rename', async () => {
    await replica.writeClean(TEAM, snapshot, INC);
    const before = await readFile(path, 'utf8');
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockRejectedValueOnce(new Error('pre-publish EIO'));
    await expect(replica.markDirtyWithRecoveryCandidate(TEAM, INC, snapshot)).rejects.toThrow(
      'EIO'
    );
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('does not turn post-publish sync uncertainty into success or delete the durable candidate', async () => {
    const write = atomicWrite.atomicWriteAsync;
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementationOnce(async (...args) => {
      await write(...args);
      throw new Error('directory sync uncertain');
    });
    await expect(replica.markDirtyWithRecoveryCandidate(TEAM, INC, snapshot)).rejects.toThrow(
      'uncertain'
    );
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'dirty',
      candidate: snapshot,
    });
    await expect(replica.readClean(TEAM, false)).rejects.toThrow(
      InternalStorageFallbackUnsafeError
    );
  });

  it('supports explicit clean publication with binding, while keeping legacy clean compatibility', async () => {
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'absent',
    });
    await replica.writeClean(TEAM, snapshot);
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'clean',
      snapshot,
    });
    await replica.markDirtyWithRecoveryCandidate(TEAM, INC, snapshot);
    const next = { ...snapshot, value: 5 };
    await replica.writeClean(TEAM, next, INC);
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'clean',
      snapshot: next,
    });
    await expect(replica.readClean(TEAM, true)).resolves.toEqual(next);
  });

  it.each(['clean', 'dirty'] as const)(
    'rejects %s data bound to another incarnation without modifying it',
    async (state) => {
      if (state === 'clean') await replica.writeClean(TEAM, snapshot, INC);
      else await replica.markDirtyWithRecoveryCandidate(TEAM, INC, snapshot);
      const before = await readFile(path, 'utf8');
      await expect(replica.readForAuthorityPreparation(TEAM, 'incarnation-2')).rejects.toThrow(
        'incarnation mismatch'
      );
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  );

  it('keeps legacy dirty evidence unavailable as a candidate', async () => {
    await replica.markDirty(TEAM);
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'dirty',
      candidate: null,
    });
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, state: 'dirty', updatedAt: '', snapshot })
    );
    const before = await readFile(path, 'utf8');
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).resolves.toEqual({
      state: 'dirty',
      candidate: null,
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([
    '{bad',
    JSON.stringify({
      schemaVersion: 1,
      state: 'dirty',
      updatedAt: '',
      incarnation: INC,
      snapshot: null,
    }),
    JSON.stringify({
      schemaVersion: 1,
      state: 'dirty',
      updatedAt: '',
      incarnation: null,
      snapshot,
    }),
    JSON.stringify({
      schemaVersion: 1,
      state: 'clean',
      updatedAt: '',
      snapshot: { ...snapshot, teamName: 'other' },
    }),
  ])('preserves corrupt evidence', async (bytes) => {
    await writeFile(path, bytes);
    await expect(replica.readForAuthorityPreparation(TEAM, INC)).rejects.toThrow(
      InternalStorageFallbackUnsafeError
    );
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('rejects invalid candidate or incarnation before replacing existing evidence', async () => {
    await replica.writeClean(TEAM, snapshot, INC);
    const before = await readFile(path, 'utf8');
    await expect(replica.markDirtyWithRecoveryCandidate(TEAM, '', snapshot)).rejects.toThrow(
      'invalid incarnation'
    );
    await expect(replica.writeClean(TEAM, snapshot, ' padded ')).rejects.toThrow(
      'invalid incarnation'
    );
    await expect(
      replica.markDirtyWithRecoveryCandidate(TEAM, INC, { ...snapshot, teamName: 'other' })
    ).rejects.toThrow('candidate is invalid');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
