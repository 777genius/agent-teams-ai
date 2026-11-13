import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
