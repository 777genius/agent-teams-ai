const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPatchedUndici, verifyRuntime } = require('../../scripts/ci/verify-bundled-undici.cjs');

test('reject vulnerable Node and Electron undici, accept patched releases', () => {
  for (const value of ['6.29.0', '7.29.1', '7.30.0', '8.11.2', '8.12.1', '5.99.99', '9.0.0', '', 'unknown']) {
    assert.equal(isPatchedUndici(value), false, value);
  }
  for (const value of ['6.29.1', '7.30.1', '7.31.0', '8.12.2', '8.13.0']) {
    assert.equal(isPatchedUndici(value), true, value);
  }
  assert.equal(isPatchedUndici(undefined), false);
});

test('verifyRuntime checks the actual Electron subprocess result', () => {
  const ciVersions = { node: '26.12.1', undici: '8.12.2' };
  const runElectron = (electronBinary, args, options) => {
    assert.equal(electronBinary, '/fixture/electron');
    assert.equal(args[0], '-e');
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    return { status: 0, stdout: JSON.stringify({ node: '24.22.0', undici: '7.29.1' }), stderr: '' };
  };
  assert.throws(
    () => verifyRuntime({ ciVersions, electronBinary: '/fixture/electron', run: runElectron }),
    /Electron Node: vulnerable or unknown built-in undici 7\.29\.1/,
  );
  assert.doesNotThrow(() => verifyRuntime({
    ciVersions,
    electronBinary: '/fixture/electron',
    run: () => ({ status: 0, stdout: JSON.stringify({ node: '24.22.1', undici: '7.30.1' }), stderr: '' }),
  }));
  assert.throws(
    () => verifyRuntime({ ciVersions: { node: '26.11.1', undici: '8.11.2' }, electronBinary: '/fixture/electron', run: runElectron }),
    /CI Node: vulnerable or unknown built-in undici 8\.11\.2/,
  );
});
