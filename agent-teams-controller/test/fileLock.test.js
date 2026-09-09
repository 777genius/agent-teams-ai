const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
