// @vitest-environment node
import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FileProviderOAuthIntentStore,
  type ProviderOAuthIntent,
} from '../../../src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore';

import type { FileHandle } from 'node:fs/promises';

const original: ProviderOAuthIntent = {
  schemaVersion: 1,
  runtimeId: 'opencode',
  operationId: 'oauth-TEST-original',
  targetId: 'a'.repeat(64),
  providerId: 'TEST-provider',
  methodIndex: 0,
  authOptionId: 'oauth',
  displayName: 'TEST Provider',
  fingerprint: 'b'.repeat(64),
  fingerprintKdf: { version: 1, salt: 'c'.repeat(32) },
};
const unavailable = 'OAuth intent unavailable';

describe('immutable original OAuth intent files', () => {
  let directory: string;
  let opened: { file: FileHandle; close(): Promise<void> }[];
  let restoreFileSpies: (() => void)[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'TEST-provider-oauth-intents-'));
    opened = [];
    restoreFileSpies = [];
  });
  afterEach(async () => {
    for (const restore of restoreFileSpies.reverse()) restore();
    syncBuiltinESMExports();
    try {
      for (const entry of opened) if (entry.file.fd !== -1) await entry.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const location = () =>
    join(directory, createHash('sha256').update(original.operationId).digest('hex') + '.json');

  async function fixture() {
    const store = new FileProviderOAuthIntentStore(directory);
    expect(await store.create(original)).toBe(true);
    return { store, path: location(), bytes: await readFile(location()) };
  }

  function ownFileSpy<T extends { mockRestore(): void }>(spy: T): T {
    restoreFileSpies.push(() => spy.mockRestore());
    return spy;
  }

  /** Intercept only this fixture's one physical read; retain the real FileHandle. */
  function observeOpen(
    path: string,
    hooks: {
      before?(): Promise<void>;
      after?(file: FileHandle): void | Promise<void>;
    }
  ) {
    const nativeOpen = fsPromises.open;
    let intercepted = false;
    ownFileSpy(vi.spyOn(fsPromises, 'open')).mockImplementation(
      async (...args: Parameters<typeof nativeOpen>) => {
        if (args[0] !== path || intercepted) return nativeOpen(...args);
        intercepted = true;
        await hooks.before?.();
        const file = await nativeOpen(...args);
        const close = file.close.bind(file);
        opened.push({ file, close });
        try {
          await hooks.after?.(file);
          return file;
        } catch (error) {
          await close();
          throw error;
        }
      }
    );
    syncBuiltinESMExports();
    return () => intercepted;
  }

  /** The actual read completes before the one narrowly injected observation/fault. */
  function afterFirstRead(file: FileHandle, effect: (result: unknown) => Promise<unknown>): void {
    const nativeRead = file.read.bind(file);
    let first = true;
    Object.defineProperty(file, 'read', {
      configurable: true,
      value: async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(nativeRead, file, args);
        if (!first) return result;
        first = false;
        return effect(result);
      },
    });
  }

  it('creates and cold-reads the exact original on the actual platform', async () => {
    await chmod(directory, 0o755);
    const f = await fixture();
    const before = await lstat(f.path, { bigint: true });
    if (process.platform === 'win32') expect(before.mode & 0o077n).not.toBe(0n);
    else expect(before.mode & 0o077n).toBe(0n);
    expect(f.bytes.toString('utf8')).toBe(JSON.stringify(original) + '\n');
    expect(await f.store.read(original.operationId)).toEqual(original);
    const cold = new FileProviderOAuthIntentStore(directory);
    expect(await cold.read(original.operationId)).toEqual(original);
    expect(await cold.create({ ...original, fingerprint: 'd'.repeat(64) })).toBe(false);
    expect(await cold.read(original.operationId)).toEqual(original);
    expect(await readFile(f.path)).toEqual(f.bytes);
  });

  it('returns null only for a genuinely absent original at the start of this read', async () => {
    const store = new FileProviderOAuthIntentStore(directory);
    expect(await store.read(original.operationId)).toBeNull();
    await store.create(original);
    await unlink(location());
    // An independent later lookup has not observed this now-absent physical file.
    expect(await store.read(original.operationId)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('keeps the POSIX private-file rule', async () => {
    const f = await fixture();
    await chmod(f.path, 0o644);
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect(await readFile(f.path)).toEqual(f.bytes);
    await chmod(f.path, 0o600);
    expect(await f.store.read(original.operationId)).toEqual(original);
  });

  it('rejects a physical directory in place of the original record', async () => {
    const f = await fixture();
    await unlink(f.path);
    await mkdir(f.path);
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect((await lstat(f.path)).isDirectory()).toBe(true);
  });

  it('rejects a non-file observation before attempting any open on every platform', async () => {
    const f = await fixture();
    const nativeLstat = fsPromises.lstat;
    ownFileSpy(vi.spyOn(fsPromises, 'lstat')).mockImplementation(
      async (...args: Parameters<typeof nativeLstat>) => {
        const result = await nativeLstat(...args);
        if (args[0] === f.path) Object.defineProperty(result, 'isFile', { value: () => false });
        return result;
      }
    );
    const opening = ownFileSpy(vi.spyOn(fsPromises, 'open'));
    syncBuiltinESMExports();
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect(opening).not.toHaveBeenCalled();
  });

  it('rejects a physical final-file symlink without changing its original target', async (context) => {
    const f = await fixture();
    const target = join(directory, 'TEST-retained-original.json');
    await rename(f.path, target);
    try {
      await symlink(target, f.path, 'file');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target)).toEqual(f.bytes);
  });

  it.each([
    ['malformed UTF-8', Buffer.from([0xc3, 0x28])],
    ['malformed JSON', Buffer.from('{')],
    ['non-record JSON', Buffer.from('null')],
    ['unknown schema', Buffer.from(JSON.stringify({ ...original, schemaVersion: 99 }))],
    ['unknown field', Buffer.from(JSON.stringify({ ...original, extra: true }))],
    [
      'wrong original operation',
      Buffer.from(JSON.stringify({ ...original, operationId: 'oauth-TEST-other' })),
    ],
    [
      'invalid original fingerprint',
      Buffer.from(JSON.stringify({ ...original, fingerprint: 'invalid' })),
    ],
    [
      'extra KDF field',
      Buffer.from(
        JSON.stringify({ ...original, fingerprintKdf: { ...original.fingerprintKdf, extra: true } })
      ),
    ],
  ])('holds %s without treating it as absence', async (_name, bytes) => {
    const f = await fixture();
    await writeFile(f.path, bytes);
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect(await readFile(f.path)).toEqual(bytes);
  });

  it('accepts exactly 16384 physical bytes and rejects the next byte', async () => {
    const f = await fixture();
    const text = JSON.stringify(original);
    const exact = text + ' '.repeat(16384 - Buffer.byteLength(text));
    await writeFile(f.path, exact);
    expect(await f.store.read(original.operationId)).toEqual(original);
    await writeFile(f.path, exact + ' ');
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect((await lstat(f.path)).size).toBe(16385);
  });

  for (const stage of [
    'disappear-before-open',
    'replace-before-open',
    'replace-after-open',
  ] as const) {
    it('holds an observed original at ' + stage, async () => {
      const f = await fixture();
      const retained = join(directory, 'TEST-retained-original.json');
      const change = async () => {
        if (stage === 'disappear-before-open') await unlink(f.path);
        else {
          await rename(f.path, retained);
          await writeFile(f.path, f.bytes, { flag: 'wx', mode: 0o600 });
        }
      };
      const intercepted = observeOpen(
        f.path,
        stage === 'replace-after-open' ? { after: change } : { before: change }
      );
      await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
      expect(intercepted()).toBe(true);
      expect(opened.every(({ file }) => file.fd === -1)).toBe(true);
      if (stage !== 'disappear-before-open') {
        expect(await readFile(retained)).toEqual(f.bytes);
        expect(await readFile(f.path)).toEqual(f.bytes);
      }
    });
  }

  for (const stage of [
    'disappear-after-read',
    'replace-after-read',
    'mutate-after-read',
  ] as const) {
    it('holds the original path and bytes at ' + stage, async () => {
      const f = await fixture();
      const before = await lstat(f.path, { bigint: true });
      const retained = join(directory, 'TEST-retained-original.json');
      let changed = false;
      observeOpen(f.path, {
        after(file) {
          afterFirstRead(file, async (result) => {
            if (stage === 'disappear-after-read') await unlink(f.path);
            else if (stage === 'replace-after-read') {
              await rename(f.path, retained);
              await writeFile(f.path, f.bytes, { flag: 'wx', mode: 0o600 });
            } else {
              const next = JSON.stringify({ ...original, displayName: 'TEST Replaced' }) + '\n';
              expect(Buffer.byteLength(next)).toBe(f.bytes.length);
              await writeFile(f.path, next);
              const changedTime = new Date(Number(before.mtimeMs) + 60_000);
              await utimes(f.path, changedTime, changedTime);
              const after = await lstat(f.path, { bigint: true });
              expect(after.size).toBe(before.size);
              expect(after.mtimeNs).not.toBe(before.mtimeNs);
            }
            changed = true;
            return result;
          });
        },
      });
      await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
      expect(changed).toBe(true);
      expect(opened).toHaveLength(1);
      expect(opened[0]!.file.fd).toBe(-1);
      if (stage === 'replace-after-read') expect(await readFile(retained)).toEqual(f.bytes);
    });
  }

  it('compares original inode identifiers as bigints above Number precision', async () => {
    const f = await fixture();
    const large = 9007199254740992n;
    expect(Number(large)).toBe(Number(large + 1n));
    const nativeLstat = fsPromises.lstat;
    ownFileSpy(vi.spyOn(fsPromises, 'lstat')).mockImplementation(
      async (...args: Parameters<typeof nativeLstat>) => {
        const result = await nativeLstat(...args);
        if (args[0] === f.path) Object.defineProperty(result, 'ino', { value: large });
        return result;
      }
    );
    observeOpen(f.path, {
      after(file) {
        const nativeStat = file.stat.bind(file);
        Object.defineProperty(file, 'stat', {
          configurable: true,
          value: async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(nativeStat, file, args);
            if (!result || typeof result !== 'object')
              throw new Error('TEST missing real file stat');
            Object.defineProperty(result, 'ino', { value: large + 1n });
            return result;
          },
        });
      },
    });
    syncBuiltinESMExports();
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect(opened[0]!.file.fd).toBe(-1);
    expect(await readFile(f.path)).toEqual(f.bytes);
  });

  it('rejects a valid JSON prefix when the descriptor read omits original padding bytes', async () => {
    const f = await fixture();
    const text = JSON.stringify(original) + '\n';
    await writeFile(f.path, text + ' '.repeat(256));
    let observedBytesRead: unknown;
    observeOpen(f.path, {
      after(file) {
        afterFirstRead(file, (result) => {
          if (!result || typeof result !== 'object' || !('bytesRead' in result))
            throw new Error('TEST missing actual read result');
          observedBytesRead = result.bytesRead;
          return Promise.resolve({ ...result, bytesRead: Buffer.byteLength(text) });
        });
      },
    });
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect(observedBytesRead).toBeGreaterThan(Buffer.byteLength(text));
    expect(opened[0]!.file.fd).toBe(-1);
  });

  it('keeps a late close ENOENT unavailable after observing and reading the original', async () => {
    const f = await fixture();
    observeOpen(f.path, {
      after(file) {
        const close = file.close.bind(file);
        Object.defineProperty(file, 'close', {
          configurable: true,
          value: async () => {
            await close();
            throw Object.assign(new Error('TEST late close failure'), { code: 'ENOENT' });
          },
        });
      },
    });
    await expect(f.store.read(original.operationId)).rejects.toThrow(unavailable);
    expect(opened[0]!.file.fd).toBe(-1);
    expect(await readFile(f.path)).toEqual(f.bytes);
  });

  it('allows original atomic-publication hardlink cleanup during the physical read', async () => {
    const f = await fixture();
    const temporary = join(directory, 'TEST-atomic-publication-link');
    await link(f.path, temporary);
    const before = await lstat(f.path, { bigint: true });
    expect(before.nlink).toBe(2n);
    observeOpen(f.path, {
      after(file) {
        afterFirstRead(file, async (result) => {
          await unlink(temporary);
          return result;
        });
      },
    });
    expect(await f.store.read(original.operationId)).toEqual(original);
    const after = await lstat(f.path, { bigint: true });
    expect(after.nlink).toBe(1n);
    expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
    ]);
    expect(await readFile(f.path)).toEqual(f.bytes);
    expect(opened[0]!.file.fd).toBe(-1);
  });
});
