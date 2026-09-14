const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proper = require('proper-lockfile');
const { withFileLockSync } = require('../src/internal/fileLock');

const options = { acquireTimeoutMs: 5, retryIntervalMs: 1, staleTimeoutMs: 1 };
let dir;
let resource;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controller lock 雪 '));
  resource = path.join(dir, 'board state 雪');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('holds a complete token until callback return and releases on callback failure', () => {
  expect(() =>
    withFileLockSync(resource, () => {
      expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toMatch(/^\d+\n\d+\n[a-f0-9-]{36}\n$/);
      expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
      expect(withFileLockSync(path.join(dir, 'different'), () => 9)).toBe(9);
      throw new Error('callback failure');
    })
  ).toThrow('callback failure');
  expect(fs.existsSync(`${resource}.lock`)).toBe(false);
});

it('does not release another acquisition token', () => {
  const next = `${process.pid}\n0\nnext\n`;
  withFileLockSync(resource, () => {
    fs.unlinkSync(`${resource}.lock`);
    fs.writeFileSync(`${resource}.lock`, next);
  });
  expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe(next);
});

it.each(['EPERM', 'EACCES', 'EINVAL'])('retains an owner when PID probing reports %s', (code) => {
  fs.writeFileSync(`${resource}.lock`, '424242\n0\nowner\n');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });
  expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
});

it('keeps legacy anonymous locks unknown regardless of age', () => {
  fs.writeFileSync(`${resource}.lock`, '');
  fs.utimesSync(`${resource}.lock`, new Date(0), new Date(0));
  expect(() => withFileLockSync(resource, () => {}, options)).toThrow('File lock timeout');
  expect(fs.readFileSync(`${resource}.lock`, 'utf8')).toBe('');
});

it.each([false, true])(
  'fails closed on actual proper-lockfile ownership (swap at pending rmdir: %s)',
  (swapAtRmdir) => {
    const lock = `${resource}.lock`;
    // Keep the real runtime participant independent of the controller syscall hook.
    const nativeFs = { ...fs };
    const runtimeOptions = { realpath: false, lockfilePath: lock, fs: nativeFs };
    fs.writeFileSync(resource, '[]');
    let release = proper.lockSync(resource, runtimeOptions);
    fs.utimesSync(lock, new Date(0), new Date(0));
    let swaps = 0;
    let successorAge;
    let entered = false;
    let error;
    const rmdir = vi.spyOn(fs, 'rmdirSync').mockImplementation((name, ...args) => {
      if (name === lock && swapAtRmdir && swaps === 0) {
        // Reviewer runtime-directory-probe.cjs schedule: deschedule AFTER the
        // final identity check, release the old runtime and acquire a fresh one.
        // A second stat/mtime check merely moves this same pending-rmdir window.
        release();
        release = proper.lockSync(resource, runtimeOptions);
        swaps++;
        successorAge = Date.now() - fs.statSync(lock).mtimeMs;
      }
      return nativeFs.rmdirSync(name, ...args);
    });
    try {
      try {
        withFileLockSync(
          resource,
          () => {
            entered = true;
          },
          {
            ...options,
            staleTimeoutMs: 30_000,
          }
        );
      } catch (caught) {
        error = caught.message;
      }
      expect({ entered, error, swaps, successorAge }).toEqual({
        entered: false,
        error: `File lock timeout: ${resource}`,
        swaps: 0,
        successorAge: undefined,
      });
      expect(rmdir.mock.calls.some(([name]) => name === lock)).toBe(false);
      expect(fs.statSync(lock).isDirectory()).toBe(true);
      expect(fs.statSync(lock).mtimeMs).toBe(0);
    } finally {
      rmdir.mockRestore();
      release();
    }
    expect(withFileLockSync(resource, () => 'after runtime release', options)).toBe(
      'after runtime release'
    );
  }
);

it('surfaces unsupported hardlinks without publishing a partial lock', () => {
  vi.spyOn(fs, 'linkSync').mockImplementation(() => {
    throw Object.assign(new Error('hardlink unsupported'), { code: 'ENOTSUP' });
  });
  expect(() => withFileLockSync(resource, () => {}, options)).toThrow('hardlink unsupported');
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('uses native no-replace hardlinks and nonempty directory rename with Unicode and spaces', () => {
  const candidate = path.join(dir, 'candidate 雪');
  const canonical = path.join(dir, 'canonical 雪');
  fs.writeFileSync(candidate, 'complete');
  fs.linkSync(candidate, canonical);
  expect(() => fs.linkSync(candidate, canonical)).toThrow();
  fs.unlinkSync(candidate);
  expect(fs.readFileSync(canonical, 'utf8')).toBe('complete');
  const first = path.join(dir, 'first 雪');
  const second = path.join(dir, 'second 雪');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'owner-a'), 'a');
  fs.writeFileSync(path.join(second, 'owner-b'), 'b');
  let code;
  try {
    fs.renameSync(first, second);
  } catch (error) {
    code = error.code;
  }
  expect(['EEXIST', 'ENOTEMPTY', ...(process.platform === 'win32' ? ['EPERM'] : [])]).toContain(
    code
  );
  expect(fs.readFileSync(path.join(second, 'owner-b'), 'utf8')).toBe('b');
  fs.unlinkSync(path.join(second, 'owner-b'));
  fs.rmdirSync(second);
  fs.renameSync(first, second);
  expect(fs.readFileSync(path.join(second, 'owner-a'), 'utf8')).toBe('a');
});
