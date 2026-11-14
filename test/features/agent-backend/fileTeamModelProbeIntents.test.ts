// @vitest-environment node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTeamModelProbeIntents } from '../../../src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents';

const windowsFiles = vi.hoisted(() => ({
  enabled: false,
  path: '',
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  flags: undefined as string | number | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    constants: {
      ...actual.constants,
      get O_NOFOLLOW() {
        return windowsFiles.enabled ? 0 : actual.constants.O_NOFOLLOW;
      },
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = (path, flags, mode) => {
    if (windowsFiles.enabled && path === windowsFiles.path) {
      windowsFiles.flags = flags;
      const beforeOpen = windowsFiles.beforeOpen;
      windowsFiles.beforeOpen = undefined;
      if (beforeOpen) return beforeOpen().then(() => actual.open(path, flags, mode));
    }
    return actual.open(path, flags, mode);
  };
  return { ...actual, open };
});

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
    const original = await readFile(path);
    const originalPlatform = process.platform;
    try {
      await chmod(path, 0o666);
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      windowsFiles.enabled = true;
      windowsFiles.path = path;
      expect(constants.O_NOFOLLOW).toBe(0);
      expect(await store.read(rootId, 'TEST-A')).toEqual({ commandId: rootId, retained: true });
      expect(windowsFiles.flags).toBe(0);
      await chmod(path, 0o444);
      expect(await store.read(rootId, 'TEST-A')).toEqual({ commandId: rootId, retained: true });
      await chmod(path, 0o600);
      const record = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...record, commandId: 'TEST-Windows-corrupt' }));
      await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
      await writeFile(path, original);
      const replacement = join(directory, 'TEST-replacement.json');
      await writeFile(replacement, original, { flag: 'wx', mode: 0o600 });
      windowsFiles.beforeOpen = () => rename(replacement, path);
      await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
      expect(windowsFiles.beforeOpen).toBeUndefined();
      expect(windowsFiles.flags).toBe(0);
      windowsFiles.beforeOpen = () => unlink(path);
      await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
      expect(windowsFiles.beforeOpen).toBeUndefined();
      expect(await store.read(rootId, 'TEST-A')).toEqual({ commandId: rootId, retained: false });
      await writeFile(path, original, { flag: 'wx', mode: 0o600 });
      const target = join(directory, 'TEST-symlink-target.json');
      await writeFile(target, await readFile(path), { mode: 0o600 });
      await unlink(path);
      await symlink(target, path);
      await expect(store.read(rootId, 'TEST-A')).rejects.toThrow('unavailable');
      await expect(store.read(rootId, '../outside')).rejects.toThrow('Invalid model intent');
    } finally {
      windowsFiles.enabled = false;
      windowsFiles.path = '';
      windowsFiles.beforeOpen = undefined;
      windowsFiles.flags = undefined;
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
