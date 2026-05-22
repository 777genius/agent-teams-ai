import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalFileSystemProvider } from '../../../../src/main/services/infrastructure/LocalFileSystemProvider';

describe('LocalFileSystemProvider', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-fs-provider-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'session.jsonl'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'nested'));
    return dir;
  }

  it('can return bare dirents without eager stat metadata', async () => {
    const dir = createFixture();
    const provider = new LocalFileSystemProvider();

    const entries = await provider.readdir(dir, { prefetchEntryStats: false });
    const fileEntry = entries.find((entry) => entry.name === 'session.jsonl');
    const dirEntry = entries.find((entry) => entry.name === 'nested');

    expect(fileEntry?.isFile()).toBe(true);
    expect(fileEntry?.size).toBeUndefined();
    expect(fileEntry?.mtimeMs).toBeUndefined();
    expect(dirEntry?.isDirectory()).toBe(true);
  });

  it('keeps eager stat metadata as the default behavior', async () => {
    const dir = createFixture();
    const provider = new LocalFileSystemProvider();

    const entries = await provider.readdir(dir);
    const fileEntry = entries.find((entry) => entry.name === 'session.jsonl');

    expect(fileEntry?.isFile()).toBe(true);
    expect(fileEntry?.size).toBe(Buffer.byteLength('{}\n'));
    expect(typeof fileEntry?.mtimeMs).toBe('number');
    expect(typeof fileEntry?.birthtimeMs).toBe('number');
  });
});
