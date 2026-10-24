import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installerEnvironment, installerSyswow64 } from './windows-installer-ps5-diagnostic.mts';
import type { InstallerLineage } from './windows-installer-ps5-diagnostic.mts';

void test('control environment keeps only explicit parent OS values and never mutates NSIS environment', () => {
  const env = {
    SystemRoot: 'C:\\Windows',
    PSModulePath: 'C:\\TEST\\legacy',
    Gh_ToKeN: 'TEST-secret',
    OPENAI_API_KEY: 'TEST-secret',
    PS7_INHERITED_UNKNOWN: 'TEST-foreign',
  };
  const original = { ...env };
  assert.deepEqual(installerEnvironment(env), {
    SystemRoot: 'C:\\Windows',
    PSModulePath: 'C:\\TEST\\legacy',
  });
  assert.deepEqual(env, original);
  assert.deepEqual(installerEnvironment({ SystemRoot: 'C:\\Windows' }), {
    SystemRoot: 'C:\\Windows',
  });
  assert.throws(() => installerEnvironment({ PATH: 'C:\\TEST', Path: 'C:\\OTHER' }), /Ambiguous/);
});
const root = {
  pid: 5888,
  parent: 7536,
  executable: 'C:\\TEST-updater-windows-diagnostic\\prior.Setup.exe',
  start: '2026-10-07T19:49:39.9001640Z',
  sid: 'TEST-SID',
  session: 2,
};
const child = {
  pid: 5936,
  parent: 5888,
  executable: 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
  start: '2026-10-07T19:49:42.8972710Z',
  sid: 'TEST-SID',
  session: 2,
  command: 'TEST observed Get-Process command',
};
const lineage: InstallerLineage = { root, descendants: [{ identity: child, depth: 1 }] };
void test('matching control selects only one directly observed SysWOW64 PS5 descendant', () => {
  assert.deepEqual(installerSyswow64(lineage, 'C:\\Windows'), child);
  assert.equal(installerSyswow64({ root, descendants: [] }, 'C:\\Windows'), undefined);
  assert.equal(
    installerSyswow64(
      { root, descendants: [...lineage.descendants, ...lineage.descendants] },
      'C:\\Windows'
    ),
    undefined
  );
});
for (const [name, changed] of Object.entries({
  parent: { parent: 1 },
  sid: { sid: 'FOREIGN' },
  session: { session: 3 },
  image: { executable: 'C:\\TEST\\powershell.exe' },
  architecture: { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
  oldBirth: { start: '2020-01-01T00:00:00Z' },
  unknownBirth: { start: 'unknown' },
  invalidPid: { pid: 0 },
}))
  void test(`control excludes ${name} without adopting or signalling that process`, () => {
    assert.equal(
      installerSyswow64(
        { root, descendants: [{ identity: { ...child, ...changed }, depth: 1 }] },
        'C:\\Windows'
      ),
      undefined
    );
  });
void test('deeper descendants and unreadable identities do not authorize control observations', () => {
  assert.equal(
    installerSyswow64(
      { root, descendants: [{ identity: child, depth: 2 }, { depth: 1 }] },
      'C:\\Windows'
    ),
    undefined
  );
});
