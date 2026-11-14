// @vitest-environment node
import { createHash } from 'node:crypto';
import { constants, promises as fsPromises } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, lstat, mkdtemp, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTeamModelProbeIntents } from '../../../src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rootId = 'team-preflight-TEST-root';
describe('immutable Main model intent routing', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'TEST-team-model-intents-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const folder = (directory: string) => join(directory, digest(rootId));
  const alias = (directory: string, id: string) =>
    join(folder(directory), `preparation-${digest(id)}.json`);

  it('preserves every preparation ID across newer checks and cold store instances', async () => {
    const first = new FileTeamModelProbeIntents(directory);
    expect(await first.read(rootId, 'TEST-A')).toEqual({ commandId: rootId, retained: false });
    expect(await first.admit(rootId, 'TEST-A', rootId, false)).toBe(rootId);
    const second = await first.admit(rootId, 'TEST-B', rootId, true);
    expect(second).not.toBe(rootId);
    expect(await first.read(rootId, 'TEST-C')).toEqual({ commandId: second, retained: false });
    expect(await first.admit(rootId, 'TEST-C', second, false)).toBe(second);
    const third = await first.admit(rootId, 'TEST-D', second, true);
    const cold = new FileTeamModelProbeIntents(directory);
    for (const [preparation, commandId] of [
      ['TEST-A', rootId],
      ['TEST-B', second],
      ['TEST-C', second],
      ['TEST-D', third],
    ])
      expect(await cold.read(rootId, preparation!)).toEqual({ commandId, retained: true });
    expect(await cold.admit(rootId, 'TEST-A', third, true)).toBe(rootId);
    expect(await readdir(folder(directory))).toHaveLength(6);
    const record = JSON.parse(await readFile(alias(directory, 'TEST-B'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(record).sort()).toEqual([
      'commandId',
      'digest',
      'key',
      'kind',
      'rootId',
      'schemaVersion',
    ]);
  });

  it('concurrent Main instances publish one successor and retain one ID for each requesting preparation', async () => {
    const stores = Array.from({ length: 12 }, () => new FileTeamModelProbeIntents(directory));
    const ids = await Promise.all(
      stores.map((store, index) => store.admit(rootId, `TEST-${index % 2}`, rootId, true))
    );
    expect(new Set(ids).size).toBe(1);
    expect(await readdir(folder(directory))).toHaveLength(3);
    expect(await stores[0]!.read(rootId, 'TEST-0')).toEqual({ commandId: ids[0], retained: true });
    expect(await stores[1]!.read(rootId, 'TEST-1')).toEqual({ commandId: ids[0], retained: true });
  });

  it('retains original Windows preparation IDs without treating synthetic POSIX mode bits as authority', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-Windows', rootId, false);
    const path = alias(directory, 'TEST-Windows');
    await chmod(path, 0o666);
    expect((await stat(path)).mode & 0o077).not.toBe(0);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      const cold = new FileTeamModelProbeIntents(directory);
      expect(await cold.read(rootId, 'TEST-Windows')).toEqual({ commandId: rootId, retained: true });
      expect(await cold.admit(rootId, 'TEST-Windows', 'TEST-newer-check', true)).toBe(rootId);
      expect(await readdir(folder(directory))).toHaveLength(1);
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...value, commandId: 'TEST-corrupt-replacement' }));
      await expect(cold.read(rootId, 'TEST-Windows')).rejects.toThrow('unavailable');
      await expect(cold.admit(rootId, 'TEST-Windows', rootId, true)).rejects.toThrow('unavailable');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('continues to hold non-private POSIX preparation records without allocating a successor', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-POSIX', rootId, false);
    const path = alias(directory, 'TEST-POSIX');
    await chmod(path, 0o644);
    expect((await stat(path)).mode & 0o077).not.toBe(0);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      await expect(store.read(rootId, 'TEST-POSIX')).rejects.toThrow('unavailable');
      await expect(store.admit(rootId, 'TEST-POSIX', rootId, true)).rejects.toThrow('unavailable');
      expect(await readdir(folder(directory))).toHaveLength(1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('refuses a valid symlink intent under Windows open semantics without modifying the original target', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-symlink', rootId, false);
    const path = alias(directory, 'TEST-symlink'), target = join(directory, 'TEST-original-intent.json');
    const bytes = await readFile(path);
    await writeFile(target, bytes, { mode: 0o600 });
    await unlink(path); await symlink(target, path, 'file');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const nativeOpen = fsPromises.open;
    const opening = vi.spyOn(fsPromises, 'open').mockImplementation((...args: Parameters<typeof nativeOpen>) => {
      if (args[0] === path && typeof args[1] === 'number') args[1] &= ~(constants.O_NOFOLLOW ?? 0);
      return nativeOpen(...args);
    });
    syncBuiltinESMExports();
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      await expect(store.read(rootId, 'TEST-symlink')).rejects.toThrow('unavailable');
      await expect(store.admit(rootId, 'TEST-symlink', rootId, true)).rejects.toThrow('unavailable');
      expect(await readFile(target)).toEqual(bytes);
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
    } finally {
      opening.mockRestore(); syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', platform);
    }
  });

  for (const stage of ['before-open', 'after-open', 'disappeared-before-open'] as const) {
    it('holds original model-intent replacement at ' + stage + ' without returning absence', async () => {
      const store = new FileTeamModelProbeIntents(directory);
      await store.admit(rootId, 'TEST-race', rootId, false);
      const path = alias(directory, 'TEST-race'), retained = join(directory, 'TEST-retained-intent.json');
      const bytes = await readFile(path);
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const nativeOpen = fsPromises.open;
      let armed = true, openedFile: Awaited<ReturnType<typeof nativeOpen>> | undefined;
      const replace = async () => {
        if (stage === 'disappeared-before-open') await unlink(path);
        else { await rename(path, retained); await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); }
      };
      const opening = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: Parameters<typeof nativeOpen>) => {
        if (args[0] !== path || !armed) return nativeOpen(...args);
        armed = false;
        if (typeof args[1] === 'number') args[1] &= ~(constants.O_NOFOLLOW ?? 0);
        if (stage !== 'after-open') await replace();
        const file = await nativeOpen(...args); openedFile = file;
        if (stage === 'after-open') await replace();
        return file;
      });
      syncBuiltinESMExports();
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        await expect(store.read(rootId, 'TEST-race')).rejects.toThrow('unavailable');
        expect(armed).toBe(false);
        if (openedFile !== undefined) expect(openedFile.fd).toBe(-1);
      } finally {
        opening.mockRestore(); syncBuiltinESMExports();
        Object.defineProperty(process, 'platform', platform);
      }
    });
  }

  it('refuses a corrupt retained ID and never treats a corrupt association as absence', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-A', rootId, false);
    const path = alias(directory, 'TEST-A');
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...value, commandId: 'TEST-corrupt-replacement' }), {
      mode: 0o600,
    });
    await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
    await expect(store.admit(rootId, 'TEST-A', rootId, true)).rejects.toThrow('unavailable');
  });

  it('refuses symlinked records and invalid application IDs', async () => {
    const store = new FileTeamModelProbeIntents(directory);
    await store.admit(rootId, 'TEST-A', rootId, false);
    const path = alias(directory, 'TEST-A');
    const target = join(directory, 'TEST-symlink-target.json');
    await writeFile(target, await readFile(path), { mode: 0o600 });
    await unlink(path);
    await symlink(target, path);
    await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
    await expect(store.read(rootId, '../outside')).rejects.toThrow('Invalid model intent');
  });
});
