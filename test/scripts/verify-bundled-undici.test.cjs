const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPatchedUndici } = require('../../scripts/ci/verify-bundled-undici.cjs');

test('reject vulnerable Node and Electron undici, accept patched releases', () => {
  for (const value of ['6.29.0', '7.29.1', '7.30.0', '8.11.2', '8.12.1', '5.99.99', '9.0.0', '', 'unknown']) {
    assert.equal(isPatchedUndici(value), false, value);
  }
  for (const value of ['6.29.1', '7.30.1', '7.31.0', '8.12.2', '8.13.0']) {
    assert.equal(isPatchedUndici(value), true, value);
  }
  assert.equal(isPatchedUndici(undefined), false);
});
