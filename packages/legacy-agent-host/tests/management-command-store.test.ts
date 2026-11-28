import assert from 'node:assert/strict';
import fs, { chmodSync, constants, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { managementDigest } from '../dist/management/identity.js';
import { advanceOpenCodeV2Credential, openCodeV2CredentialProgressSchema } from '../dist/management/openCodeV2CredentialRecord.js';

import type { StoredManagementCommand, StoredRuntimeSourceCommand } from '../dist/management/commandRecords.js';

const receipt: StoredRuntimeSourceCommand = { schemaVersion: 1, kind: 'runtime.source', commandId: 'TEST-prepared',
  profileId: 'TEST-profile', configRevision: 'TEST-config', providerId: 'codex', fingerprint: 'a'.repeat(64),
  selectionDigest: 'b'.repeat(64), resourceId: 'c'.repeat(64), sourceId: 'c'.repeat(64), revision: 'd'.repeat(64),
  expectedRevision: 'b'.repeat(64), resourceHeld: false, phase: 'prepared', publicationJson: '{}' };

const identity = { schemaVersion: 1 as const, commandId: 'TEST-kind-routing', profileId: 'TEST-profile',
  configRevision: 'TEST-config', providerId: 'codex', fingerprint: 'a'.repeat(64),
  selectionDigest: 'b'.repeat(64), resourceId: 'c'.repeat(64), resourceHeld: true };
const authProgress = { phase: 'key-intent' as const, integrationId: 'TEST-original-integration',
  nativeNamespace: 'd'.repeat(64), beforeAuthDigest: 'e'.repeat(64) };
const authWitnessKdf = { version: 1 as const, salt: 'a'.repeat(32) };
const commandCases: { valid: StoredManagementCommand; invalid: Record<string, unknown>[] }[] = [
  { valid: { ...identity, kind: 'skill.mutation', phase: 'claimed', targetId: 'd'.repeat(64),
      intentDigest: 'e'.repeat(64), action: 'upsert', scope: 'user', rootKind: 'codex' },
    invalid: [{ resourceHeld: false }, { phase: 'completed' }, { trash: { path: '/TEST-trash',
      dev: 1, ino: 2, parentDev: 1, parentIno: 3, token: 'f'.repeat(64) } }] },
  ...(['credential.set', 'credential.forget', 'credential.refresh'] as const).map(kind => ({
    valid: { ...identity, kind, phase: 'claimed' as const },
    invalid: [{ resourceHeld: false }, { phase: 'completed' }, { finishedAtMs: 1 },
      { terminalRejection: true }, { refreshCompletedAtMs: 2 },
      ...(kind !== 'credential.set' ? [{ fingerprintKdf: { version: 1, salt: 'a'.repeat(32) } }] : [])],
  })),
  { valid: { ...identity, kind: 'credential.set', phase: 'claimed',
      fingerprintKdf: { version: 1, salt: 'a'.repeat(32) } },
    invalid: [{ fingerprintKdf: { version: 2, salt: 'a'.repeat(32) } },
      { fingerprintKdf: { version: 1, salt: 'A'.repeat(32) } },
      { fingerprintKdf: { version: 1, salt: 'a'.repeat(31) } },
      { fingerprintKdf: { version: 1, salt: 'a'.repeat(32), N: 2 } },
      { fingerprintKdf: { salt: 'a'.repeat(32) } }, { fingerprintKdf: null }] },
  { valid: { ...identity, kind: 'credential.set', phase: 'claimed', openCodeV2: authProgress },
    invalid: [{ openCodeV2: { ...authProgress, phase: 'key-published' } }] },
  { valid: { ...identity, kind: 'credential.set', phase: 'claimed',
      openCodeV2: { ...authProgress, authWitnessKdf } },
    invalid: [null, { version: 2, salt: 'a'.repeat(32) }, { version: 1, salt: 'A'.repeat(32) },
      { version: 1, salt: 'a'.repeat(31) }, { version: 1, salt: 'a'.repeat(32), N: 2 },
      { salt: 'a'.repeat(32) }].map(authWitnessKdf => ({ openCodeV2: { ...authProgress, authWitnessKdf } })) },
  { valid: { ...identity, kind: 'oauth', phase: 'authorizing', methodIndex: 0,
      completionMethod: 'auto', sequence: 1, expiresAt: 1000 },
    invalid: [{ resourceHeld: false }, { phase: 'completed' }, { phase: 'failed', resourceHeld: false },
      { completionCommandId: 'TEST-completion' }, { reason: 'native-rejected' }] },
  { valid: { ...identity, kind: 'oauth', phase: 'authorizing', methodIndex: 0,
      completionMethod: null, sequence: 1, expiresAt: 1000,
      fingerprintKdf: { version: 1, salt: 'a'.repeat(32) } },
    invalid: [{ fingerprintKdf: { version: 2, salt: 'a'.repeat(32) } },
      { fingerprintKdf: { version: 1, salt: 'A'.repeat(32) } },
      { fingerprintKdf: { version: 1, salt: 'a'.repeat(31) } },
      { fingerprintKdf: { version: 1, salt: 'a'.repeat(32), N: 2 } },
      { fingerprintKdf: { salt: 'a'.repeat(32) } }, { fingerprintKdf: null }] },
  { valid: { ...identity, kind: 'oauth', phase: 'completing', methodIndex: 0,
      completionMethod: 'code', sequence: 2, expiresAt: 1000,
      fingerprintKdf: { version: 1, salt: 'a'.repeat(32) },
      completionCommandId: 'TEST-separate-completion', completionFingerprint: 'e'.repeat(64),
      completionFingerprintKdf: { version: 1, salt: 'b'.repeat(32) } },
    invalid: [{ fingerprintKdf: { version: 2, salt: 'a'.repeat(32) } },
      { completionFingerprintKdf: { version: 2, salt: 'b'.repeat(32) } }] },
  { valid: { ...identity, kind: 'oauth', phase: 'completing', methodIndex: 0,
      completionMethod: 'code', sequence: 2, expiresAt: 1000,
      completionCommandId: 'TEST-completion', completionFingerprint: 'd'.repeat(64),
      completionFingerprintKdf: { version: 1, salt: 'a'.repeat(32) } },
    invalid: [{ completionFingerprintKdf: { version: 2, salt: 'a'.repeat(32) } },
      { completionFingerprintKdf: { version: 1, salt: 'A'.repeat(32) } },
      { completionFingerprintKdf: { version: 1, salt: 'a'.repeat(32), N: 2 } },
      { completionMethod: 'auto' }, { completionMethod: null },
      { completionCommandId: undefined, completionFingerprint: undefined }] },
  { valid: { ...identity, kind: 'model.probe', phase: 'running', modelId: 'TEST-model',
      expiresAt: 1000, ok: false },
    invalid: [{ resourceHeld: false }, { phase: 'completed' }, { ok: true },
      { purpose: 'native-local-readiness-v1' }, { phase: 'cancelled' }] },
  { valid: { ...identity, kind: 'extension.mutation', phase: 'claimed', action: 'mcp.install',
      scope: 'user', targetId: 'd'.repeat(64), intentDigest: 'e'.repeat(64) },
    invalid: [{ resourceHeld: false }, { phase: 'completed', resourceHeld: false },
      { phase: 'failed', resourceHeld: false }, { finishedAtMs: 1 }] },
  { valid: receipt, invalid: [{ resourceHeld: true }, { phase: 'verifying' }, { phase: 'verified' },
      { reason: 'source-changed' }] },
];

test('fresh OpenCode progress requires a protected witness while legacy originals remain readable', () => {
  assert.deepEqual(openCodeV2CredentialProgressSchema.parse(authProgress), authProgress);
  assert.equal(advanceOpenCodeV2Credential(undefined, authProgress), undefined);
  const legacyNext = { ...authProgress, phase: 'key-connected' as const, credentialId: 'cred_TEST' };
  assert.equal(advanceOpenCodeV2Credential(authProgress, legacyNext), undefined, 'legacy is read-only');
  assert.equal(advanceOpenCodeV2Credential(authProgress, { ...legacyNext, authWitnessKdf }), undefined,
    'an original legacy operation cannot acquire a new witness during progress');
});

test('OpenCode progress keeps one original descriptor and immutable before and after witnesses', () => {
  const intent = { ...authProgress, authWitnessKdf };
  assert.deepEqual(advanceOpenCodeV2Credential(undefined, intent), intent);
  const connected = { ...intent, phase: 'key-connected' as const, credentialId: 'cred_TEST' };
  assert.deepEqual(advanceOpenCodeV2Credential(intent, connected), connected);
  assert.equal(advanceOpenCodeV2Credential(intent, { ...connected,
    authWitnessKdf: { ...authWitnessKdf, salt: 'b'.repeat(32) } }), undefined);
  assert.equal(advanceOpenCodeV2Credential(intent, { ...authProgress,
    phase: 'key-connected', credentialId: 'cred_TEST' }), undefined, 'descriptor cannot disappear');
  assert.equal(advanceOpenCodeV2Credential(intent, { ...connected, beforeAuthDigest: 'f'.repeat(64) }), undefined);
  const published = { ...connected, phase: 'key-published' as const, authDigest: '1'.repeat(64) };
  assert.deepEqual(advanceOpenCodeV2Credential(connected, published), published);
  const probe = { ...published, phase: 'probe-intent' as const,
    verification: { commandId: 'TEST-original-verification', modelId: 'TEST-provider/TEST-model' } };
  assert.deepEqual(advanceOpenCodeV2Credential(published, probe), probe);
  assert.equal(advanceOpenCodeV2Credential(published, { ...probe, authDigest: '2'.repeat(64) }), undefined);
});

for (const { valid, invalid } of commandCases) {
  test('management journal preserves closed fields and state refinements for ' + valid.kind, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-kind-')));
    try {
      const store = new FileManagementCommandStore(root);
      store.write(valid);
      assert.deepEqual(store.read(valid.commandId), valid);
      assert.deepEqual([...new FileManagementCommandStore(root, true).list()], [valid]);
      const path = join(root, 'management-commands', managementDigest(valid.commandId) + '.json');
      const original = readFileSync(path);
      for (const patch of [{ unrecognized: true }, { fingerprint: 'TEST-invalid' }, ...invalid]) {
        const body = { ...valid, ...patch };
        assert.throws(() => store.write(body as StoredManagementCommand), JSON.stringify(patch));
        assert.deepEqual(readFileSync(path), original, 'invalid writes preserve the original receipt');
        // A matching digest cannot make a malformed state or cross-kind field authoritative.
        writeFileSync(path, JSON.stringify({ ...body, digest: managementDigest(body) }));
        assert.throws(() => store.read(valid.commandId), { code: 'held' });
        assert.throws(() => [...store.list()], { code: 'held' });
        writeFileSync(path, original);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('management journal refuses absent, unknown, inherited-name and cross-kind discriminators', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-unknown-kind-')));
  try {
    const store = new FileManagementCommandStore(root);
    store.write(receipt);
    const path = join(root, 'management-commands', managementDigest(receipt.commandId) + '.json');
    const { kind: _kind, ...withoutKind } = receipt;
    for (const body of [withoutKind, ...[null, 0, {}, 'TEST-unknown', '__proto__', 'constructor',
      'toString', 'credential.set'].map(kind => ({ ...receipt, kind }))]) {
      writeFileSync(path, JSON.stringify({ ...body, digest: managementDigest(body) }));
      assert.throws(() => store.read(receipt.commandId), { code: 'held' });
      assert.throws(() => [...store.list()], { code: 'held' });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
