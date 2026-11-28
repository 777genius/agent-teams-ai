import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { captureTeamAccountRead } from '../dist/composition/captureTeamAccountRead.js';
import { attachMemberModelReadiness, capturePreparedModelReference, inspectMemberModelReadiness } from '../dist/composition/prepareTeamModelReadiness.js';
import { captureRuntimeControlAuthority } from '../dist/composition/runtimeControlAuthority.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { storedModelProbeSchema } from '../dist/management/commandRecords.js';
import type { StoredModelProbe } from '../dist/management/commandRecords.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { modelReadinessMechanismDigest } from '../dist/team-launch/launchReadiness.js';
import { fixture } from './native-member-actions-fixture.ts';

async function prepared(t: TestContext) {
  const f = await fixture(t, false), entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const previous = entry.profile;
  entry.profile = runtimeMemberProfileSchema.parse({
    provider: 'opencode', protocolRevision: '1.19.4', teamId: previous.teamId,
    memberId: previous.memberId, principalId: previous.principalId, sessionId: previous.sessionId,
    generation: previous.generation, configRevision: previous.configRevision,
    accountBinding: previous.accountBinding, model: 'TEST-model', cwd: f.root,
    executable: previous.executable, endpoint: 'http://127.0.0.1:9',
    environment: { HOME: f.root, XDG_CONFIG_HOME: f.root, XDG_DATA_HOME: f.root, XDG_CACHE_HOME: f.root },
    nativeOptions: { providerId: 'TEST-provider', agent: 'build' }, limits: previous.limits,
  });
  entry.baseProfile = structuredClone(entry.profile);
  const profile = teamModelProbeProfile(entry.profile), commandId = 'TEST-one-retained-probe', context = runtimeDigest('TEST-context');
  const target = { profileId: profile.profileId, configRevision: profile.configRevision,
    selectionDigest: runtimeDigest(profile), resourceId: runtimeDigest('TEST-resource') };
  const records = new FileManagementCommandStore(f.root);
  const saved = storedModelProbeSchema.parse({ schemaVersion: 1, kind: 'model.probe', commandId,
    ...target, providerId: 'TEST-provider', fingerprint: runtimeDigest('TEST-original-probe'),
    resourceHeld: false, modelId: 'TEST-model', context, phase: 'completed', ok: true,
    expiresAt: Date.now() + 10_000, readinessScope: { schemaVersion: 1, kind: 'native',
      teamBindingDigest: runtimeDigest(entry.team.definition.binding), actionDigest: runtimeDigest('TEST-action'),
      selectionDigest: runtimeDigest('TEST-selection'), sourceRevision: 'TEST-source', rosterRevision: 'TEST-roster',
      mechanismDigest: modelReadinessMechanismDigest(profile), workspace: f.root,
      cutoff: Date.now() + 20_000, destinationKeys: ['TEST-destination'] } });
  records.write(saved);
  const probes = new ModelProbeOwner({ store: records, fence: new ManagementResourceFence(records.list()),
    assertWriter() {}, select: () => target, prepare() { throw Error('TEST readiness read cannot prepare or allocate'); } });
  let targetEffect = () => {};
  const management = { probes, readinessTarget: () => { targetEffect(); return target; } };
  const current = captureRuntimeControlAuthority({ entry, principalId: 'profile-admin',
    assertWriter() {}, isSealed: () => false });
  const withAccountRead = captureTeamAccountRead({ entry, principalId: 'profile-admin', assertCurrent: current });
  const lock = join(f.store.directory, 'authority.lock');
  const checkTokens: (string | undefined)[] = [];
  const isCurrent = () => {
    current();
    checkTokens.push(fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8').split('\n')[2] : undefined);
    return true;
  };
  const options = { management, profile: entry.profile, commandId, context, kind: 'native' as const, isCurrent, withAccountRead };
  return { ...f, entry, records, saved, probes, management, current, withAccountRead, lock, checkTokens,
    options, capture: () => capturePreparedModelReference(options),
    effect: (value: () => void) => { targetEffect = value; } };
}

test('one prepared reference reads one original receipt and keeps candidate checks under the account token', async t => {
  const f = await prepared(t);
  let reads = 0, publications = 0;
  const read = f.records.read, link = fs.linkSync;
  t.mock.method(f.records, 'read', function (this: FileManagementCommandStore, commandId: string) { reads++; return read.call(this, commandId); });
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === f.lock) publications++;
    return link(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const original = await f.capture();
  t.diagnostic(JSON.stringify({ receiptReads: reads, physicalTeamTokens: publications,
    sourceChecks: f.checkTokens.length, heldSourceChecks: f.checkTokens.filter(value => value !== undefined).length }));
  assert.equal(reads, 1, 'ModelProbeOwner supplies this invocation\'s sole fresh qualified snapshot');
  assert.equal(publications, 2, 'writer/source prelude and original account fence only');
  assert.equal(f.checkTokens.length, 3, 'candidate and both closing source checks still execute');
  assert.ok(f.checkTokens.every(value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)));
  assert.equal(new Set(f.checkTokens).size, 1, 'candidate validation never publishes an extra Team token');
  assert.equal(fs.existsSync(f.lock), false);
  const token = f.checkTokens[0];
  await Promise.resolve();
  f.checkTokens.length = 0;
  assert.deepEqual(await f.capture(), original);
  assert.equal(reads, 2, 'the next invocation reopens and validates the original receipt');
  assert.equal(publications, 4);
  assert.notEqual(f.checkTokens[0], token, 'no lock authority is retained across an await');
});

test('a later cancelled or retired original probe refuses instead of using the prior reference', async t => {
  const f = await prepared(t);
  const original = await f.capture();
  for (const changed of [
    { ...f.saved, phase: 'cancelled' as const, ok: false },
    { ...f.saved, readinessRetired: true as const },
  ]) {
    await Promise.resolve();
    f.records.write(changed);
    await assert.rejects(f.capture, { code: 'held' });
    assert.equal(fs.existsSync(f.lock), false);
  }
  f.records.write(f.saved);
  assert.deepEqual(await f.capture(), original);
});

test('single-snapshot candidate validation preserves provider, model, effort, purpose, scope and mechanism refusals', async t => {
  const f = await prepared(t);
  const changes: Partial<StoredModelProbe>[] = [
    { providerId: 'TEST-other-provider' }, { modelId: 'TEST-other-model' }, { effort: 'low' },
    { purpose: 'native-local-coordination-v1' },
    { readinessScope: { ...f.saved.readinessScope!, kind: 'team' } },
    { readinessScope: { ...f.saved.readinessScope!, mechanismDigest: runtimeDigest('TEST-other-mechanism') } },
  ];
  for (const changed of changes) {
    f.records.write({ ...f.saved, ...changed });
    await assert.rejects(f.capture, { code: 'held' });
    assert.equal(fs.existsSync(f.lock), false);
  }
  f.records.write(f.saved);
  await assert.rejects(() => capturePreparedModelReference({ ...f.options, context: runtimeDigest('TEST-other-context') }), { code: 'conflict' });
  await assert.rejects(() => capturePreparedModelReference({ ...f.options, isCurrent: () => false }), { code: 'held' });
});

test('grant revocation during the same snapshot read still refuses before its result escapes', async t => {
  const f = await prepared(t);
  f.effect(() => f.human.revoke('profile-admin'));
  await assert.rejects(f.capture, { code: 'forbidden' });
  assert.equal(fs.existsSync(f.lock), false);
});

test('a namespace change inside the same snapshot read still refuses', { skip: process.platform === 'win32' }, async t => {
  const f = await prepared(t), path = join(f.root, 'teams', f.entry.team.definition.binding.teamName, 'TEST-changed-link');
  f.effect(() => fs.symlinkSync(f.root, path, 'dir'));
  try {
    await assert.rejects(f.capture, { code: 'hold' });
    assert.equal(fs.existsSync(f.lock), false);
  } finally { fs.rmSync(path, { force: true }); }
});

test('the original expiry gates run after the existing account fence final authority', async t => {
  const f = await prepared(t);
  t.mock.timers.enable({ apis: ['Date'], now: f.saved.expiresAt - 1 });
  let checks = 0;
  const withAccountRead = captureTeamAccountRead({ entry: f.entry, principalId: 'profile-admin', assertCurrent() {
    f.current();
    if (++checks === 2) t.mock.timers.setTime(f.saved.expiresAt);
  } });
  await assert.rejects(() => capturePreparedModelReference({ ...f.options, withAccountRead }), { code: 'held' });
  assert.equal(checks, 2, 'unchanged prelude and final authority both complete before expiry refusal');
  assert.equal(fs.existsSync(f.lock), false);
  const next = { ...f.saved, expiresAt: f.saved.expiresAt + 10_000,
    readinessScope: { ...f.saved.readinessScope!, cutoff: f.saved.expiresAt } };
  f.records.write(next);
  await assert.rejects(f.capture, { code: 'held' }, 'scope cutoff independently rejects a late observation');
});

test('the original consumer refuses a changed reference even when its fresh probe remains otherwise ready', async t => {
  const f = await prepared(t), reference = (await f.capture()).reference, entry = f.entry;
  const launch = new TeamLaunchOwner({ definition: { launchId: 'TEST-snapshot-consumer', rosterRevision: 'TEST-roster',
    members: [{ memberId: entry.profile.memberId, binding: entry.binding, configurationDigest: runtimeDigest(entry.profile),
      baseConfigurationDigest: runtimeDigest(entry.baseProfile), runtimeGeneration: entry.profile.generation,
      contextDigest: runtimeDigest('TEST-input'), configRevision: entry.profile.configRevision, skipped: false, timeoutMs: 1000 }] },
    hostIncarnation: 'TEST-snapshot-host', store: new TeamOwnerStore(f.root, entry.team.definition.binding.teamName),
    authorized: (action, operation) => f.owner.withLaunchAuthority('profile-admin', action, operation),
    runtime: { read: () => ({ attached: false, nativeReady: false }),
      open: async () => { throw Error('TEST inspection cannot open a native session'); } } });
  attachMemberModelReadiness({ launch, entry, reference, commandId: 'TEST-consume-original',
    actorDigest: runtimeDigest('profile-admin'), inputDigest: runtimeDigest('TEST-input'), cutoff: f.saved.expiresAt });
  const inspection = { management: f.management, launch, entry, hostIncarnation: 'TEST-snapshot-host',
    assertCurrent: f.current, withAccountRead: f.withAccountRead };
  const captured = inspectMemberModelReadiness(inspection);
  f.records.write({ ...f.saved, fingerprint: runtimeDigest('TEST-replaced-reference') });
  assert.throws(captured.assertCurrent, { code: 'held' });
  assert.equal(fs.existsSync(f.lock), false);
});
