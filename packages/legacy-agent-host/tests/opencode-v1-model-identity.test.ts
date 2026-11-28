import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyLaunchConfiguration } from '../dist/composition/launchConfiguration.js';
import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { runOpenCodeModelProbe } from '../dist/adapters/providers/runOpenCodeModelProbe.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { captureTeamProbePreparation } from '../dist/composition/captureTeamProbePreparation.js';
import { captureNativeRestartReadiness, capturePreparedModelReference } from '../dist/composition/prepareTeamModelReadiness.js';
import { preflightNativeMemberModel } from '../dist/composition/preflightNativeMemberModel.js';
import { compileRuntimeMemberProfile } from '../dist/composition/runtimeCaptureSource.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { applyTeamModelProbeSelection } from '../dist/composition/teamModelProbeRecipe.js';
import { ModelProbeOwner } from '../dist/management/ModelProbeOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { storedModelProbeSchema } from '../dist/management/commandRecords.js';
import { modelReadinessMechanismDigest } from '../dist/team-launch/launchReadiness.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { opencodeV2ModelProbeProfile } from './fixtures/opencode-v2-model-probe-profile.ts';
import type { OpenCodeProbeClient } from '../dist/adapters/providers/runOpenCodeModelProbe.js';
import type { ModelProbeInput, NativeModelProbe } from '../dist/management/ModelProbeOwner.js';
import type { ProviderManagementProfile } from '../dist/management/profile.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { TestContext } from 'node:test';

const providerId = 'TEST-provider', nestedModel = providerId + '/auto';
function fixture(t: TestContext, model = nestedModel) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v1-model-identity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { embedded: _embedded, nativeGeneration: _generation, ...common } = opencodeV2ModelProbeProfile(root, model);
  const member = runtimeMemberProfileSchema.parse({ ...common, protocolRevision: '1.19.4' });
  return { root, member, before: structuredClone(member) };
}
function pair(member: RuntimeMemberProfile) {
  assert.equal(member.provider, 'opencode');
  if (member.provider !== 'opencode') throw Error('TEST expected OpenCode');
  return { providerId: member.nativeOptions.providerId, modelId: member.model };
}
function capture(f: ReturnType<typeof fixture>, role: 'lead' | 'member', model?: string) {
  return compileRuntimeMemberProfile(f.member,
    { commandId: 'TEST-command', configurationRevision: 'TEST-roster',
      savedSettings: { cwd: f.root, providerId: 'opencode', ...(model === undefined ? {} : { model }) } },
    { memberId: f.member.memberId, role, settings: {} }, 'opencode', 'TEST-launch');
}
const selection = (memberId: string, model: string) => ({
  launchId: 'TEST-launch', rosterRevision: 'TEST-roster', memberId, model,
});

test('V1 saved capture Default preserves a native provider-prefixed model for lead and inherited member', t => {
  const f = fixture(t);
  for (const role of ['lead', 'member'] as const)
    for (const model of [undefined, '__provider_default__'])
      assert.deepEqual(pair(capture(f, role, model)), { providerId, modelId: nestedModel });
  assert.deepEqual(f.member, f.before);
  assert.deepEqual(readdirSync(f.root), [], 'selection allocates no provider files');
});
test('V1 Team probe Default preserves the exact captured native pair and variant', t => {
  const f = fixture(t);
  const result = applyTeamModelProbeSelection(f.member, selection(f.member.memberId, '__provider_default__'));
  assert.deepEqual(pair(result), { providerId, modelId: nestedModel });
  if (result.provider !== 'opencode') throw Error('TEST expected OpenCode');
  assert.equal(result.nativeOptions.variant, 'high');
  assert.deepEqual(f.member, f.before);
  assert.deepEqual(readdirSync(f.root), []);
});
test('V1 explicit foreign alias that equals the prior native spelling selects that foreign pair', t => {
  const alias = 'TEST-foreign/auto', f = fixture(t, alias);
  for (const result of [
    applyLaunchConfiguration(f.member, { model: alias }),
    applyTeamModelProbeSelection(f.member, selection(f.member.memberId, alias)),
    capture(f, 'lead', alias), capture(f, 'member', alias),
  ]) {
    assert.deepEqual(pair(result), { providerId: 'TEST-foreign', modelId: 'auto' });
    if (result.provider !== 'opencode') throw Error('TEST expected OpenCode');
    assert.equal(result.nativeOptions.variant, undefined, 'another provider cannot inherit the old variant');
    assert.deepEqual(result.executable, f.before.executable);
    assert.equal(result.accountBinding, f.before.accountBinding);
  }
  assert.deepEqual(pair(applyLaunchConfiguration(f.member, {})), { providerId, modelId: alias });
  assert.deepEqual(f.member, f.before);
  assert.deepEqual(readdirSync(f.root), []);
});
test('V1 no-override and exactly qualified nested aliases remain stable without widening the existing bound', t => {
  const f = fixture(t);
  for (const choice of [{}, { model: providerId + '/' + nestedModel }])
    assert.deepEqual(pair(applyLaunchConfiguration(f.member, choice)), { providerId, modelId: nestedModel });
  assert.throws(() => applyLaunchConfiguration(f.member, { model: providerId + '/' + 'x'.repeat(256) }),
    { reason: 'launch-option-unsupported' });
  assert.deepEqual(f.member, f.before);
});

test('V1 private preparation probes the exact native model through the ordinary V1 decoder', async t => {
  const f = fixture(t), storage = join(f.root, 'store'); mkdirSync(storage);
  const sent: { providerID: string; modelID: string }[] = [];
  const client = {
    getConfig: async () => ({ permission: { '*': 'deny' } }),
    getProviders: async () => ({ all: [{ id: providerId, models: {
      auto: { variants: { high: {} } }, [nestedModel]: { variants: { high: {} } },
    } }] }),
    listExperimentalToolIds: async () => [],
    createSession: async () => ({ id: `TEST-probe-${sent.length}` }),
    sendSessionMessage: async (sessionId: string, request: { model: { providerID: string; modelID: string } }) => {
      sent.push(structuredClone(request.model));
      return { info: { sessionID: sessionId, role: 'assistant', ...request.model, time: { completed: 1 } },
        parts: [{ type: 'text', text: 'OK' }] };
    },
  } as unknown as OpenCodeProbeClient;
  t.mock.method(OpenCodeManagementHost.prototype, 'probeModel', async (
    input: Parameters<OpenCodeManagementHost['probeModel']>[0],
    _signal: AbortSignal, _timeout: number, current?: () => boolean
  ) => runOpenCodeModelProbe(client, { ...input, cwd: f.root,
    ...(current ? { isCurrent: current } : {}) }));
  const profiles = [nestedModel, 'auto'].map(model => teamModelProbeProfile({ ...f.member, model }));
  const owner = new ProviderManagementCoordinator(profiles, () => {}, storage, {
    createProcess: (_profile, current) => {
      assert.equal(current(), true);
      return { launch: () => assert.fail('TEST native process must never start'),
        seal() {}, isRunning: () => false, confirmStopped: async () => true };
    },
  });
  try {
    for (const [index, profile] of profiles.entries()) {
      const input = { profileId: profile.profileId, configRevision: profile.configRevision,
        commandId: `TEST-private-${index}`, providerId, modelId: index === 0 ? nestedModel : 'auto', effort: 'high' } satisfies ModelProbeInput;
      const original = structuredClone(input);
      const probe = owner.prepareTeamProbe(profile)(input, () => true);
      assert.equal(await probe.run(new AbortController().signal), true);
      assert.equal(await probe.close(), true);
      assert.deepEqual(input, original, 'the original stored request remains the native pair');
    }
    assert.deepEqual(sent, [
      { providerID: providerId, modelID: nestedModel },
      { providerID: providerId, modelID: 'auto' },
    ], 'a nested native ID and its suffix must reach different native models');
  } finally { await owner.close(); }
});

test('only ambiguous private V1 probe identities change, preserving account resources and normal fallback', async t => {
  const f = fixture(t), storage = join(f.root, 'store'); mkdirSync(storage);
  const profile = teamModelProbeProfile(f.member);
  assert.ok(profile.provider === 'opencode', 'the captured V1 member has an OpenCode probe profile');
  const oldKey = 'team-probe-' + runtimeDigest(f.member);
  const legacy = { ...profile, profileId: oldKey, configRevision: oldKey };
  const plainMember = { ...f.member, model: 'auto' };
  const plain = teamModelProbeProfile(plainMember);
  assert.match(profile.profileId, /^team-probe-v1-native-model-[a-f0-9]{64}$/u);
  assert.equal(profile.configRevision, profile.profileId);
  assert.equal(plain.profileId, 'team-probe-' + runtimeDigest(plainMember));
  assert.equal(captureTeamProbePreparation({} as Parameters<typeof captureTeamProbePreparation>[0], plain), undefined);
  assert.throws(() => captureTeamProbePreparation({} as Parameters<typeof captureTeamProbePreparation>[0], profile),
    { reason: 'probe-source-owner' });
  const owner = new ProviderManagementCoordinator([profile, legacy, plain], () => {}, storage);
  try {
    assert.equal(owner.readinessTarget(profile).resourceId, owner.readinessTarget(legacy).resourceId);
    assert.deepEqual(profile.environment, legacy.environment);
    assert.equal(profile.accountBinding, legacy.accountBinding);
  } finally { await owner.close(); }
});

for (const invalid of ['other-native-model', 'pre-fix-identity'] as const)
test(`V1 private readiness refuses ${invalid} for capture and native Restart`, async t => {
  const f = fixture(t), storage = join(f.root, 'store'); mkdirSync(storage);
  const profile = teamModelProbeProfile(f.member);
  const oldKey = 'team-probe-' + runtimeDigest(f.member);
  const legacy = { ...profile, profileId: oldKey, configRevision: oldKey };
  const profiles = new Map([[profile.profileId, profile], [legacy.profileId, legacy]]);
  const target = (value: ProviderManagementProfile) => ({
    profileId: value.profileId, configRevision: value.configRevision,
    selectionDigest: runtimeDigest(value), resourceId: runtimeDigest('TEST-shared-account'),
  });
  const context = runtimeDigest('TEST-context');
  const saved = storedModelProbeSchema.parse({ schemaVersion: 1, kind: 'model.probe',
    commandId: 'TEST-native-proof', ...target(profile), providerId, modelId: nestedModel,
    fingerprint: runtimeDigest('TEST-original-probe'), resourceHeld: false,
    effort: 'high', context, phase: 'completed', ok: true, expiresAt: Date.now() + 10_000,
    readinessScope: { schemaVersion: 1, kind: 'native',
      teamBindingDigest: runtimeDigest('TEST-team'), actionDigest: runtimeDigest('TEST-action'),
      selectionDigest: runtimeDigest('TEST-selection'), sourceRevision: 'TEST-source', rosterRevision: 'TEST-roster',
      mechanismDigest: modelReadinessMechanismDigest(profile), workspace: f.root,
      cutoff: Date.now() + 10_000, destinationKeys: ['TEST-member'] } });
  const store = new FileManagementCommandStore(storage); store.write(saved);
  const probes = new ModelProbeOwner({ store, fence: new ManagementResourceFence(store.list()),
    assertWriter() {}, select: (profileId, configRevision) => {
      const current = profiles.get(profileId); assert.ok(current); assert.equal(current.configRevision, configRevision);
      return target(current);
    }, prepare() { throw Error('TEST retained reads cannot run another probe'); } });
  const management = { probes, readinessTarget: target };
  const capture = () => capturePreparedModelReference({ management,
    profile: f.member, commandId: saved.commandId, context, kind: 'native', isCurrent: () => true });
  const originalReference = () => probes.captureReadinessReference(saved.commandId, context,
    current => ({ target: target(profiles.get(current.profileId)!), originCurrent: true }));
  const restart = () => {
    const reference = originalReference();
    const binding = {
      backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
      memberId: f.member.memberId, generation: 'TEST-generation',
    };
    const consumerIdentity = {
      memberId: f.member.memberId, actionId: saved.commandId,
      actorDigest: runtimeDigest('TEST-actor'), inputDigest: saved.fingerprint,
      binding, sourceAttemptId: 'TEST-attempt',
      baseConfigurationDigest: runtimeDigest(f.member), configurationDigest: runtimeDigest(f.member),
      configRevision: f.member.configRevision, cutoff: reference.expiresAt, groupCommandId: saved.commandId,
    };
    return captureNativeRestartReadiness({ management,
      entry: { profile: f.member, baseProfile: f.member, binding } as Parameters<typeof captureNativeRestartReadiness>[0]['entry'],
      launch: { readModelReadinessSource: () => ({ reference,
        consumer: { ...consumerIdentity, consumerId: runtimeDigest(consumerIdentity), disposition: 'consumed' },
      }) }, isCurrent: () => true, cutoff: Date.now() + 10_000,
    });
  };
  try {
    assert.equal((await capture()).reference.commandId, saved.commandId, 'new nested proof remains usable');
    assert.equal((await restart()).reference.commandId, saved.commandId);
    store.write(invalid === 'other-native-model' ? { ...saved, modelId: 'auto' }
      : { ...saved, ...target(legacy) });
    await assert.rejects(capture, { code: 'held' });
    await assert.rejects(restart, { code: 'held' });
    assert.equal([...store.list()].length, 1, 'refusal cannot allocate or migrate another receipt');
  } finally { await probes.close(); }
});

for (const available of [true, false])
test(`native-member V1 nested preflight ${available ? 'uses the captured private factory' : 'refuses a missing private factory'}`, async t => {
  const f = fixture(t), storage = join(f.root, 'store'); mkdirSync(storage);
  const coordinator = new ProviderManagementCoordinator([], () => {}, storage);
  const management = available ? coordinator : { probes: coordinator.probes,
    admitTeamProbeProfile: coordinator.admitTeamProbeProfile.bind(coordinator),
    readinessTarget: coordinator.readinessTarget.bind(coordinator) };
  let probe: NativeModelProbe | undefined;
  const stop = new Error('TEST stop before durable admission or native execution');
  const start = t.mock.method(coordinator.probes, 'startPrepared',
    (...[raw, current, _prepared, _scope, prepare]: Parameters<ModelProbeOwner['startPrepared']>) => {
      assert.ok(prepare);
      const input = raw as ModelProbeInput;
      assert.equal(input.providerId, providerId);
      assert.equal(input.modelId, nestedModel, 'the journal keeps the original native pair');
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
    }), available ? error => error === stop : { reason: 'probe-source-owner' });
    assert.equal(start.mock.callCount(), available ? 1 : 0);
    assert.deepEqual([...new FileManagementCommandStore(storage).list()], []);
    if (probe) assert.equal(await probe.close(), true);
  } finally { await probe?.close(); await coordinator.close(); }
});
