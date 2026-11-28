import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { canonicalManagementValue, managementDigest } from '../dist/management/identity.js';
import { deriveSecretFingerprint, secretFingerprintKdfSchema, secretFingerprintsEqual } from '../dist/management/secretFingerprint.js';

function controlledCrypto(t: TestContext) {
  const calls: { input: Buffer; salt: Buffer; finish(error?: Error): void }[] = [];
  t.mock.method(crypto, 'scrypt', (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
    assert.ok(Buffer.isBuffer(input) && Buffer.isBuffer(salt));
    assert.equal(length, 32);
    assert.deepEqual(options, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    calls.push({ input, salt, finish(error) { callback(error ?? null, Buffer.alloc(32, 1)); } });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('version 1 derives the canonical command with real scrypt and a fresh salt, including a one-character key', async () => {
  const value = { key: 'x', metadata: { z: 'TEST-value', a: 'TEST-first' } };
  const first = await deriveSecretFingerprint(value);
  assert.equal(first.fingerprintKdf.version, 1);
  assert.match(first.fingerprintKdf.salt, /^[a-f0-9]{32}$/);
  const expected = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(canonicalManagementValue(value), Buffer.from(first.fingerprintKdf.salt, 'hex'), 32,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result));
  });
  assert.equal(first.fingerprint, expected.toString('hex'));
  assert.notEqual(first.fingerprint, managementDigest(value));
  const reordered = { metadata: { a: 'TEST-first', z: 'TEST-value' }, key: 'x' };
  assert.deepEqual(await deriveSecretFingerprint(reordered, first.fingerprintKdf), first);
  assert.equal(secretFingerprintsEqual(first.fingerprint,
    (await deriveSecretFingerprint({ ...value, key: 'y' }, first.fingerprintKdf)).fingerprint), false);
  assert.notEqual((await deriveSecretFingerprint(value)).fingerprintKdf.salt, first.fingerprintKdf.salt);
  assert.equal(secretFingerprintsEqual(first.fingerprint, first.fingerprint), true);
});

test('descriptors and digest comparisons reject unknown versions, extra work factors and malformed hex', async () => {
  for (const value of [null, { version: 2, salt: 'a'.repeat(32) },
    { version: 1, salt: 'a'.repeat(32), N: 2 }, { version: 1, salt: 'A'.repeat(32) },
    { version: 1, salt: 'a'.repeat(31) }]) assert.equal(secretFingerprintKdfSchema.safeParse(value).success, false);
  for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)])
    assert.throws(() => secretFingerprintsEqual(value, 'a'.repeat(64)), { code: 'invalid' });
  await assert.rejects(deriveSecretFingerprint(undefined), { code: 'invalid' });
});

test('one active callback and eight waiting inputs retain their permits until actual completion', async t => {
  const calls = controlledCrypto(t);
  const promises = Array.from({ length: 9 }, (_, index) => deriveSecretFingerprint({ key: 'TEST-' + index }));
  assert.equal(calls.length, 1);
  await assert.rejects(deriveSecretFingerprint({ key: 'TEST-over-capacity' }), { code: 'busy' });
  // Merely ignoring/abandoning a pending caller cannot start another native derivation.
  await Promise.resolve();
  assert.equal(calls.length, 1);
  for (let index = 0; index < promises.length; index++) {
    const call = calls[index]!;
    assert.ok(call.input.some(byte => byte !== 0));
    call.finish();
    assert.ok(call.input.every(byte => byte === 0));
    assert.ok(call.salt.every(byte => byte === 0));
    assert.equal(calls.length, Math.min(index + 2, promises.length));
  }
  await Promise.all(promises);
  const next = deriveSecretFingerprint({ key: 'TEST-after-settlement' });
  calls.at(-1)!.finish();
  await next;
});

test('byte bounds include the active input and queued inputs; failure wipes bytes and allows later work', async t => {
  const calls = controlledCrypto(t);
  const first = deriveSecretFingerprint('x'.repeat(4 * 1024 * 1024 - 2));
  const second = deriveSecretFingerprint('y'.repeat(4 * 1024 * 1024 - 2));
  await assert.rejects(deriveSecretFingerprint('z'), { code: 'busy' });
  const failed = assert.rejects(first, { code: 'failed' });
  calls[0]!.finish(new Error('TEST native crypto unavailable'));
  await failed;
  assert.ok(calls[0]!.input.every(byte => byte === 0));
  const replacement = deriveSecretFingerprint('z'.repeat(4 * 1024 * 1024 - 2));
  await assert.rejects(deriveSecretFingerprint('w'), { code: 'busy' });
  calls[1]!.finish();
  calls[2]!.finish();
  await Promise.all([second, replacement]);
  const next = deriveSecretFingerprint('TEST released memory');
  calls[3]!.finish();
  await next;
});
