import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep real filesystem behavior while allowing fault injection into the app's
// fs import; native ESM namespace exports themselves are not configurable.
vi.mock('fs', async () => ({ ...(await vi.importActual<typeof import('fs')>('fs')) }));

const canAssertPosixPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('withFileLock', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filelock-test-'));
    testFile = path.join(tmpDir, 'test.json');
    fs.writeFileSync(testFile, '[]', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases lock around fn()', async () => {
    const lockPath = `${testFile}.lock`;

    const result = await withFileLock(testFile, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases lock even on error', async () => {
    const lockPath = `${testFile}.lock`;

    await expect(
      withFileLock(testFile, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent access', async () => {
    const order: number[] = [];

    const task = (id: number, delayMs: number) =>
      withFileLock(testFile, async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      });

    await Promise.all([task(1, 50), task(2, 10), task(3, 10)]);

    expect(order).toHaveLength(3);
    expect(new Set(order).size).toBe(3);
  });

  it('removes stale lock and acquires', async () => {
    const lockPath = `${testFile}.lock`;
    // Create a stale lock (timestamp 60s ago)
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 60_000}\n`, 'utf8');

    const result = await withFileLock(testFile, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('removes stale directory lock and acquires', async () => {
    const lockPath = `${testFile}.lock`;
    fs.mkdirSync(lockPath);
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const result = await withFileLock(testFile, async () => 'ok', {
      staleTimeoutMs: 1_000,
    });

    expect(result).toBe('ok');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removes a fresh abandoned lock when the owner process is gone', async () => {
    const lockPath = `${testFile}.lock`;
    const abandonedPid = 424_242;
    fs.writeFileSync(lockPath, `${abandonedPid}\n${Date.now()}\n`, 'utf8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number | string) => {
      if (pid === abandonedPid) {
        const error = new Error('process is gone') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    try {
      const result = await withFileLock(testFile, async () => 'ok');

      expect(result).toBe('ok');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('keeps an aged live owner exclusive across an awaited barrier', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      entered();
      await barrier;
    });
    await acquired;
    const lockPath = `${testFile}.lock`;
    const original = fs.readFileSync(lockPath, 'utf8');
    fs.writeFileSync(
      lockPath,
      original.replace(original.split('\n')[1], String(Date.now() - 100_000))
    );
    const critical = vi.fn(async () => {});
    await expect(
      withFileLock(testFile, critical, {
        acquireTimeoutMs: 5,
        retryIntervalMs: 1,
        staleTimeoutMs: 1,
      })
    ).rejects.toThrow('File lock timeout');
    expect(critical).not.toHaveBeenCalled();
    resume();
    await owner;
    await withFileLock(testFile, critical);
    expect(critical).toHaveBeenCalledTimes(1);
  });

  it('old owner release cannot unlink a replacement acquisition token', async () => {
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      await barrier;
    });
    const lockPath = `${testFile}.lock`;
    const successor = `${process.pid}\n${Date.now()}\nsuccessor-token\n`;
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, successor);
    resume();
    await owner;
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(successor);
  });

  it('revalidates dead owner identity after the liveness check before reclaiming', async () => {
    const lockPath = `${testFile}.lock`;
    fs.writeFileSync(lockPath, `424242\n${Date.now()}\nold-token\n`);
    const successor = `${process.pid}\n${Date.now()}\nnew-token\n`;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 424242) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, successor);
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);
    try {
      await expect(
        withFileLock(testFile, async () => {}, { acquireTimeoutMs: 5, retryIntervalMs: 1 })
      ).rejects.toThrow('File lock timeout');
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(successor);
    } finally {
      kill.mockRestore();
    }
  });

  it('does not mistake an aged partially initialized regular lock for a dead owner', async () => {
    const lockPath = `${testFile}.lock`;
    fs.writeFileSync(lockPath, '');
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    await expect(
      withFileLock(testFile, async () => {}, {
        acquireTimeoutMs: 5,
        retryIntervalMs: 1,
        staleTimeoutMs: 1,
      })
    ).rejects.toThrow('File lock timeout');
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('sync callers also preserve an aged live owner and release only their own token', () => {
    const lockPath = `${testFile}.lock`;
    const live = `${process.pid}\n0\nlive-token\n`;
    fs.writeFileSync(lockPath, live);
    expect(() =>
      withFileLockSync(
        testFile,
        () => {
          throw new Error('must not enter');
        },
        { acquireTimeoutMs: 3, retryIntervalMs: 1, staleTimeoutMs: 1 }
      )
    ).toThrow('File lock timeout');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(live);
    fs.unlinkSync(lockPath);
    withFileLockSync(testFile, () => {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, live);
    });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(live);
  });

  it('creates parent directories for lock file', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'deep.json');

    const result = await withFileLock(nested, async () => 'created');
    expect(result).toBe('created');
    expect(fs.existsSync(`${nested}.lock`)).toBe(false);
  });

  it.skipIf(!canAssertPosixPermissions)(
    'rethrows fatal errors while creating missing lock directory',
    async () => {
      const readonlyDir = path.join(tmpDir, 'readonly');
      fs.mkdirSync(readonlyDir, 0o555);
      const nested = path.join(readonlyDir, 'missing', 'test.json');

      try {
        await expect(
          withFileLock(nested, async () => 'ok', {
            acquireTimeoutMs: 25,
            retryIntervalMs: 1,
          })
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        fs.chmodSync(readonlyDir, 0o755);
      }
    }
  );
});

// Error and compatibility cases for the publication protocol. Filesystem faults
// are injected at real operation boundaries; no fake-dead PID authorizes a live owner.
describe('file lock publication invariants', () => {
  let dir: string;
  let resource: string;
  const options = { acquireTimeoutMs: 5, retryIntervalMs: 1, staleTimeoutMs: 1 };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-unit-'));
    resource = path.join(dir, 'data');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EACCES', 'EINVAL'])('keeps unknown PID status %s exclusive', async (code) => {
    fs.writeFileSync(`${resource}.lock`, '424242\n0\nold-token\n');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    await expect(withFileLock(resource, async () => {}, options)).rejects.toThrow(
      'File lock timeout'
    );
    expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe('424242\n0\nold-token\n');
  });

  it.each(['', 'garbage\n0\n', '123oops\n0\n', '0\n0\n', '424242', '424242\n', '424242\n0'])(
    'never expires anonymous/malformed legacy bytes %j',
    (content) => {
      fs.writeFileSync(`${resource}.lock`, content);
      fs.utimesSync(`${resource}.lock`, new Date(0), new Date(0));
      expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
      expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe(content);
    }
  );

  it('keeps fresh runtime directories and nonempty old directories intact', () => {
    const lock = `${resource}.lock`;
    fs.mkdirSync(lock);
    expect(() =>
      withFileLockSync(resource, () => {}, { ...options, staleTimeoutMs: 60000 })
    ).toThrow('File lock timeout');
    fs.writeFileSync(path.join(lock, 'unknown'), 'keep');
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
    expect(fs.readFileSync(path.join(lock, 'unknown'), 'utf8')).toBe('keep');
  });

  it('supports nested different resources across async and sync APIs', async () => {
    expect(
      await withFileLock(resource, async () => {
        return withFileLockSync(path.join(dir, 'second'), () => {
          expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
          return 73;
        });
      })
    ).toBe(73);
  });

  it.each(['ENOTSUP', 'EXDEV', 'EPERM', 'EACCES', 'EIO', 'ENOSPC'])(
    'propagates hardlink %s without a canonical wx fallback',
    (code) => {
      const open = vi.spyOn(fs, 'openSync');
      vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      expect(() => withFileLockSync(resource, () => {}, options)).toThrow(code);
      expect(open.mock.calls.some(([name]) => name === `${resource}.lock`)).toBe(false);
      expect(fs.existsSync(`${resource}.lock`)).toBe(false);
      expect(fs.existsSync(`${resource}.lock-transition-v2`)).toBe(false);
    }
  );

  it.each(['EACCES', 'EPERM', 'EIO'])('propagates gate rename failure %s', (code) => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(() => withFileLockSync(resource, () => {}, options)).toThrow(code);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('fails a zero-byte write without publishing anonymous ownership', () => {
    vi.spyOn(fs, 'writeSync').mockReturnValue(0);
    expect(() => withFileLockSync(resource, () => {}, options)).toThrow('Unable to complete');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not replace data that appears immediately before hardlink publication', () => {
    const link = fs.linkSync;
    const successor = `${process.pid}\n0\nsuccessor\n`;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      fs.writeFileSync(to, successor, { flag: 'wx' });
      link(from, to);
    });
    expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
    expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe(successor);
  });

  it.each(['EPERM', 'EACCES', 'EINVAL'])(
    'keeps a complete gate with unknown PID status %s',
    (code) => {
      const gate = `${resource}.lock-transition-v2`;
      const token = '00000000-0000-4000-8000-000000000001';
      const entry = `owner-424242-${token}`;
      fs.mkdirSync(gate);
      fs.writeFileSync(path.join(gate, entry), `file-lock-transition-v2\n424242\n${token}\n`);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
      expect(fs.readdirSync(gate)).toEqual([entry]);
    }
  );

  it('does not turn lock read permissions into contention', () => {
    fs.writeFileSync(`${resource}.lock`, `${process.pid}\n0\nlive\n`);
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      name: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (name === `${resource}.lock`)
        throw Object.assign(new Error('read denied'), { code: 'EACCES' });
      return Reflect.apply(read, fs, [name, ...args]);
    }) as typeof fs.readFileSync);
    expect(() => withFileLockSync(resource, () => {}, options)).toThrow('read denied');
  });

  it('rolls back its data publication if gate cleanup fails before callback', () => {
    const unlink = fs.unlinkSync;
    let failed = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((name) => {
      if (!failed && String(name).includes(`.lock-transition-v2${path.sep}owner-`)) {
        failed = true;
        throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      }
      return unlink(name);
    });
    const callback = vi.fn();
    expect(() => withFileLockSync(resource, callback, options)).toThrow('cleanup denied');
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(`${resource}.lock`)).toBe(false);
  });
});
