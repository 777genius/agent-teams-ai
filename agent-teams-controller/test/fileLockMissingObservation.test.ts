import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { withFileLockSync } = createRequire(import.meta.url)('../src/internal/fileLock.js') as {
  withFileLockSync<T>(path: string, action: () => T,
    options?: { createParent?: boolean; acquireTimeoutMs?: number; retryIntervalMs?: number }): T;
};
const options = { createParent: false, acquireTimeoutMs: 5, retryIntervalMs: 1 };
let directory: string, resource: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'TEST-controller-stat-'));
  resource = join(directory, 'TEST-authority');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it('keeps the fresh gate, data admission and release observations in their original order', () => {
  const original = fs.lstatSync, observed: string[] = [];
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
    observed.push(String(args[0]));
    return Reflect.apply(original, fs, args) as ReturnType<typeof fs.lstatSync>;
  });
  const lock = resource + '.lock', gate = lock + '-transition-v2';
  expect(withFileLockSync(resource, () => {
    expect(observed).toEqual([gate, lock, lock]);
    expect(fs.readFileSync(lock, 'utf8')).toMatch(/^\d+\n\d+\n[a-f0-9-]{36}\n$/);
    return 'TEST-owned';
  }, options)).toBe('TEST-owned');
  expect(observed).toEqual([gate, lock, lock, lock]);
  expect(fs.readdirSync(directory)).toEqual([]);
});

it('rejects a native invalid-parent path without entering or publishing a candidate', () => {
  fs.writeFileSync(resource, 'TEST regular parent');
  const action = vi.fn();
  expect(() => withFileLockSync(join(resource, 'child'), action, options)).toThrow(
    process.platform === 'win32' ? Error : expect.objectContaining({ code: 'ENOTDIR' })
  );
  expect(action).not.toHaveBeenCalled();
  expect(fs.readFileSync(resource, 'utf8')).toBe('TEST regular parent');
  expect(fs.readdirSync(directory)).toEqual(['TEST-authority']);
});

it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])('preserves the original %s observation failure', (code) => {
  const error = Object.assign(new Error('TEST original filesystem refusal'), { code });
  vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw error; });
  const action = vi.fn();
  let caught: unknown;
  try { withFileLockSync(resource, action, options); }
  catch (cause) { caught = cause; }
  expect(caught).toBe(error);
  expect(action).not.toHaveBeenCalled();
  expect(fs.readdirSync(directory)).toEqual([]);
});

it('keeps an unknown symlink lock and its target untouched', () => {
  const target = join(directory, 'TEST-target'), lock = resource + '.lock';
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, 'TEST-marker'), 'TEST target retained');
  fs.symlinkSync(target, lock, process.platform === 'win32' ? 'junction' : 'dir');
  const action = vi.fn();
  expect(() => withFileLockSync(resource, action, options)).toThrow('File lock timeout');
  expect(action).not.toHaveBeenCalled();
  expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(join(target, 'TEST-marker'), 'utf8')).toBe('TEST target retained');
  expect(fs.readdirSync(directory).sort()).toEqual(['TEST-authority.lock', 'TEST-target']);
});
