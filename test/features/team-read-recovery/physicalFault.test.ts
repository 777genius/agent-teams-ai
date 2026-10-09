// @vitest-environment node
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PhysicalReadScope } from '../../../src/features/team-read-recovery/core/application/PhysicalReadScope';
import {
  OwnedReadDescriptors,
  type DescriptorCallbacks,
} from '../../../src/features/team-read-recovery/main/infrastructure/OwnedReadDescriptors';
import { OwnedPathOperations } from '../../../src/features/team-read-recovery/main/infrastructure/OwnedPathOperations';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function outcomeNow(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([promise, Promise.resolve('still pending')]);
}

const values = [
  { name: 'unstringifiable object', create: () => Object.create(null) as unknown },
  {
    name: 'throwing coercion',
    create: () => ({
      [Symbol.toPrimitive]() {
        throw new Error('coercion');
      },
    }),
  },
  {
    name: 'throwing Error message',
    create: () =>
      Object.defineProperty(new Error(), 'message', {
        get() {
          throw new Error('message getter');
        },
      }),
  },
];

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-physical-fault-'));
  path = join(directory, 'source.txt');
  await writeFile(path, 'source');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

for (const value of values) {
  describe(value.name, () => {
    it('marks a throwing pre-dispatch open UNKNOWN without losing its fault record', async () => {
      const owner = new OwnedReadDescriptors({
        ...fs,
        open: () => {
          throw value.create();
        },
      });
      const task = owner.open(path);
      await task.result.catch(() => undefined);
      expect(await outcomeNow(task.physical)).toMatchObject({ kind: 'unknown' });
      expect(owner.unresolvedLeases()).toHaveLength(1);
      expect(() => owner.open(path)).toThrow('unresolved physical work');
      expect(await owner.retire()).toMatchObject({ kind: 'unknown' });
    });

    it('suspends an ambiguous original open and closes its exact late fd', async () => {
      const ready = deferred<void>();
      const closed = deferred<void>();
      let release!: () => void;
      let ownedFd = -1;
      const open: DescriptorCallbacks['open'] = (file, flags, callback) => {
        fs.open(file, flags, (error, fd) => {
          ownedFd = fd;
          release = () => callback(error, fd);
          ready.resolve();
        });
        throw value.create();
      };
      const close: DescriptorCallbacks['close'] = (fd, callback) =>
        fs.close(fd, (error) => {
          callback(error);
          closed.resolve();
        });
      const owner = new OwnedReadDescriptors({ ...fs, open, close });
      const acquisition = owner.open(path);
      await acquisition.result.catch(() => undefined);
      await ready.promise;
      try {
        expect(await outcomeNow(acquisition.physical)).toMatchObject({ kind: 'unknown' });
        expect(owner.unresolvedLeases()).toHaveLength(1);
        expect(owner.unresolvedLeases()[0].fault.length).toBeGreaterThan(0);
        expect(() => owner.open(path)).toThrow('unresolved physical work');
      } finally {
        const retirement = owner.retire();
        release();
        await closed.promise;
        await retirement;
      }
      expect(() => fs.fstatSync(ownedFd)).toThrow();
    });

    for (const operation of ['read', 'stat'] as const) {
      it(`retains ambiguous original ${operation} bookkeeping through exact late cleanup`, async () => {
        const ready = deferred<void>();
        const closed = deferred<void>();
        let release!: () => void;
        let ownedFd = -1;
        const read: DescriptorCallbacks['read'] = (
          fd,
          buffer,
          offset,
          bytes,
          position,
          callback
        ) => {
          ownedFd = fd;
          fs.read(fd, buffer, offset, bytes, position, (error, count) => {
            release = () => callback(error, count);
            ready.resolve();
          });
          throw value.create();
        };
        const fstat: DescriptorCallbacks['fstat'] = (fd, callback) => {
          ownedFd = fd;
          fs.fstat(fd, (error, stats) => {
            release = () => callback(error, stats);
            ready.resolve();
          });
          throw value.create();
        };
        const close: DescriptorCallbacks['close'] = (fd, callback) =>
          fs.close(fd, (error) => {
            callback(error);
            closed.resolve();
          });
        const owner = new OwnedReadDescriptors({ ...fs, read, fstat, close });
        const acquisition = owner.open(path);
        const descriptor = await acquisition.result;
        const task = operation === 'read' ? descriptor.read(0, 1) : descriptor.stat();
        await task.result.catch(() => undefined);
        await ready.promise;
        try {
          expect(await outcomeNow(task.physical)).toMatchObject({ kind: 'unknown' });
          expect(await outcomeNow(acquisition.physical)).toMatchObject({ kind: 'unknown' });
          expect(() => owner.open(path)).toThrow('unresolved physical work');
          expect(fs.fstatSync(ownedFd).isFile()).toBe(true);
        } finally {
          const retirement = owner.retire();
          release();
          await closed.promise;
          await retirement;
        }
        expect(() => fs.fstatSync(ownedFd)).toThrow();
      });
    }

    it('preserves UNKNOWN after an ambiguous original path operation', async () => {
      const ready = deferred<void>();
      let release!: () => void;
      const stat = (
        file: string,
        callback: (error: NodeJS.ErrnoException | null, stats: fs.Stats) => void
      ): void => {
        fs.stat(file, (error, stats) => {
          release = () => callback(error, stats);
          ready.resolve();
        });
        throw value.create();
      };
      const owner = new OwnedPathOperations({ ...fs, stat });
      const task = owner.execute({ kind: 'stat', path });
      await task.result.catch(() => undefined);
      await ready.promise;
      try {
        expect(await outcomeNow(task.physical)).toMatchObject({ kind: 'unknown' });
        expect(() => owner.execute({ kind: 'stat', path })).toThrow('unresolved physical work');
      } finally {
        release();
        await owner.retire();
      }
    });

    it('finishes factory failure as UNKNOWN without attempting coercion outside protection', async () => {
      const scope = new PhysicalReadScope();
      let result: Promise<unknown> | undefined;
      try {
        result = scope.start(() => {
          throw value.create();
        });
        await result.catch(() => undefined);
      } finally {
        scope.finishTop();
      }
      expect(await outcomeNow(scope.drained)).toMatchObject({ kind: 'unknown' });
    });

    it('observes the entire rejected physical chain without an unhandled rejection', async () => {
      const scope = new PhysicalReadScope();
      const events: unknown[] = [];
      const observe = (error: unknown): void => {
        events.push(error);
      };
      process.on('unhandledRejection', observe);
      try {
        expect(
          await scope.start(() => ({
            result: Promise.resolve('logical'),
            physical: Promise.reject(value.create()),
          }))
        ).toBe('logical');
        scope.finishTop();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await outcomeNow(scope.drained)).toMatchObject({ kind: 'unknown' });
        expect(events).toEqual([]);
      } finally {
        process.off('unhandledRejection', observe);
      }
    });
  });
}
