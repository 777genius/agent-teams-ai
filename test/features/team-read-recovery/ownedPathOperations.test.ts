// @vitest-environment node
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';

import { OwnedPathOperations } from '../../../src/features/team-read-recovery/main/infrastructure/OwnedPathOperations';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-path-operations-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('keeps an original rename and accepted result owned through held callback delivery', async () => {
  const source = join(directory, 'source');
  const destination = join(directory, 'destination');
  await writeFile(source, 'captured bytes');
  let release!: () => void;
  let observed!: () => void;
  const nativeCompleted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const owner = new OwnedPathOperations({
    ...fs,
    rename: (from, to, callback) => {
      fs.rename(from, to, (error) => {
        release = () => callback(error);
        observed();
      });
    },
  });
  const input = { kind: 'rename' as const, path: source, destination };
  const task = owner.execute(input);
  input.destination = join(directory, 'replacement-target');
  await nativeCompleted;
  const retired = owner.retire();
  try {
    const sentinel = Symbol();
    expect(await Promise.race([retired, Promise.resolve(sentinel)])).toBe(sentinel);
    expect(await readFile(destination, 'utf8')).toBe('captured bytes');
    expect(() => owner.execute({ kind: 'stat', path: destination })).toThrow('retired');
  } finally {
    release();
  }
  expect(await task.result).toBeUndefined();
  expect(await retired).toEqual({ kind: 'closed' });
});

it('bounds original pending requests and releases capacity only after callback completion', async () => {
  const path = join(directory, 'file');
  await writeFile(path, 'data');
  const owner = new OwnedPathOperations(fs, 1);
  const first = owner.execute({ kind: 'stat', path });
  expect(() => owner.execute({ kind: 'stat', path })).toThrow('capacity');
  const stat = (await first.result) as fs.Stats;
  expect(stat.size).toBe(4);
  await first.physical;
  const next = owner.execute({ kind: 'readdir', path: directory });
  expect(((await next.result) as fs.Dirent[]).map((entry) => entry.name)).toEqual(['file']);
  expect(await next.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('does not fabricate completion when an original unlink dispatch is followed by a throw', async () => {
  const path = join(directory, 'file');
  await writeFile(path, 'data');
  let observed!: () => void;
  const nativeCompleted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const owner = new OwnedPathOperations({
    ...fs,
    unlink: (file, callback) => {
      fs.unlink(file, (error) => {
        callback(error);
        observed();
      });
      throw null;
    },
  });
  const task = owner.execute({ kind: 'unlink', path });
  await expect(task.result).rejects.toThrow('null');
  expect(await task.physical).toEqual({ kind: 'unknown', fault: 'null' });
  expect(() => owner.execute({ kind: 'stat', path })).toThrow('unresolved');
  expect(await owner.retire()).toEqual({ kind: 'unknown', fault: 'null' });
  await nativeCompleted;
  expect(fs.existsSync(path)).toBe(false);
});

it('reports an original stat error without retaining a native request', async () => {
  const owner = new OwnedPathOperations();
  const task = owner.execute({ kind: 'lstat', path: join(directory, 'missing') });
  await expect(task.result).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('preserves the void mutation contract for recursive mkdir original callbacks', async () => {
  const owner = new OwnedPathOperations();
  const path = join(directory, 'nested', 'directory');
  const task = owner.execute({ kind: 'mkdir', path, recursive: true });
  expect(await task.result).toBeUndefined();
  expect(fs.statSync(path).isDirectory()).toBe(true);
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});
