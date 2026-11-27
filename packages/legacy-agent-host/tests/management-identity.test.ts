import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { managementDigest, managementValuesEqual } from '../dist/management/identity.js';

test('private management equality retains canonical JSON semantics without losing exact credential or array choices', () => {
  const captured = { z: [undefined, { key: 'TEST-original-key', omitted: undefined }], a: { gamma: 3, alpha: false } };
  const reordered = { a: { alpha: false, gamma: 3 }, z: [null, { key: 'TEST-original-key' }] };
  assert.equal(managementValuesEqual(captured, reordered), true);
  assert.equal(managementValuesEqual(captured, { ...reordered, z: [null, { key: 'TEST-replaced-key' }] }), false);
  assert.equal(managementValuesEqual([1, 2], [2, 1]), false);
  assert.equal(managementValuesEqual({ key: null }, {}), false);
  assert.equal(managementValuesEqual('TEST-key', { key: 'TEST-key' }), false);
  assert.equal(managementValuesEqual({ key: '' }, { key: undefined }), false);
});

test('existing durable management fingerprints remain byte-for-byte compatible', () => {
  const original = { z: [undefined, { key: 'TEST-original-key', omitted: undefined }], a: { gamma: 3, alpha: false } };
  const persistedCanonical = '{"a":{"alpha":false,"gamma":3},"z":[null,{"key":"TEST-original-key"}]}';
  assert.equal(managementDigest(original), createHash('sha256').update(persistedCanonical).digest('hex'));
  assert.equal(managementDigest(original), managementDigest(JSON.parse(persistedCanonical)));
});

test('private comparisons do not newly admit unsupported root values as matching identities', () => {
  for (const unsupported of [undefined, () => undefined, Symbol('TEST-unsupported')]) {
    assert.throws(() => managementDigest(unsupported), TypeError);
    assert.throws(() => managementValuesEqual(unsupported, unsupported), TypeError);
    assert.throws(() => managementValuesEqual({}, unsupported), TypeError);
  }
});
