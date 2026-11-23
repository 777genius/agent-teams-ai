const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// These generated TEST programs answer only metadata; they are not installed vendor packages.
function prepareVendorMetadataFence(testRoot, userDataDir, options = {}) {
  assert.ok(options.openCode === undefined || options.openCode === true);
  const nodeBinary = fs.realpathSync(process.execPath);
  const ledger = path.join(testRoot, 'TEST-provider-metadata.ndjson');
  const codexHome = path.join(testRoot, 'TEST-codex-home');
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const cli = {};
  const metadataEnv = { ...process.env };
  for (const key of Object.keys(metadataEnv))
    if (key.toUpperCase() === 'NODE_OPTIONS' || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE')
      delete metadataEnv[key];
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const [provider, version] of [
    ['codex', 'codex-cli 0.164.0'], ['claude', '2.1.0 (Claude Code)'],
    // Recognized V1 metadata keeps both status and bridge discovery on this
    // TEST peer. Unsupported version text would permit ambient discovery.
    ...(options.openCode ? [['opencode', '1.16.0']] : []),
  ]) {
    const script = path.join(testRoot, 'TEST-' + provider + '-metadata.cjs');
    const wrapper = process.platform === 'win32' ? script.replace(/\.cjs$/u, '.cmd') : script;
    const header = process.platform === 'win32' ? ''
      : '#!/bin/sh\n\':\' //; exec ' + quote(nodeBinary) + ' "$0" "$@"\n';
    fs.writeFileSync(script, header + "'use strict';\n" +
      "const fs = require('node:fs');\n" +
      'const args = process.argv.slice(2);\n' +
      "const accepted = args.length === 1 && args[0] === '--version';\n" +
      'fs.appendFileSync(' + JSON.stringify(ledger) + ', JSON.stringify({ provider: ' +
        JSON.stringify(provider) + ", kind: accepted ? 'version' : 'refused', args }) + '\\n');\n" +
      'if (accepted) { process.stdout.write(' + JSON.stringify(version + '\n') + ', () => process.exit(0)); }\n' +
      'else { process.stderr.write(' + JSON.stringify('TEST ' + provider + ' refuses non-version commands\n') +
        ', () => process.exit(77)); }\n', { flag: 'wx', mode: 0o700 });
    if (process.platform === 'win32')
      fs.writeFileSync(wrapper, '@echo off\r\n"' + nodeBinary + '" "' + script + '" %*\r\n', { flag: 'wx' });
    for (const [args, status, stdout] of [
      [['--version'], 0, version + '\n'], [['TEST-forbidden-native-command'], 77, ''],
    ]) {
      const observed = spawnSync(nodeBinary, [script, ...args], {
        cwd: testRoot, env: metadataEnv, encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      assert.equal(observed.error, undefined); assert.equal(observed.signal, null);
      assert.equal(observed.status, status); assert.equal(observed.stdout, stdout);
    }
    cli[provider] = wrapper;
  }
  // Codex installer status ignores CODEX_CLI_PATH. Its original first branch must
  // select this private TEST seed before it can consider the inherited PATH.
  const manifest = path.join(userDataDir, 'data', 'runtimes', 'codex', 'current.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1, rootVersion: '0.164.0', platformVersion: '0.164.0',
    platformTarget: 'TEST-' + process.platform + '-' + process.arch,
    binaryPath: cli.codex, integrity: 'TEST-finite-metadata-only',
    installedAt: new Date().toISOString(),
  }), { flag: 'wx', mode: 0o600 });
  return { CODEX_CLI_PATH: cli.codex, CLAUDE_CLI_PATH: cli.claude, CODEX_HOME: codexHome,
    ...(options.openCode ? {
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: cli.opencode, OPENCODE_BIN_PATH: cli.opencode,
    } : {}),
  };
}

module.exports = { prepareVendorMetadataFence };
