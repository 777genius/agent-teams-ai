// @vitest-environment node
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { OwnedReadDescriptors } from '../../../src/features/team-read-recovery/main/infrastructure/OwnedReadDescriptors';
import { readOwnedUtf8 } from '../../../src/features/team-read-recovery/main/infrastructure/readOwnedUtf8';
import { FileReadTimeoutError } from '../../../src/main/utils/fsRead';

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-owned-utf8-'));
  path = join(directory, 'source.txt');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('decodes Unicode across the bounded chunk boundary without corrupting content', async () => {
  const text = 'x'.repeat(1024 * 1024 - 1) + '😀end';
  await writeFile(path, text);
  const task = readOwnedUtf8(
    path,
    { timeoutMs: 5000, maxBytes: Buffer.byteLength(text) },
    new OwnedReadDescriptors()
  );
  expect(await task.result).toBe(text);
  expect(await task.physical).toEqual({ kind: 'closed' });
});

it('rejects overflow instead of silently truncating a full file', async () => {
  await writeFile(path, 'one extra byte');
  const task = readOwnedUtf8(path, { timeoutMs: 5000, maxBytes: 3 }, new OwnedReadDescriptors());
  await expect(task.result).rejects.toThrow('byte limit');
  expect(await task.physical).toEqual({ kind: 'closed' });
});

it('preserves explicit head-only reading and closes the original descriptor', async () => {
  await writeFile(path, 'head and remaining content');
  const task = readOwnedUtf8(
    path,
    { timeoutMs: 5000, maxBytes: 4, headOnly: true },
    new OwnedReadDescriptors()
  );
  expect(await task.result).toBe('head');
  expect(await task.physical).toEqual({ kind: 'closed' });
});

it('reports a missing file through the logical port while proving no remaining descriptor', async () => {
  const task = readOwnedUtf8(path, { timeoutMs: 5000, maxBytes: 100 }, new OwnedReadDescriptors());
  await expect(task.result).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await task.physical).toEqual({ kind: 'closed' });
});

it.runIf(process.platform === 'linux')(
  'keeps physical ownership of a kernel-blocked original open after the existing read timeout',
  async () => {
    const fifo = join(directory, 'blocked.fifo');
    execFileSync('mkfifo', [fifo]);
    const task = readOwnedUtf8(fifo, { timeoutMs: 10, maxBytes: 100 }, new OwnedReadDescriptors());
    let writer = -1;
    try {
      await expect(task.result).rejects.toBeInstanceOf(FileReadTimeoutError);
      const blocked = fs.readdirSync('/proc/self/task').some((tid) => {
        try {
          return (
            fs.readFileSync(`/proc/self/task/${tid}/wchan`, 'utf8').trim() === 'wait_for_partner'
          );
        } catch {
          return false;
        }
      });
      expect(blocked).toBe(true);
      const sentinel = Symbol();
      expect(await Promise.race([task.physical, Promise.resolve(sentinel)])).toBe(sentinel);
      writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      expect(await task.physical).toEqual({ kind: 'closed' });
    } finally {
      if (writer < 0) writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      await task.physical;
      fs.closeSync(writer);
    }
  }
);

it('uses shared producer acquisition limits and does not retire the owner after a successful file read', async () => {
  await writeFile(path, 'shared owner');
  const owner = new OwnedReadDescriptors(fs, { maxOpenFiles: 1, maxReadsPerFile: 1 });
  const first = readOwnedUtf8(path, { timeoutMs: 5000, maxBytes: 100 }, owner);
  const overflow = readOwnedUtf8(path, { timeoutMs: 5000, maxBytes: 100 }, owner);
  await expect(overflow.result).rejects.toThrow('acquisition capacity');
  expect(await overflow.physical).toEqual({ kind: 'closed' });
  expect(await first.result).toBe('shared owner');
  expect(await first.physical).toEqual({ kind: 'closed' });
  const next = readOwnedUtf8(path, { timeoutMs: 5000, maxBytes: 100 }, owner);
  expect(await next.result).toBe('shared owner');
  expect(await next.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});
