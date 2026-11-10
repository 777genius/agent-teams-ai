// @vitest-environment node
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PhysicalReadScope,
  type ReadContinuation,
} from '../../../src/features/team-read-recovery/core/application/PhysicalReadScope';
import {
  OwnedReadDescriptors,
  type DescriptorCallbacks,
} from '../../../src/features/team-read-recovery/main/infrastructure/OwnedReadDescriptors';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol();
  return (await Promise.race([promise, Promise.resolve(sentinel)])) === sentinel;
}

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-owned-descriptors-'));
  path = join(directory, 'source.txt');
  await writeFile(path, 'captured source');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('original callback descriptor ownership', () => {
  it('keeps physical drain pending after result and original read, until original close', async () => {
    const owner = new OwnedReadDescriptors();
    const scope = new PhysicalReadScope();
    const task = owner.open(path);
    const descriptor = await scope.start(() => task);
    scope.finishTop();
    const read = descriptor.read(0, 100);
    expect(Buffer.from(await read.result).toString()).toBe('captured source');
    expect(await read.physical).toEqual({ kind: 'closed' });
    expect(await isPending(task.physical)).toBe(true);
    expect(await isPending(scope.drained)).toBe(true);
    await descriptor.close();
    expect(await scope.drained).toEqual({ kind: 'closed' });
    expect(await owner.retire()).toEqual({ kind: 'closed' });
  });

  it('retains a late original open and closes it after retirement without delivering its lease', async () => {
    const opened = deferred<void>();
    let release!: () => void;
    let fd = -1;
    const open: typeof fs.open = ((...args: Parameters<typeof fs.open>) => {
      const callback = args.pop() as (error: NodeJS.ErrnoException | null, fd: number) => void;
      fs.open(args[0] as string, fs.constants.O_RDONLY, (error, value) => {
        fd = value;
        release = () => callback(error, value);
        opened.resolve();
      });
    }) as typeof fs.open;
    const owner = new OwnedReadDescriptors({ ...fs, open });
    const task = owner.open(path);
    await opened.promise;
    const retired = owner.retire();
    expect(await isPending(retired)).toBe(true);
    release();
    await expect(task.result).rejects.toThrow('retired during open');
    expect(await retired).toEqual({ kind: 'closed' });
    expect(() => fs.fstatSync(fd)).toThrow();
    expect(() => owner.open(path)).toThrow('retired');
  });

  it('waits for an outstanding original read callback before closing', async () => {
    const readDone = deferred<void>();
    let release!: () => void;
    const read: typeof fs.read = ((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: (error: NodeJS.ErrnoException | null, count: number) => void
    ) => {
      fs.read(fd, buffer, offset, length, position, (error, count) => {
        release = () => callback(error, count);
        readDone.resolve();
      });
    }) as typeof fs.read;
    const owner = new OwnedReadDescriptors({ ...fs, read });
    const descriptor = await owner.open(path).result;
    const reading = descriptor.read(0, 100);
    await readDone.promise;
    const retired = owner.retire();
    expect(await isPending(retired)).toBe(true);
    expect(() => descriptor.read(0, 1)).toThrow('closing');
    release();
    expect(Buffer.from(await reading.result).toString()).toBe('captured source');
    expect(await retired).toEqual({ kind: 'closed' });
  });

  it('retains the descriptor until the original fstat callback completes after retirement', async () => {
    const observed = deferred<void>();
    let release!: () => void;
    let heldFd = -1;
    const fstat: DescriptorCallbacks['fstat'] = (fd, callback) => {
      heldFd = fd;
      fs.fstat(fd, (error, value) => {
        release = () => callback(error, value);
        observed.resolve();
      });
    };
    const owner = new OwnedReadDescriptors({ ...fs, fstat });
    const acquisition = owner.open(path);
    const descriptor = await acquisition.result;
    const metadata = descriptor.stat();
    await observed.promise;
    expect(() => descriptor.read(0, 1)).toThrow('capacity');
    const retirement = owner.retire();
    try {
      expect(await isPending(retirement)).toBe(true);
      expect(await isPending(metadata.physical)).toBe(true);
      expect(fs.fstatSync(heldFd).isFile()).toBe(true);
    } finally {
      release();
      await retirement;
    }
    expect((await metadata.result).size).toBe(Buffer.byteLength('captured source'));
    expect(await metadata.physical).toEqual({ kind: 'closed' });
    expect(await acquisition.physical).toEqual({ kind: 'closed' });
    expect(() => fs.fstatSync(heldFd)).toThrow();
  });

  it('keeps a dispatched fstat throw UNKNOWN while closing its exact late descriptor', async () => {
    const observed = deferred<void>();
    const closedFd = deferred<void>();
    let release!: () => void;
    let heldFd = -1;
    const fstat: DescriptorCallbacks['fstat'] = (fd, callback) => {
      heldFd = fd;
      fs.fstat(fd, (error, value) => {
        release = () => callback(error, value);
        observed.resolve();
      });
      throw 'dispatched fstat';
    };
    const close: DescriptorCallbacks['close'] = (fd, callback) => {
      fs.close(fd, (error) => {
        callback(error);
        closedFd.resolve();
      });
    };
    const owner = new OwnedReadDescriptors({ ...fs, fstat, close });
    const acquisition = owner.open(path);
    const descriptor = await acquisition.result;
    const metadata = descriptor.stat();
    await expect(metadata.result).rejects.toThrow('dispatched fstat');
    await observed.promise;
    try {
      expect(await metadata.physical).toEqual({ kind: 'unknown', fault: 'dispatched fstat' });
      expect(await acquisition.physical).toEqual({ kind: 'unknown', fault: 'dispatched fstat' });
      expect(() => owner.open(path)).toThrow('unresolved physical work');
      expect(fs.fstatSync(heldFd).isFile()).toBe(true);
    } finally {
      release();
      await closedFd.promise;
    }
    expect(() => fs.fstatSync(heldFd)).toThrow();
    expect(await owner.retire()).toEqual({ kind: 'unknown', fault: 'dispatched fstat' });
  });

  it('captures write bytes and preserves the original partial-write result through retirement', async () => {
    const completed = deferred<void>();
    let dispatch!: () => void;
    let release!: () => void;
    let heldFd = -1;
    const write: DescriptorCallbacks['write'] = (fd, buffer, offset, bytes, position, callback) => {
      heldFd = fd;
      dispatch = () =>
        fs.write(fd, buffer, offset, Math.min(bytes, 2), position, (error, count) => {
          release = () => callback(error, count);
          completed.resolve();
        });
    };
    const owner = new OwnedReadDescriptors({ ...fs, write });
    const acquisition = owner.open(path, fs.constants.O_RDWR | fs.constants.O_TRUNC);
    const descriptor = await acquisition.result;
    const input = Buffer.from('bytes');
    const writing = descriptor.write(0, input);
    input.fill(120);
    expect(() => descriptor.sync()).toThrow('capacity');
    const retirement = owner.retire();
    dispatch();
    await completed.promise;
    try {
      expect(fs.readFileSync(path, 'utf8')).toBe('by');
      expect(await isPending(retirement)).toBe(true);
      expect(await isPending(writing.physical)).toBe(true);
      expect(fs.fstatSync(heldFd).isFile()).toBe(true);
    } finally {
      release();
      await retirement;
    }
    expect(await writing.result).toBe(2);
    expect(await writing.physical).toEqual({ kind: 'closed' });
    expect(await acquisition.physical).toEqual({ kind: 'closed' });
    expect(() => fs.fstatSync(heldFd)).toThrow();
  });

  it('waits for the original fsync callback before closing the owned descriptor', async () => {
    const completed = deferred<void>();
    let release!: () => void;
    let heldFd = -1;
    const fsync: DescriptorCallbacks['fsync'] = (fd, callback) => {
      heldFd = fd;
      fs.fsync(fd, (error) => {
        release = () => callback(error);
        completed.resolve();
      });
    };
    const owner = new OwnedReadDescriptors({ ...fs, fsync });
    const acquisition = owner.open(path, fs.constants.O_RDWR);
    const descriptor = await acquisition.result;
    const syncing = descriptor.sync();
    await completed.promise;
    const retirement = owner.retire();
    try {
      expect(await isPending(retirement)).toBe(true);
      expect(await isPending(syncing.physical)).toBe(true);
      expect(fs.fstatSync(heldFd).isFile()).toBe(true);
    } finally {
      release();
      await retirement;
    }
    expect(await syncing.result).toBeUndefined();
    expect(await syncing.physical).toEqual({ kind: 'closed' });
    expect(() => fs.fstatSync(heldFd)).toThrow();
  });

  it.runIf(process.platform === 'linux')(
    'retains a kernel-blocked original main open after genuine Worker exit, then closes the late descriptor',
    async () => {
      const fifo = join(directory, 'held-open.fifo');
      execFileSync('mkfifo', [fifo]);
      const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
      const owner = new OwnedReadDescriptors();
      let writer = -1;
      let exited = false;
      let opened = false;
      try {
        await once(worker, 'online');
        const task = owner.open(fifo);
        opened = true;
        const deadline = Date.now() + 5000;
        let kernelBlocked = false;
        while (!kernelBlocked && Date.now() < deadline) {
          kernelBlocked = fs.readdirSync('/proc/self/task').some((tid) => {
            try {
              return (
                fs.readFileSync(`/proc/self/task/${tid}/wchan`, 'utf8').trim() ===
                'wait_for_partner'
              );
            } catch {
              return false;
            }
          });
          if (!kernelBlocked) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(kernelBlocked).toBe(true);
        const retired = owner.retire();
        expect(await worker.terminate()).toBe(1);
        exited = true;
        expect(await isPending(task.physical)).toBe(true);
        expect(await isPending(retired)).toBe(true);
        writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        await expect(task.result).rejects.toThrow('retired during open');
        expect(await retired).toEqual({ kind: 'closed' });
        fs.closeSync(writer);
        writer = -1;
        const matching = fs.readdirSync('/proc/self/fd').filter((fd) => {
          try {
            return fs.readlinkSync(`/proc/self/fd/${fd}`) === fifo;
          } catch {
            return false;
          }
        });
        expect(matching).toEqual([]);
      } finally {
        if (opened && writer < 0)
          writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        await owner.retire();
        if (writer >= 0) fs.closeSync(writer);
        if (!exited) await worker.terminate();
      }
    }
  );

  it('reports close failure as UNKNOWN and never retries a possibly reused descriptor', async () => {
    let fd = -1;
    let closes = 0;
    const close: DescriptorCallbacks['close'] = (value, callback) => {
      fd = value;
      closes++;
      callback(new Error('indeterminate native close'));
    };
    const owner = new OwnedReadDescriptors({ ...fs, close });
    const task = owner.open(path);
    const descriptor = await task.result;
    try {
      const outcome = await descriptor.close();
      expect(outcome).toEqual({ kind: 'unknown', fault: 'indeterminate native close' });
      expect(await descriptor.close()).toEqual(outcome);
      expect(await owner.retire()).toEqual(outcome);
      expect(closes).toBe(1);
    } finally {
      if (fd >= 0) fs.closeSync(fd);
    }
  });
});

describe('ambiguous dispatch and bounded physical admission', () => {
  it('keeps scope and retirement pending through held original close delivery', async () => {
    const closed = deferred<void>();
    let release!: () => void;
    const owner = new OwnedReadDescriptors({
      ...fs,
      close: (fd, callback) => {
        fs.close(fd, (error) => {
          release = () => callback(error);
          closed.resolve();
        });
      },
    });
    const scope = new PhysicalReadScope();
    const task = owner.open(path);
    await scope.start(() => task);
    scope.finishTop();
    const retired = owner.retire();
    await closed.promise;
    try {
      expect(await isPending(scope.drained)).toBe(true);
      expect(await isPending(retired)).toBe(true);
    } finally {
      release();
    }
    expect(await scope.drained).toEqual({ kind: 'closed' });
    expect(await retired).toEqual({ kind: 'closed' });
  });

  it.each([null, 'primitive close failure'])(
    'normalizes a thrown close value %s and suspends acquisition before explicit retirement',
    async (thrown) => {
      let fd = -1;
      let attempts = 0;
      const owner = new OwnedReadDescriptors({
        ...fs,
        close: (value) => {
          fd = value;
          attempts++;
          throw thrown;
        },
      });
      const descriptor = await owner.open(path).result;
      try {
        const outcome = await descriptor.close();
        expect(outcome).toEqual({ kind: 'unknown', fault: String(thrown) });
        expect(() => owner.open(path)).toThrow('unresolved physical work');
        expect(owner.unresolvedLeases()).toEqual([{ lease: 1, fault: String(thrown) }]);
        expect(await descriptor.close()).toEqual(outcome);
        expect(await owner.retire()).toEqual(outcome);
        expect(await owner.retire()).toEqual(outcome);
        expect(attempts).toBe(1);
      } finally {
        fs.closeSync(fd);
      }
    }
  );

  it('retains a real open dispatched before a primitive throw, then closes its late lease', async () => {
    const closed = deferred<void>();
    let fd = -1;
    const owner = new OwnedReadDescriptors({
      ...fs,
      open: (file, flags, callback) => {
        fs.open(file, flags, callback);
        throw 'after original dispatch';
      },
      close: (value, callback) => {
        fd = value;
        fs.close(value, (error) => {
          callback(error);
          closed.resolve();
        });
      },
    });
    const task = owner.open(path);
    await expect(task.result).rejects.toThrow('after original dispatch');
    expect(await task.physical).toEqual({ kind: 'unknown', fault: 'after original dispatch' });
    expect(() => owner.open(path)).toThrow('unresolved physical work');
    expect(await owner.retire()).toMatchObject({ kind: 'unknown' });
    await closed.promise;
    expect(() => fs.fstatSync(fd)).toThrow();
    expect(owner.unresolvedLeases()).toEqual([{ lease: 1, fault: 'after original dispatch' }]);
  });

  it('reports a throw before open dispatch as UNKNOWN rather than inventing original completion', async () => {
    const owner = new OwnedReadDescriptors({
      ...fs,
      open: () => {
        throw null;
      },
    });
    const task = owner.open(path);
    await expect(task.result).rejects.toThrow('null');
    expect(await task.physical).toEqual({ kind: 'unknown', fault: 'null' });
    expect(await owner.retire()).toEqual({ kind: 'unknown', fault: 'null' });
  });

  it('does not decrement an outstanding original read after a dispatch-then-throw', async () => {
    const readDone = deferred<void>();
    const closed = deferred<void>();
    let release!: () => void;
    let closes = 0;
    const owner = new OwnedReadDescriptors({
      ...fs,
      read: (fd, buffer, offset, bytes, position, callback) => {
        fs.read(fd, buffer, offset, bytes, position, (error, count) => {
          release = () => callback(error, count);
          readDone.resolve();
        });
        throw new Error('after read dispatch');
      },
      close: (fd, callback) => {
        closes++;
        fs.close(fd, (error) => {
          callback(error);
          closed.resolve();
        });
      },
    });
    const descriptor = await owner.open(path).result;
    const reading = descriptor.read(0, 100);
    await expect(reading.result).rejects.toThrow('after read dispatch');
    expect(await reading.physical).toMatchObject({ kind: 'unknown' });
    await readDone.promise;
    try {
      expect(closes).toBe(0);
      expect(() => owner.open(path)).toThrow('unresolved physical work');
      expect(await owner.retire()).toMatchObject({ kind: 'unknown' });
    } finally {
      release();
    }
    await closed.promise;
    expect(closes).toBe(1);
  });

  it('observes abandoned original-result rejection without an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const listener = (reason: unknown): void => {
      errors.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const owner = new OwnedReadDescriptors();
      const task = owner.open(join(directory, 'missing'));
      // Intentionally leave task.result unconsumed.
      expect(await task.physical).toEqual({ kind: 'closed' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors).toEqual([]);
      expect(await owner.retire()).toEqual({ kind: 'closed' });
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('never retries an original close dispatched before its wrapper throws', async () => {
    const observed = deferred<void>();
    let attempts = 0;
    let fd = -1;
    const owner = new OwnedReadDescriptors({
      ...fs,
      close: (value, callback) => {
        fd = value;
        attempts++;
        fs.close(value, (error) => {
          callback(error);
          observed.resolve();
        });
        throw 'after close dispatch';
      },
    });
    const descriptor = await owner.open(path).result;
    expect(await descriptor.close()).toEqual({ kind: 'unknown', fault: 'after close dispatch' });
    expect(await owner.retire()).toMatchObject({ kind: 'unknown' });
    await observed.promise;
    expect(() => fs.fstatSync(fd)).toThrow();
    expect(attempts).toBe(1);
    expect(owner.unresolvedLeases()).toEqual([{ lease: 1, fault: 'after close dispatch' }]);
  });

  it('bounds acquisitions and outstanding buffers until their original callbacks complete', async () => {
    const owner = new OwnedReadDescriptors(fs, { maxOpenFiles: 1, maxReadsPerFile: 1 });
    const first = owner.open(path);
    expect(() => owner.open(path)).toThrow('capacity reached');
    const descriptor = await first.result;
    const reading = descriptor.read(0, 100);
    expect(() => descriptor.read(0, 100)).toThrow('read capacity reached');
    await reading.result;
    await reading.physical;
    expect(Buffer.from(await descriptor.read(0, 100).result).toString()).toBe('captured source');
    await descriptor.close();
    await first.physical;
    const next = await owner.open(path).result;
    await next.close();
    expect(await owner.retire()).toEqual({ kind: 'closed' });
  });
});

describe('physical continuation barrier', () => {
  it('keeps late cleanup admitted under its live physical parent after top completion', async () => {
    const scope = new PhysicalReadScope();
    const parent = deferred<{ kind: 'closed' }>();
    const cleanup = deferred<{ kind: 'closed' }>();
    let continuation!: ReadContinuation;
    await scope.start((child) => {
      continuation = child;
      return { result: Promise.resolve('early result'), physical: parent.promise };
    });
    scope.finishTop();
    expect(() =>
      scope.start(() => {
        throw new Error('must not dispatch');
      })
    ).toThrow('top is finished');
    await continuation.start(() => ({ result: Promise.resolve(), physical: cleanup.promise }));
    parent.resolve({ kind: 'closed' });
    await Promise.resolve();
    expect(await isPending(scope.drained)).toBe(true);
    cleanup.resolve({ kind: 'closed' });
    expect(await scope.drained).toEqual({ kind: 'closed' });
    expect(() =>
      continuation.start(() => {
        throw new Error('must not dispatch');
      })
    ).toThrow('parent has settled');
  });

  it('reports factory dispatch-then-throw as UNKNOWN while the original open callback is held', async () => {
    const opened = deferred<void>();
    let release!: () => void;
    const owner = new OwnedReadDescriptors({
      ...fs,
      open: (file, flags, callback) => {
        fs.open(file, flags, (error, fd) => {
          release = () => callback(error, fd);
          opened.resolve();
        });
      },
    });
    const scope = new PhysicalReadScope();
    await expect(
      scope.start(() => {
        owner.open(path);
        throw new Error('factory failed after dispatch');
      })
    ).rejects.toThrow('after dispatch');
    await opened.promise;
    try {
      scope.finishTop();
      expect(await scope.drained).toEqual({
        kind: 'unknown',
        fault: 'factory failed after dispatch',
      });
      const retired = owner.retire();
      expect(await isPending(retired)).toBe(true);
      release();
      release = () => undefined;
      expect(await retired).toEqual({ kind: 'closed' });
    } finally {
      release();
      await owner.retire();
    }
  });

  it('keeps UNKNOWN independent of diagnostic text', async () => {
    const scope = new PhysicalReadScope();
    await scope.start(() => ({
      result: Promise.resolve(),
      physical: Promise.resolve({ kind: 'unknown', fault: '' }),
    }));
    scope.finishTop();
    expect(await scope.drained).toEqual({
      kind: 'unknown',
      fault: 'Physical completion is unconfirmed',
    });
  });

  it('never promotes rejected physical proof to CLOSED', async () => {
    const scope = new PhysicalReadScope();
    await scope.start(() => ({
      result: Promise.resolve(),
      physical: Promise.reject(new Error('physical proof missing')),
    }));
    scope.finishTop();
    expect(await scope.drained).toEqual({ kind: 'unknown', fault: 'physical proof missing' });
  });
});

it('copies the complete raw intrinsic byte view without consulting shadowed metadata', async () => {
  const owner = new OwnedReadDescriptors();
  const acquisition = owner.open(path, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
  const descriptor = await acquisition.result;
  const data = Uint8Array.from([120, 65, 66, 121]).subarray(1, 3);
  for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'valueOf']) {
    Object.defineProperty(data, key, {
      get() {
        throw new Error('shadowed metadata');
      },
    });
  }
  try {
    const task = descriptor.write(0, data);
    data.fill(90);
    expect(await task.result).toBe(2);
    expect(await task.physical).toEqual({ kind: 'closed' });
    expect(fs.readFileSync(path)).toEqual(Buffer.from([65, 66]));
  } finally {
    expect(await acquisition.close()).toEqual({ kind: 'closed' });
    expect(await owner.retire()).toEqual({ kind: 'closed' });
  }
});

it('enforces the raw chunk limit using intrinsic view size before native dispatch', async () => {
  const owner = new OwnedReadDescriptors();
  const acquisition = owner.open(path, fs.constants.O_WRONLY);
  const descriptor = await acquisition.result;
  const data = new Uint8Array(1024 * 1024 + 1);
  Object.defineProperty(data, 'byteLength', { value: 0 });
  try {
    expect(() => descriptor.write(0, data)).toThrow('write range');
    expect(fs.readFileSync(path, 'utf8')).toBe('captured source');
  } finally {
    expect(await acquisition.close()).toEqual({ kind: 'closed' });
    expect(await owner.retire()).toEqual({ kind: 'closed' });
  }
});
