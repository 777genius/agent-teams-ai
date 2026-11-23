const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareVendorMetadataFence } = require('../lib/finite-provider-metadata.cjs');

/** Isolate incidental Codex status without replacing the Windows product runtime. */
function prepareWindowsProductProviderMetadata(root, userDataDir) {
  assert(path.isAbsolute(root) && /^TEST-/.test(path.basename(root)));
  assert.equal(fs.realpathSync(root), root);
  assert.equal(userDataDir, path.join(root, 'user-data'));
  assert.equal(fs.realpathSync(userDataDir), userDataDir);
  const { CODEX_CLI_PATH, CODEX_HOME } = prepareVendorMetadataFence(root, userDataDir);
  const ledger = path.join(root, 'TEST-provider-metadata.ndjson');
  const calibration = fs.readFileSync(ledger, 'utf8');
  assert.deepEqual(calibration.trim().split('\n').map(line => JSON.parse(line)),
    ['codex', 'claude'].flatMap(provider => [
      { provider, kind: 'version', args: ['--version'] },
      { provider, kind: 'refused', args: ['TEST-forbidden-native-command'] },
    ]));
  const digest = file => {
    const metadata = fs.lstatSync(file);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size > 0 && metadata.size <= 64 * 1024);
    assert.equal(fs.realpathSync(file), file);
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  };
  const pinned = [...new Set([
    CODEX_CLI_PATH, path.join(root, 'TEST-codex-metadata.cjs'),
    path.join(userDataDir, 'data', 'runtimes', 'codex', 'current.json'),
  ])].map(file => ({ file, sha256: digest(file) }));
  return {
    // Claude remains the original explicitly selected project orchestrator.
    // The shared native/genuine acquisition environment is not changed.
    environment: Object.freeze({ CODEX_CLI_PATH, CODEX_HOME }),
    observe() {
      for (const pin of pinned) assert.equal(digest(pin.file), pin.sha256);
      const metadata = fs.lstatSync(ledger);
      assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
      assert(metadata.size <= 64 * 1024);
      const bytes = fs.readFileSync(ledger, 'utf8');
      assert(bytes.startsWith(calibration) && bytes.endsWith('\n'));
      const observed = bytes.slice(calibration.length).split('\n').filter(Boolean)
        .map(line => JSON.parse(line));
      assert(observed.length > 0, 'Original startup must observe the private Codex metadata peer');
      for (const row of observed)
        assert.deepEqual(row, { provider: 'codex', kind: 'version', args: ['--version'] },
          'Incidental provider status must not run a non-version command');
      return { source: 'TEST-finite-codex-metadata', codexVersionCalls: observed.length,
        nonVersionCalls: 0, managedSeedAndPeerUnchanged: true };
    },
  };
}

module.exports = { prepareWindowsProductProviderMetadata };
