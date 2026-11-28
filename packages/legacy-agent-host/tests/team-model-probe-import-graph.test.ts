import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const modules = {
  probe: new URL('../dist/composition/teamLaunchModelProbe.js', import.meta.url).href,
  readiness: new URL('../dist/composition/prepareTeamModelReadiness.js', import.meta.url).href,
  profile: new URL('../dist/composition/runtimeProfile.js', import.meta.url).href,
};
const hostRoot = fileURLToPath(new URL('../', import.meta.url));

for (const first of ['probe', 'readiness', 'profile'] as const) {
  test(`model readiness initializes with ${first} imported first`, { timeout: 20_000 }, () => {
    // Each child has a fresh ESM cache. Only existing public modules are loaded,
    // so the old first-entry failure is the TDZ, never a missing new schema file.
    const script = `
import assert from 'node:assert/strict';
const modules = ${JSON.stringify(modules)};
await import(modules[${JSON.stringify(first)}]);
const probe = await import(modules.probe);
const readiness = await import(modules.readiness);
const profile = await import(modules.profile);
assert.equal(typeof probe.teamModelProbeProfile, 'function');
assert.equal(typeof probe.teamModelProbeSelectionSchema?.parse, 'function');
assert.equal(typeof readiness.localModelReadinessTransferSchema?.parse, 'function');
assert.equal(typeof profile.runtimeMemberProfileSchema?.parse, 'function');
const selection = {
  launchId: 'TEST-launch',
  rosterRevision: 'TEST-roster',
  memberId: 'TEST-member',
  model: 'TEST-model',
  effort: 'high',
  context: 'model-default',
};
assert.deepEqual(probe.teamModelProbeSelectionSchema.parse(selection), selection);
assert.equal(probe.teamModelProbeSelectionSchema.safeParse({
  ...selection, untrusted: true,
}).success, false);
const draft = {
  providerId: 'anthropic',
  target: { kind: 'member', name: 'TEST-member' },
  workspace: process.cwd(),
};
assert.deepEqual(probe.teamModelProbeSelectionSchema.parse({
  ...selection, draft,
}), { ...selection, draft });
assert.equal(probe.teamModelProbeSelectionSchema.safeParse({
  ...selection, draft: { ...draft, workspace: 'relative/TEST-workspace' },
}).success, false);
console.log('TEST readiness imports verified');
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: hostRoot,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith('TEST readiness imports verified\n'), result.stdout);
  });
}
