import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { deriveSecretFingerprint, SecretFingerprintError } from '../dist/management/secretFingerprint.js';
import type { SecretFingerprint } from '../dist/management/secretFingerprint.js';

test('canonical getters cannot admit a tenth fingerprint derivation', {
  concurrency: false, timeout: 5000,
}, async (t) => {
  const callbacks: Parameters<typeof crypto.scrypt>[4][] = [];
  const work: Promise<SecretFingerprint>[] = [];
  let started = 0;
  t.mock.method(crypto, 'scrypt', (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
    assert.ok(Buffer.isBuffer(input));
    assert.ok(Buffer.isBuffer(salt));
    assert.equal(length, 32);
    assert.deepEqual(options, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    started++;
    callbacks.push(callback);
  });
  syncBuiltinESMExports();
  const track = (promise: Promise<SecretFingerprint>) => {
    work.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  const finish = () => {
    const callback = callbacks.shift();
    assert.ok(callback, 'TEST expected an actual pending crypto callback');
    callback(null, Buffer.alloc(32, 0x61));
  };
  t.after(async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      let drained = 0;
      while (callbacks.length) {
        assert.ok(++drained <= 12, 'TEST callback cleanup must remain bounded');
        finish();
      }
      await Promise.race([
        Promise.allSettled(work),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('TEST fingerprint cleanup did not settle')), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  const inner: Promise<SecretFingerprint>[] = [];
  let getterCalls = 0;
  const outer = track(deriveSecretFingerprint({
    get apiKey() {
      getterCalls++;
      for (let index = 0; index < 9; index++)
        inner.push(track(deriveSecretFingerprint('TEST inner derivation ' + index)));
      return 'TEST outer key';
    },
  }));
  assert.equal(getterCalls, 1);
  assert.equal(inner.length, 9);
  assert.equal(started, 1);
  // Drain only the nine admitted operations before inspecting the outer result:
  // the old implementation starts a tenth operation here instead of refusing it.
  for (let index = 0; index < 9; index++) finish();
  assert.equal(started, 9, 'canonicalization must not admit an extra crypto operation');
  assert.equal(callbacks.length, 0);
  await assert.rejects(outer, (error: unknown) =>
    error instanceof SecretFingerprintError && error.code === 'busy');
  await Promise.all(inner);

  const recovered = track(deriveSecretFingerprint('TEST after the original callbacks'));
  assert.equal(started, 10);
  assert.equal(callbacks.length, 1);
  finish();
  await recovered;
  assert.equal(callbacks.length, 0);
});
