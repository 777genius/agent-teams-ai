import assert from 'node:assert/strict';
import fs, { chmodSync, constants, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';

import type { StoredRuntimeSourceCommand } from '../dist/management/commandRecords.js';

const receipt: StoredRuntimeSourceCommand = { schemaVersion: 1, kind: 'runtime.source', commandId: 'TEST-prepared',
  profileId: 'TEST-profile', configRevision: 'TEST-config', providerId: 'codex', fingerprint: 'a'.repeat(64),
  selectionDigest: 'b'.repeat(64), resourceId: 'c'.repeat(64), sourceId: 'c'.repeat(64), revision: 'd'.repeat(64),
  expectedRevision: 'b'.repeat(64), resourceHeld: false, phase: 'prepared', publicationJson: '{}' };

test('Windows receipt mode bits do not impersonate POSIX permissions; original bytes/digest remain required', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-windows-mode-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const store = new FileManagementCommandStore(root);
    store.write(receipt);
    const path = join(root, 'management-commands', readdirSync(join(root, 'management-commands'))[0]!);
    chmodSync(path, 0o666); // Controlled Windows-like stat projection; no native process is launched.
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    assert.deepEqual(store.read(receipt.commandId), receipt);
    assert.deepEqual([...new FileManagementCommandStore(root).list()], [receipt]);
    store.write({ ...receipt, phase: 'verifying', resourceHeld: true });
    assert.equal(store.read(receipt.commandId)?.phase, 'verifying');
    const bytes = readFileSync(path, 'utf8');
    writeFileSync(path, bytes.replace('TEST-profile', 'TEST-foreign-profile'));
    assert.throws(() => store.read(receipt.commandId));
  } finally {
    Object.defineProperty(process, 'platform', platform);
    rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX readable-by-others management receipts remain held', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-posix-mode-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const store = new FileManagementCommandStore(root); store.write(receipt);
    const path = join(root, 'management-commands', readdirSync(join(root, 'management-commands'))[0]!);
    chmodSync(path, 0o644);
    // Exercise the POSIX policy even on the Windows controlled test runner.
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    assert.throws(() => store.read(receipt.commandId));
    assert.throws(() => [...store.list()]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows no-follow fallback still refuses a valid symlink receipt without touching its target', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-windows-symlink-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const store = new FileManagementCommandStore(root); store.write(receipt);
    const path = join(root, 'management-commands', readdirSync(join(root, 'management-commands'))[0]!);
    const bytes = readFileSync(path), target = join(root, 'TEST-original-receipt.json');
    writeFileSync(target, bytes, { mode: 0o600 });
    unlinkSync(path); symlinkSync(target, path, 'file');
    const nativeOpen = fs.openSync;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof nativeOpen>) => {
      if (args[0] === path && typeof args[1] === 'number') args[1] &= ~(constants.O_NOFOLLOW ?? 0);
      return nativeOpen(...args);
    });
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    assert.throws(() => store.read(receipt.commandId), /held/);
    assert.throws(() => [...store.list()], /held/);
    assert.throws(() => store.write({ ...receipt, phase: 'verifying', resourceHeld: true }), /held/);
    assert.deepEqual(readFileSync(target), bytes);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['before-open', 'after-open', 'disappeared-before-open'] as const) {
  test('Windows receipt replacement is held at ' + stage + ' and closes the original FD', (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-windows-race-')));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let openedFd: number | undefined;
    try {
      const store = new FileManagementCommandStore(root); store.write(receipt);
      const path = join(root, 'management-commands', readdirSync(join(root, 'management-commands'))[0]!);
      const bytes = readFileSync(path), retained = join(root, 'TEST-retained-receipt.json');
      const nativeOpen = fs.openSync;
      let armed = true;
      const replace = () => {
        if (stage === 'disappeared-before-open') unlinkSync(path);
        else { renameSync(path, retained); writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); }
      };
      t.mock.method(fs, 'openSync', (...args: Parameters<typeof nativeOpen>) => {
        if (args[0] !== path || !armed) return nativeOpen(...args);
        armed = false;
        if (typeof args[1] === 'number') args[1] &= ~(constants.O_NOFOLLOW ?? 0);
        if (stage !== 'after-open') replace();
        const fd = nativeOpen(...args); openedFd = fd;
        if (stage === 'after-open') replace();
        return fd;
      });
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      assert.throws(() => store.read(receipt.commandId), /held/);
      assert.equal(armed, false, 'original open boundary exercised');
      const originalFd = openedFd;
      if (originalFd !== undefined) assert.throws(() => fs.fstatSync(originalFd), { code: 'EBADF' });
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', platform);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
