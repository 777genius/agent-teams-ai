import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { openCodeV2NoToolConfig } from '../dist/adapters/providers/OpenCodeV2EmbeddedConfig.js';
import { applyLaunchConfiguration } from '../dist/composition/launchConfiguration.js';
import { selectOpenCodeV2ManagementModel } from '../dist/composition/openCodeV2ModelSelection.js';
import { preflightNativeMemberModel } from '../dist/composition/preflightNativeMemberModel.js';
import { captureOpenCodeProbeAccount, capturePreparedModelReference } from '../dist/composition/prepareTeamModelReadiness.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { compileRuntimeMemberProfile } from '../dist/composition/runtimeCaptureSource.js';
import { applyTeamModelProbeSelection } from '../dist/composition/teamModelProbeRecipe.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { storedModelProbeSchema } from '../dist/management/commandRecords.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import type { ModelProbeInput, NativeModelProbe } from '../dist/management/ModelProbeOwner.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { modelReadinessMechanismDigest } from '../dist/team-launch/launchReadiness.js';
import { opencodeV2ModelProbeProfile } from './fixtures/opencode-v2-model-probe-profile.ts';
import type { TestContext } from 'node:test';

const providerId = 'TEST-provider', nativeModelId = providerId + '/auto';

function fixture(t: TestContext, selectedConfiguration = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-model-identity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const member = runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root, nativeModelId));
  const profile = teamModelProbeProfile(member);
  if (profile.provider !== 'opencode') throw Error('TEST expected OpenCode');
  if (selectedConfiguration) {
    writeFileSync(join(root, 'opencode.json'), JSON.stringify({ provider: { [providerId]: {
      npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9/v1' },
      models: { [nativeModelId]: { name: 'TEST nested native model' },
        auto: { limit: { context: 'TEST invalid unselected model' } } },
    } } }));
    profile.embedded!.configurationSource = captureOpenCodeConfigurationSource(profile).reference;
  }
  const input = { commandId: 'TEST-probe', profileId: profile.profileId,
    configRevision: profile.configRevision, providerId, modelId: nativeModelId };
  return { root, member, profile, input };
}

test('Settings alias selects auto even when the captured native model is provider/auto', t => {
  const f = fixture(t), before = structuredClone(f.profile);
  const selected = selectOpenCodeV2ManagementModel(f.profile, { providerId, modelId: providerId + '/auto' });
  assert.deepEqual(selected.nativeModel, { providerId, modelId: 'auto' });
  assert.equal(selected.variant, undefined, 'another model cannot inherit the captured variant');
  assert.deepEqual(openCodeV2NoToolConfig(selected).selection.model,
    { providerID: providerId, id: 'auto', variant: 'default' });
  const nested = selectOpenCodeV2ManagementModel(f.profile,
    { providerId, modelId: providerId + '/' + nativeModelId });
  assert.deepEqual(nested.nativeModel, { providerId, modelId: nativeModelId });
  assert.equal(nested.variant, 'high');
  assert.deepEqual(f.profile, before, 'selection cannot mutate the captured owner');
});

test('embedded V2 public model aliases agree across Settings, Team probe and saved Launch', t => {
  const f = fixture(t), before = structuredClone(f.member);
  for (const [alias, expectedModel] of [
    [providerId + '/auto', 'auto'],
    [providerId + '/' + nativeModelId, nativeModelId],
  ] as const) {
    const management = selectOpenCodeV2ManagementModel(f.profile, { providerId, modelId: alias });
    const probe = applyTeamModelProbeSelection(f.member, {
      launchId: 'TEST-launch', rosterRevision: 'TEST-roster', memberId: f.member.memberId,
      model: alias,
    });
    const source = { commandId: 'TEST-command', configurationRevision: 'TEST-revision',
      savedSettings: { cwd: f.root, providerId: 'opencode' as const, model: alias } };
    for (const selected of [
      applyLaunchConfiguration(f.member, { model: alias }), probe,
      ...(['lead', 'member'] as const).map(role => compileRuntimeMemberProfile(f.member,
        source, { memberId: f.member.memberId, role, settings: {} }, 'opencode', 'TEST-launch')),
    ]) {
      if (selected.provider !== 'opencode') throw Error('TEST expected OpenCode');
      assert.equal(selected.nativeOptions.providerId, management.nativeModel!.providerId);
      assert.equal(selected.model, expectedModel);
      assert.equal(selected.model, management.nativeModel!.modelId,
        'one public catalog selection must not change meaning between probe and Launch');
      assert.equal(selected.nativeOptions.variant, expectedModel === nativeModelId ? 'high' : undefined);
      assert.deepEqual(selected.executable, before.executable);
      assert.deepEqual(selected.embedded, before.provider === 'opencode' ? before.embedded : undefined);
    }
  }
  assert.equal(applyLaunchConfiguration(f.member, {}).model, nativeModelId,
    'absence of a public override still preserves the captured native ID');
  assert.throws(() => applyLaunchConfiguration(f.member, { model: 'auto' }),
    { reason: 'launch-option-unsupported' }, 'bare public choices still lack provider identity');
  assert.deepEqual(f.member, before, 'public selection cannot mutate the original private capture');
});

test('saved V2 Default keeps its exact native model through private preparation and account capture', async t => {
  const f = fixture(t, true), storage = join(f.root, 'store'); mkdirSync(storage);
  const coordinator = new ProviderManagementCoordinator([f.profile], () => {}, storage);
  const before = readdirSync(f.root).sort();
  try {
    const probe = coordinator.prepareTeamProbe(f.profile)(f.input, () => true);
    assert.equal(await probe.close(), true, 'preparation never runs the native probe');
    const account = captureOpenCodeProbeAccount(f.profile, f.input, () => true);
    assert.ok(account?.isCurrent(), 'the native model selects its valid declaration, not the invalid auto row');
    assert.deepEqual(readdirSync(f.root).sort(), before, 'read-only preparation allocates no native namespace');
  } finally { await coordinator.close(); }
});

test('private V2 preparation and account capture reject a different pair instead of guessing its format', async t => {
  const f = fixture(t), storage = join(f.root, 'store'); mkdirSync(storage);
  const coordinator = new ProviderManagementCoordinator([f.profile], () => {}, storage);
  try {
    const prepare = coordinator.prepareTeamProbe(f.profile);
    for (const change of [
      { modelId: 'auto' },
      { modelId: providerId + '/' + nativeModelId },
      { providerId: 'TEST-foreign' },
    ]) {
      const input = { ...f.input, ...change };
      assert.throws(() => prepare(input, () => true), { code: 'conflict' });
      assert.throws(() => captureOpenCodeProbeAccount(f.profile, input, () => true), { code: 'conflict' });
    }
  } finally { await coordinator.close(); }
});

test('V2 readiness proof for auto cannot qualify a captured provider/auto model', async t => {
  const f = fixture(t), storage = join(f.root, 'store'); mkdirSync(storage);
  const store = new FileManagementCommandStore(storage);
  const context = runtimeDigest('TEST-context');
  const target = { profileId: f.profile.profileId, configRevision: f.profile.configRevision,
    selectionDigest: runtimeDigest(f.profile), resourceId: runtimeDigest('TEST-resource') };
  const saved = storedModelProbeSchema.parse({ schemaVersion: 1, kind: 'model.probe',
    commandId: f.input.commandId, ...target, providerId, modelId: nativeModelId,
    fingerprint: runtimeDigest('TEST-original-probe'), resourceHeld: false,
    effort: 'high', context, phase: 'completed', ok: true, expiresAt: Date.now() + 10_000,
    readinessScope: { schemaVersion: 1, kind: 'native',
      teamBindingDigest: runtimeDigest('TEST-team'), actionDigest: runtimeDigest('TEST-action'),
      selectionDigest: runtimeDigest('TEST-selection'), sourceRevision: 'TEST-source', rosterRevision: 'TEST-roster',
      mechanismDigest: modelReadinessMechanismDigest(f.profile), workspace: f.root,
      cutoff: Date.now() + 10_000, destinationKeys: ['TEST-member'] } });
  store.write(saved);
  const probes = new ModelProbeOwner({ store, fence: new ManagementResourceFence(store.list()),
    assertWriter() {}, select: () => target,
    prepare() { throw Error('TEST readiness observation cannot run another probe'); } });
  const capture = () => capturePreparedModelReference({ management: { probes, readinessTarget: () => target },
    profile: f.member, commandId: f.input.commandId, context, kind: 'native', isCurrent: () => true });
  try {
    assert.equal(capture().commandId, f.input.commandId);
    store.write({ ...saved, modelId: 'auto' });
    assert.throws(capture, { code: 'held' }, 'a prefix collision cannot substitute another model proof');
  } finally { await probes.close(); }
});

for (const available of [true, false])
test(`native-member V2 preflight ${available ? 'uses its captured private preparation' : 'refuses missing private preparation'}`, async t => {
  const f = fixture(t, true), storage = join(f.root, 'store'); mkdirSync(storage);
  if (f.member.provider !== 'opencode') throw Error('TEST expected OpenCode');
  f.member.embedded!.configurationSource = f.profile.embedded!.configurationSource!;
  const coordinator = new ProviderManagementCoordinator([], () => {}, storage);
  const management = available ? coordinator : {
    probes: coordinator.probes,
    admitTeamProbeProfile: coordinator.admitTeamProbeProfile.bind(coordinator),
    readinessTarget: coordinator.readinessTarget.bind(coordinator),
  };
  const before = readdirSync(f.root).sort();
  let probe: NativeModelProbe | undefined;
  const stop = new Error('TEST stop before durable admission or native execution');
  const start = t.mock.method(coordinator.probes, 'startPrepared',
    (...[raw, current, _prepared, _scope, prepare]: Parameters<ModelProbeOwner['startPrepared']>) => {
      assert.ok(prepare, 'the native-member entry must supply its captured private preparation');
      const input = raw as ModelProbeInput;
      assert.equal(input.providerId, providerId);
      assert.equal(input.modelId, nativeModelId, 'the durable request remains the native pair');
      probe = prepare(input, current);
      throw stop;
    });
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
    memberId: 'TEST-lead', generation: '1' };
  const original = { inputId: 'TEST-input', deliveryId: 'TEST-delivery', messageId: 'TEST-message' };
  try {
    await assert.rejects(preflightNativeMemberModel({ management, profile: f.member,
      teamBindingDigest: runtimeDigest('TEST-team-binding'), assertCurrent() {},
      input: { commandId: 'TEST-create', expectedRosterRevision: runtimeDigest('TEST-roster'),
        member: { name: 'TEST-new-member', role: 'member', workflow: 'auto', providerId: 'opencode' } },
      source: { fingerprint: runtimeDigest('TEST-native-authority'), assertCurrent() {}, assertTeamCurrent() {},
        team: { principalId: 'TEST-lead', authorityRevision: 1, actorId: 'TEST-lead', memberName: 'lead',
          role: 'lead', source: binding, original, mode: 'do', fingerprint: runtimeDigest('TEST-team-authority'),
          cause: { ...original, binding, messageCommandId: 'TEST-message-command' } } },
    }), available ? error => error === stop : { reason: 'native-member-model-preflight' });
    assert.equal(start.mock.callCount(), available ? 1 : 0);
    if (available) {
      assert.ok(probe);
      assert.equal(await probe.close(), true);
    } else assert.equal(probe, undefined, 'the public preparation cannot replace the missing private owner');
    assert.deepEqual([...new FileManagementCommandStore(storage).list()], [], 'no probe receipt was allocated');
    assert.deepEqual(readdirSync(f.root).sort(), before, 'no native namespace was allocated');
  } finally { await probe?.close(); await coordinator.close(); }
});
