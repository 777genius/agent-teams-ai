import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  VersionedJsonStore,
  VersionedJsonStoreError,
} from '../../../../src/main/services/team/opencode/store/VersionedJsonStore';

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
});

function validateStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('expected string array');
  }
  return value;
}
