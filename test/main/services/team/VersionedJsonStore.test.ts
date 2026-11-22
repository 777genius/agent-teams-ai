import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  VersionedJsonStore,
  VersionedJsonStoreError,
} from '../../../../src/main/services/team/opencode/store/VersionedJsonStore';
import { withFileLock } from '../../../../src/main/services/team/fileLock';

describe('VersionedJsonStore', () => {
  let tempDir: string;
  let now: Date;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-versioned-store-'));
    now = new Date('2026-04-21T12:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes an envelope atomically and skips unchanged updates', async () => {
    const filePath = path.join(tempDir, 'store.json');
    const store = new VersionedJsonStore<string[]>({
      filePath,
      schemaVersion: 1,
      defaultData: () => [],
      validate: validateStringArray,
      clock: () => now,
    });

    await expect(store.read()).resolves.toMatchObject({
      ok: true,
      status: 'missing',
      data: [],
    });

    const first = await store.updateLocked((current) => [...current, 'a']);
    expect(first.changed).toBe(true);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      updatedAt: '2026-04-21T12:00:00.000Z',
      data: ['a'],
    });

    now = new Date('2026-04-21T12:05:00.000Z');
    const second = await store.updateLocked((current) => current);
    expect(second.changed).toBe(false);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      updatedAt: '2026-04-21T12:00:00.000Z',
      data: ['a'],
    });
  });

  it('quarantines corrupt JSON and blocks updates instead of overwriting evidence', async () => {
    const filePath = path.join(tempDir, 'store.json');
    await fs.writeFile(filePath, '{bad-json', 'utf8');

    const store = new VersionedJsonStore<string[]>({
      filePath,
      schemaVersion: 1,
      defaultData: () => [],
      validate: validateStringArray,
      clock: () => now,
    });

    const read = await store.read();
    expect(read).toMatchObject({
      ok: false,
      reason: 'invalid_json',
    });
    expect(read.ok ? null : read.quarantinePath).toEqual(expect.stringContaining('invalid_json'));
    await expect(fs.readFile(read.ok ? '' : read.quarantinePath ?? '', 'utf8')).resolves.toBe(
      '{bad-json'
    );

    await expect(store.updateLocked((current) => [...current, 'lost'])).rejects.toBeInstanceOf(
      VersionedJsonStoreError
    );
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('{bad-json');
  });

  it('quarantines future schema and refuses downgrade writes', async () => {
    const filePath = path.join(tempDir, 'store.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: '2026-04-21T12:00:00.000Z',
        data: ['future'],
      }),
      'utf8'
    );

    const store = new VersionedJsonStore<string[]>({
      filePath,
      schemaVersion: 1,
      defaultData: () => [],
      validate: validateStringArray,
      clock: () => now,
    });

    const read = await store.read();
    expect(read).toMatchObject({
      ok: false,
      reason: 'future_schema',
    });

    await expect(store.updateLocked(() => ['downgraded'])).rejects.toMatchObject({
      reason: 'future_schema',
    });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      data: ['future'],
    });
  });

  it('queues same-file store instances before starting their cross-process acquire timeout', async () => {
    const filePath = path.join(tempDir, 'queued.json');
    const createStore = () =>
      new VersionedJsonStore<string[]>({
        filePath,
        schemaVersion: 1,
        defaultData: () => [],
        validate: validateStringArray,
        lockOptions: { acquireTimeoutMs: 20, retryIntervalMs: 1 },
      });
    const entered = deferred();
    const release = deferred();
    const first = createStore().updateLocked(async (current) => {
      entered.resolve();
      await release.promise;
      return [...current, 'first'];
    });
    await entered.promise;
    const second = createStore().updateLocked((current) => [...current, 'second']);
    const results = Promise.allSettled([first, second]);
    try {
      // A local predecessor legitimately owns the lock longer than a waiter's
      // acquire budget. That budget must begin only after the predecessor leaves.
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      release.resolve();
    }
    expect((await results).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(createStore().read()).resolves.toMatchObject({ data: ['first', 'second'] });
  });

  it('rejects reentrant same-path updates without deadlocking later writers', async () => {
    const createStore = (name: string) =>
      new VersionedJsonStore<string[]>({
        filePath: path.join(tempDir, name),
        schemaVersion: 1,
        defaultData: () => [],
        validate: validateStringArray,
      });
    const outer = createStore('same.json');
    const inner = createStore('same.json');
    const different = createStore('different.json');

    await expect(
      outer.updateLocked(async (current) => {
        await inner.updateLocked((value) => [...value, 'must not commit']);
        return current;
      })
    ).rejects.toThrow('Reentrant VersionedJsonStore update');

    await expect(
      outer.updateLocked(async (current) => {
        await different.updateLocked(() => ['independent']);
        return [...current, 'after nested rejection'];
      })
    ).resolves.toMatchObject({ data: ['after nested rejection'] });
    await expect(inner.read()).resolves.toMatchObject({ data: ['after nested rejection'] });
    await expect(different.read()).resolves.toMatchObject({ data: ['independent'] });
  });

  it('continues after a rejected writer and lets unrelated files progress independently', async () => {
    const createStore = (name: string) =>
      new VersionedJsonStore<string[]>({
        filePath: path.join(tempDir, name),
        schemaVersion: 1,
        defaultData: () => [],
        validate: validateStringArray,
      });
    const entered = deferred();
    const release = deferred();
    const failure = new Error('TEST updater failure');
    const first = createStore('a.json').updateLocked(async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    });
    await entered.promise;
    const second = createStore('a.json').updateLocked((current) => [...current, 'after failure']);
    const results = Promise.allSettled([first, second]);
    try {
      await expect(createStore('b.json').updateLocked(() => ['independent'])).resolves.toMatchObject({
        data: ['independent'],
      });
    } finally {
      release.resolve();
    }
    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: expect.objectContaining({ data: ['after failure'] }) },
    ]);
  });

  it('preserves the external lock owner and acquisition timeout outside the local store queue', async () => {
    const filePath = path.join(tempDir, 'external.json');
    const store = new VersionedJsonStore<string[]>({
      filePath,
      schemaVersion: 1,
      defaultData: () => [],
      validate: validateStringArray,
      lockOptions: { acquireTimeoutMs: 20, retryIntervalMs: 1 },
    });
    const entered = deferred();
    const release = deferred();
    const external = withFileLock(filePath, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const before = await fs.readFile(`${filePath}.lock`, 'utf8');
    try {
      await expect(store.updateLocked(() => ['blocked'])).rejects.toThrow('File lock timeout:');
      expect(await fs.readFile(`${filePath}.lock`, 'utf8')).toBe(before);
    } finally {
      release.resolve();
      await external;
    }
    await expect(store.updateLocked(() => ['after release'])).resolves.toMatchObject({
      data: ['after release'],
    });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function validateStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('expected string array');
  }
  return value;
}
