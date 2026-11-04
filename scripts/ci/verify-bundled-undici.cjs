// The Electron and Node built-in undici copies are invisible to pnpm audit.
// Keep this floor gate alongside the native packaged checks (GHSA-xjj6-f33q-929c).
const { spawnSync } = require('node:child_process');

function isPatchedUndici(version) {
  const parts = /^(6|7|8)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!parts) return false;
  const [, major, minor, patch] = parts.map(Number);
  const floors = { 6: [29, 1], 7: [30, 1], 8: [12, 2] };
  const [minMinor, minPatch] = floors[major];
  return minor > minMinor || (minor === minMinor && patch >= minPatch);
}

function assertPatched(label, versions) {
  if (!isPatchedUndici(versions.undici)) {
    throw new Error(`${label}: vulnerable or unknown built-in undici ${versions.undici ?? 'missing'} (Node ${versions.node})`);
  }
  console.log(`${label}: Node ${versions.node}, undici ${versions.undici} (patched)`);
}

function verifyRuntime({
  ciVersions = process.versions,
  electronBinary = require('electron'),
  run = spawnSync,
} = {}) {
  assertPatched('CI Node', ciVersions);

  const probe = run(electronBinary, [
    '-e',
    'process.stdout.write(JSON.stringify({ node: process.versions.node, undici: process.versions.undici }))',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
    windowsHide: true,
  });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) {
    throw new Error(`Electron undici probe failed (status ${probe.status}): ${probe.stderr}`);
  }
  let versions;
  try {
    versions = JSON.parse(probe.stdout.trim());
  } catch (error) {
    throw new Error(`Unable to read Electron's built-in undici: ${error}`);
  }
  assertPatched('Electron Node', versions);
}

if (require.main === module) verifyRuntime();

module.exports = { isPatchedUndici, verifyRuntime };
