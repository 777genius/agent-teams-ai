import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { createOpenCodeV2ModelProbe } from '../dist/adapters/providers/OpenCodeV2ModelProbe.js';
import { attestOpenCodeV2ModelSelection } from '../dist/adapters/providers/OpenCodeV2ModelSelection.js';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { openCodeV2NoToolConfig } from '../dist/adapters/providers/OpenCodeV2EmbeddedConfig.js';
import { applyLaunchConfiguration } from '../dist/composition/launchConfiguration.js';
import { selectOpenCodeV2ManagementModel } from '../dist/composition/openCodeV2ModelSelection.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { applyTeamModelProbeSelection } from '../dist/composition/teamModelProbeRecipe.js';
import { openCodeManagementProfileSchema, providerManagementProfileSchema } from '../dist/management/profile.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { modelReadinessMechanismDigest } from '../dist/team-launch/launchReadiness.js';
import { opencodeV2ModelProbeProfile } from './fixtures/opencode-v2-model-probe-profile.ts';
import type { OpenCodeManagementProfile } from '../dist/management/profile.js';
import type { ModelProbePreparation } from '../dist/management/ModelProbeOwner.js';
import type { ModelReadinessProbeScope } from '../dist/management/commandRecords.js';

const supported =
  ['linux', 'darwin', 'win32'].includes(process.platform) &&
  ['x64', 'arm64'].includes(process.arch) &&
  !(process.platform === 'linux' && process.arch === 'arm64');
function fixture(model = 'TEST-model', timeoutMs = 30000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-model-probe-')));
  const profile = runtimeMemberProfileSchema.parse(opencodeV2ModelProbeProfile(root, model, timeoutMs));
  const management = teamModelProbeProfile(profile);
  assert.equal(management.provider, 'opencode');
  if (management.provider !== 'opencode') throw Error('TEST expected OpenCode');
  const input = {
    commandId: 'TEST-probe',
    profileId: management.profileId,
    configRevision: management.configRevision,
    providerId: 'TEST-provider',
    modelId: model,
  };
  return {
    root,
    profile,
    management,
    input,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const [selected, expected] of [[1000, 1000], [30000, 30000], [30001, 30001],
  [60000, 60000], [90000, 90000], [120000, 90000]] as const) {
  test(`embedded V2 startup policy selects ${expected}ms from the original ${selected}ms runtime`,
    { skip: !supported }, t => {
      const f = fixture('TEST-model', selected); t.after(f.cleanup);
      const before = structuredClone(f.profile), derived = teamModelProbeProfile(f.profile);
      assert.equal(openCodeManagementProfileSchema.parse(derived).timeoutMs, expected);
      assert.equal(derived.modelProbeTimeoutMs, 90000, 'the outer model probe allowance never increases');
      assert.deepEqual(f.profile, before, 'derivation cannot mutate the selected runtime');
      const originalKey = `team-probe-${runtimeDigest(f.profile)}`;
      if (expected <= 30000) assert.equal(derived.profileId, originalKey, 'unchanged policy keeps its identity');
      else assert.notEqual(derived.profileId, originalKey, 'a changed policy cannot collide with retained profile bytes');
      assert.equal(derived.configRevision, derived.profileId);
      assert.deepEqual(teamModelProbeProfile(structuredClone(f.profile)), derived, 'equal recipes keep equal policy identities');
    });
}

for (const provider of ['opencode', 'claude', 'codex'] as const) {
  for (const [selected, expected] of [[1000, 1000], [120000, 30000]] as const) {
    test(`${provider} legacy Team probe retains its ${expected}ms startup policy and identity`, t => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-legacy-probe-policy-')));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const { nativeGeneration: _generation, embedded: _embedded, endpoint: _endpoint,
        protocolRevision: _revision, nativeOptions: _options, ...base } = opencodeV2ModelProbeProfile(root, 'TEST-model', selected);
      const profile = runtimeMemberProfileSchema.parse({ ...base, provider,
        ...(provider === 'opencode' ? { protocolRevision: '1.19.4', endpoint: 'http://127.0.0.1:19332',
          nativeOptions: { providerId: 'TEST-provider', agent: 'build' } }
          : provider === 'claude' ? { nativeTools: [], autoAllowedTools: [],
            environment: { ...base.environment, PATH: root, CLAUDE_CONFIG_DIR: root } }
            : { protocolRevision: '0.169.0', environment: { ...base.environment, CODEX_HOME: root },
              nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } }),
      });
      const derived = providerManagementProfileSchema.parse(teamModelProbeProfile(profile));
      assert.equal(derived.timeoutMs, expected); assert.equal(derived.modelProbeTimeoutMs, 90000);
      assert.equal(derived.profileId, `team-probe-${runtimeDigest(profile)}`);
      assert.equal(derived.configRevision, derived.profileId);
    });
  }
}

for (const clean of [true, false]) {
  test(`changed V2 startup policy ${clean ? 'requalifies through real registration and cold replay' : 'cannot bypass unknown original resource custody'}`,
    { skip: !supported }, async t => {
      const f = fixture('TEST-model', 120000); t.after(f.cleanup);
      const current = openCodeManagementProfileSchema.parse(f.management);
      const legacyKey = `team-probe-${runtimeDigest(f.profile)}`;
      const legacy = { ...current, profileId: legacyKey, configRevision: legacyKey, timeoutMs: 30000 };
      const storage = join(f.root, 'TEST-management-store'); mkdirSync(storage);
      const records = new FileManagementCommandStore(storage);
      let runs = 0, closes = 0;
      const prepare: ModelProbePreparation = () => ({ timeoutMs: 90000,
        async run(signal) { signal.throwIfAborted(); runs++; return true; },
        async close() { closes++; return clean; } });
      const input = (profile: OpenCodeManagementProfile, commandId: string) => ({ commandId,
        profileId: profile.profileId, configRevision: profile.configRevision, providerId: 'TEST-provider',
        modelId: 'TEST-model', context: runtimeDigest(commandId) });
      const scope = (profile: OpenCodeManagementProfile): ModelReadinessProbeScope => ({
        schemaVersion: 1, kind: 'native', teamBindingDigest: runtimeDigest('TEST-team'),
        actionDigest: runtimeDigest('TEST-action'), selectionDigest: runtimeDigest('TEST-selection'),
        sourceRevision: 'TEST-source', rosterRevision: 'TEST-roster', workspace: f.root,
        mechanismDigest: modelReadinessMechanismDigest(profile), cutoff: Date.now() + 90000,
        destinationKeys: ['TEST-member'],
      });
      const original = input(legacy, 'TEST-old-policy-probe'), originalScope = scope(legacy);
      const fresh = input(current, 'TEST-new-policy-probe'), freshScope = scope(current);
      const coordinator = new ProviderManagementCoordinator([legacy], () => {}, storage);
      let cold: ProviderManagementCoordinator | undefined;
      try {
        coordinator.probes.startPrepared(original, () => true, undefined, originalScope, prepare);
        await coordinator.probes.awaitPrepared(original.commandId, original.context);
        const retained = records.read(original.commandId)!;
        assert.equal(retained.resourceHeld, !clean);
        coordinator.admitTeamProbeProfile(current);
        coordinator.admitTeamProbeProfile(structuredClone(current));
        assert.notEqual(coordinator.readinessTarget(current).selectionDigest,
          coordinator.readinessTarget(legacy).selectionDigest, 'old proof cannot become a new-policy proof');
        assert.equal(coordinator.readinessTarget(current).resourceId,
          coordinator.readinessTarget(legacy).resourceId, 'policy version never creates a new account fence');
        assert.throws(() => coordinator.admitTeamProbeProfile({ ...current, timeoutMs: current.timeoutMs - 1 }),
          { code: 'conflict' }, 'different bytes under the new identity remain forbidden');
        assert.throws(() => coordinator.probes.startPrepared({ ...fresh, commandId: original.commandId },
          () => true, undefined, freshScope, prepare), { code: 'conflict' }, 'old command cannot replay as a new-policy run');
        if (!clean) {
          assert.throws(() => coordinator.probes.startPrepared(fresh, () => true, undefined, freshScope, prepare),
            { code: 'held' }, 'new identity cannot escape original unknown custody');
          assert.equal(runs, 1); assert.equal(closes, 1);
          assert.deepEqual(records.read(original.commandId), retained);
          return;
        }
        assert.throws(() => coordinator.probes.captureReadinessReference(original.commandId, original.context,
          () => ({ target: coordinator.readinessTarget(current), originCurrent: true })), { code: 'conflict' });
        coordinator.probes.startPrepared(fresh, () => true, undefined, freshScope, prepare);
        await coordinator.probes.awaitPrepared(fresh.commandId, fresh.context);
        const qualified = coordinator.probes.captureReadinessReference(fresh.commandId, fresh.context,
          () => ({ target: coordinator.readinessTarget(current), originCurrent: true }));
        assert.equal(qualified.mechanismDigest, modelReadinessMechanismDigest(current));
        assert.equal(runs, 2); assert.equal(closes, 2);
        await coordinator.close();
        cold = new ProviderManagementCoordinator([current], () => {}, storage);
        cold.admitTeamProbeProfile(structuredClone(current));
        const replayed = cold.probes.startPrepared(fresh, () => true, undefined, freshScope, prepare);
        assert.equal(replayed.ok, true); assert.equal(runs, 2, 'cold replay never spends a new native request');
        const retry = input(current, 'TEST-new-policy-explicit-recheck');
        cold.probes.startPrepared(retry, () => true, undefined, scope(current), prepare);
        await cold.probes.awaitPrepared(retry.commandId, retry.context);
        assert.equal(cold.probes.read({ commandId: retry.commandId,
          profileId: retry.profileId, configRevision: retry.configRevision })?.ok, true);
        assert.equal(runs, 3); assert.equal(closes, 3);
        assert.deepEqual(records.read(original.commandId), retained, 'new qualification never rewrites old evidence');
      } finally {
        if (clean) await coordinator.close();
        else await assert.rejects(coordinator.close(), { code: 'held' });
        await cold?.close();
      }
    });
}

test(
  'embedded V2 model probe carries its immutable model and engine selection',
  { skip: !supported },
  (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const parsed = openCodeManagementProfileSchema.parse(f.management);
    assert.equal(parsed.nativeGeneration, 'v2');
    assert.equal(parsed.protocolRevision, '2.1.4');
    assert.deepEqual(parsed.nativeModel, { providerId: 'TEST-provider', modelId: 'TEST-model' });
    assert.equal(parsed.variant, 'high');
    assert.equal(parsed.embedded?.manifestSha256, 'b'.repeat(64));
    for (const property of ['embedded', 'nativeModel', 'protocolRevision'] as const) {
      const incomplete = { ...f.management };
      delete incomplete[property];
      assert.equal(openCodeManagementProfileSchema.safeParse(incomplete).success, false);
    }
    assert.equal(
      openCodeManagementProfileSchema.safeParse({ ...f.management, nativeGeneration: 'v1' })
        .success,
      false
    );
    assert.equal(
      openCodeManagementProfileSchema.safeParse({ ...f.management, protocolRevision: '2.0.21' })
        .success,
      false
    );
  }
);

test('private native config preserves selected declarations and running A while a new source B invalidates pending captures',
  { skip: !supported }, t => {
    const f = fixture();
    t.after(f.cleanup);
    mkdirSync(join(f.root, 'opencode'));
    writeFileSync(join(f.root, 'opencode/opencode.json'), JSON.stringify({
      provider: { 'TEST-provider': { npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://127.0.0.1:12345/v1' }, models: {
          'TEST-model': { name: 'global A', limit: { context: 32000 } },
          'TEST-B': { name: 'global B', headers: { 'x-test-config': 'TEST-original-private-header' },
            body: { test_scope: 'global' }, limit: { context: 64000, output: 256 } },
        } },
      },
    }), { mode: 0o600 });
    const project = join(f.root, 'opencode.json');
    writeFileSync(project, JSON.stringify({ provider: { 'TEST-provider': {
      models: { 'TEST-B': { body: { test_scope: 'project-A' }, limit: { output: 128 } } },
    } } }), { mode: 0o600 });
    f.management.embedded!.configurationSource = captureOpenCodeConfigurationSource(f.management).reference;
    let current = true;
    const choice = { providerId: 'TEST-provider', modelId: 'TEST-B' };
    const running = captureOpenCodeV2Configuration(f.management, choice, () => current);
    const pending = captureOpenCodeV2Configuration(f.management, choice, () => current, 'catalog');
    assert.deepEqual(Object.keys(running.configuration!.models!), ['TEST-B']);
    assert.deepEqual(Object.keys(pending.configuration!.models!), ['TEST-model', 'TEST-B']);
    const native = openCodeV2NoToolConfig(f.management, running.configuration).config;
    assert.deepEqual(native.providers!['TEST-provider']!.models, {
      'TEST-B': { name: 'global B', headers: { 'x-test-config': 'TEST-original-private-header' },
        body: { test_scope: 'project-A' }, limit: { context: 64000, output: 128 } },
    });
    assert.ok(!JSON.stringify(f.management).includes('TEST-original-private-header'));
    running.bindRunningSession();
    writeFileSync(project, '{"model":"TEST-provider/TEST-replacement"}', { mode: 0o600 });
    assert.equal(pending.isCurrent(), false);
    assert.equal(running.isCurrent(), true, 'native A already owns its immutable private input');
    assert.throws(() => captureOpenCodeV2Configuration(f.management, choice, () => true),
      { reason: 'configuration-changed' });
    current = false;
    assert.equal(running.isCurrent(), false, 'source pinning never widens the original owner');
  });

test(
  'embedded V2 derives an explicit probe choice without allocation or foreign provider configuration',
  { skip: !supported },
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    let allocations = 0;
    assert.throws(
      () =>
        new OpenCodeManagementHost(
          f.management,
          { canAllocate: () => true, isCurrent: () => true },
          {
            createProcess: () => {
              allocations++;
              throw Error('TEST V1 process allocation forbidden');
            },
          }
        ),
      { code: 'invalid-profile' }
    );
    assert.equal(allocations, 0);
    for (const change of [
      { providerId: 'foreign' },
      { modelId: 'foreign' },
      { effort: 'low' as const },
    ]) {
      const probe = createOpenCodeV2ModelProbe(f.management, { ...f.input, ...change }, () => true);
      assert.equal(await probe.close(), true);
    }
    const configured = { ...f.management, embedded: { ...f.management.embedded!,
      providerConfiguration: { settings: { apiKey: 'TEST-must-not-cross-provider' } } } };
    const foreign = selectOpenCodeV2ManagementModel(configured,
      { providerId: 'TEST-other', modelId: 'TEST-other/TEST-next', effort: 'low' });
    assert.equal(foreign.embedded?.providerConfiguration, undefined);
    assert.deepEqual(foreign.nativeModel, { providerId: 'TEST-other', modelId: 'TEST-next' });
    assert.equal(foreign.variant, 'low');
    assert.equal(foreign.profileId, configured.profileId);
    assert.equal(foreign.accountBinding, configured.accountBinding);
    assert.deepEqual(foreign.environment, configured.environment);
    assert.ok(configured.embedded.providerConfiguration);
    const originalPair = selectOpenCodeV2ManagementModel(configured,
      { providerId: configured.nativeModel!.providerId, modelId: configured.nativeModel!.modelId });
    assert.equal(originalPair.variant, configured.variant);
    for (const providerId of [configured.nativeModel!.providerId, 'TEST-other']) {
      const fallback = selectOpenCodeV2ManagementModel(configured,
        { providerId, modelId: `${providerId}/TEST-fallback` });
      assert.equal(fallback.variant, undefined, 'a credential fallback cannot inherit another model variant');
      assert.equal(Boolean(fallback.embedded?.providerConfiguration), providerId === configured.nativeModel!.providerId);
    }
    assert.equal(configured.variant, 'high', 'selection does not mutate the original profile');
    for (const change of [
      { providerId: '' },
      { modelId: '' },
      { limits: { contextTokens: 4096, outputTokens: 128 } },
      { modelContext: 'one-million' as const },
    ])
      assert.throws(
        () => createOpenCodeV2ModelProbe(f.management, { ...f.input, ...change }, () => true),
        { code: 'invalid' }
      );
    assert.deepEqual(
      readdirSync(f.root),
      [],
      'selection preparation must allocate no namespace or process'
    );
  }
);

test(
  'V2 model probe preparation is effect-free and revoked run cannot allocate or replay',
  { skip: !supported },
  async (t) => {
    for (const change of ['owner', 'auth', 'configuration', 'manual-owner', 'manual-configuration'] as const) {
      const f = fixture();
      t.after(f.cleanup);
      const manual = change.startsWith('manual-');
      if (manual) f.management.environment.USERPROFILE = f.root;
      if (change === 'configuration' || manual) {
        writeFileSync(join(f.root, 'opencode.json'), JSON.stringify({
          model: 'TEST-provider/TEST-model',
          ...(manual ? { provider: { 'TEST-provider': { npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: '{file:TEST-missing-manual.key}' },
            models: { 'TEST-model': { name: 'TEST-model' } } } } } : {}),
        }), { mode: 0o600 });
        f.management.embedded!.configurationSource =
          captureOpenCodeConfigurationSource(f.management).reference;
      }
      if (change === 'owner')
        assert.throws(() => createOpenCodeV2ModelProbe(f.management, f.input, () => false),
          { code: 'held' });
      const before = readdirSync(f.root);
      let current = true;
      const probe = createOpenCodeV2ModelProbe(f.management, f.input, () => current);
      assert.equal(probe.nativeFileKeyWitness?.(), undefined, 'preparation cannot issue a native file witness');
      assert.deepEqual(readdirSync(f.root), before, 'preparation is allocation-free');
      if (change === 'owner' || change === 'manual-owner') current = false;
      else if (change === 'auth') {
        mkdirSync(join(f.root, 'opencode'));
        writeFileSync(join(f.root, 'opencode/auth.json'), JSON.stringify({
          'TEST-provider': { type: 'api', key: 'TEST-new-original-namespace-key' },
        }), { mode: 0o600 });
      } else {
        writeFileSync(join(f.root, 'opencode.json'), JSON.stringify({
          model: 'TEST-provider/TEST-replacement',
        }), { mode: 0o600 });
      }
      const changed = readdirSync(f.root);
      const signal = new AbortController().signal;
      const original = probe.run(signal);
      assert.equal(probe.run(signal), original, 'one private attempt, never retry a failed run');
      await assert.rejects(original, { code: 'held' });
      assert.deepEqual(readdirSync(f.root), changed,
        change + ' must refuse before creating a native probe namespace, not hide it in cleanup');
      assert.equal(await probe.close(), true);
      assert.equal(await probe.close(), true);
      assert.deepEqual(readdirSync(f.root), changed);
    }
  }
);

test(
  'cancelled V2 probe cannot start a child after its owner has closed',
  { skip: !supported },
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const probe = createOpenCodeV2ModelProbe(f.management, f.input, () => true);
    assert.equal(await probe.close(), true);
    await assert.rejects(probe.run(new AbortController().signal));
    assert.deepEqual(readdirSync(f.root), []);
  }
);

for (const change of ['writer', 'sealed', 'namespace', 'selection'] as const) {
  test(`V2 Team probe checks its writer once per target observation and refuses ${change} changes`,
    { skip: !supported }, async (t) => {
      const f = fixture();
      t.after(f.cleanup);
      const data = join(f.root, 'TEST-account-data');
      mkdirSync(data);
      f.management.environment.XDG_DATA_HOME = data;
      let writerCurrent = true, selectionCurrent = true, writerChecks = 0;
      const observations: number[] = [];
      const coordinator = new ProviderManagementCoordinator([f.management], () => {
        writerChecks++;
        if (!writerCurrent) throw new Error('TEST writer revoked');
      }, f.root);
      const prepare = coordinator.prepareTeamProbe(f.management);
      const probe = prepare(f.input, () => {
        observations.push(writerChecks);
        writerChecks = 0;
        return selectionCurrent;
      });
      try {
        // Initial admission has its own fences; each later live selection still
        // requires a fresh writer observation, without an adjacent duplicate.
        assert.ok(observations.length > 1, 'preparation must exercise repeated live selections');
        assert.deepEqual(observations.slice(1), Array(observations.length - 1).fill(1));
        const selectionCalls = observations.length;
        if (change === 'writer') writerCurrent = false;
        else if (change === 'sealed') coordinator.seal();
        else if (change === 'selection') selectionCurrent = false;
        else {
          renameSync(data, data + '-original');
          mkdirSync(data);
        }
        const before = { root: readdirSync(f.root).sort(), data: readdirSync(data).sort() };
        await assert.rejects(probe.run(new AbortController().signal), { code: 'held' });
        assert.equal(observations.length, selectionCalls + (change === 'selection' ? 1 : 0),
          'refused writer or target must stop before consulting the captured selection');
        assert.deepEqual({ root: readdirSync(f.root).sort(), data: readdirSync(data).sort() }, before,
          'refusal must precede native namespace allocation, not conceal it during cleanup');
        assert.equal(await probe.close(), true);
      } finally {
        writerCurrent = true;
        await probe.close();
        await coordinator.close();
      }
    });
}

test('native model admission requires its declared variant and a still-current owner', async () => {
  const selection = { providerID: 'TEST-provider', id: 'TEST-model', variant: 'high' };
  const model = { id: selection.id, enabled: true, variants: ['high'], supportsTools: true };
  const catalog = { provider: { id: selection.providerID, activation: 'active' },
    defaultModel: { providerId: selection.providerID, modelId: selection.id }, models: [model] };
  let current = true;
  const options = { signal: new AbortController().signal, deadline: Date.now() + 1000,
    isCurrent: () => current, requireTools: true };
  const client = { readCatalog: async () => catalog };
  await attestOpenCodeV2ModelSelection(client, selection, options);
  await assert.rejects(attestOpenCodeV2ModelSelection(client,
    { ...selection, variant: 'max' }, options), { code: 'invalid' });
  model.supportsTools = false;
  await assert.rejects(attestOpenCodeV2ModelSelection(client, selection, options),
    { code: 'invalid' });
  await assert.rejects(attestOpenCodeV2ModelSelection({ readCatalog: async () => {
    current = false;
    return catalog;
  } }, selection, options), { code: 'held' });
});

test(
  'only embedded 2.1.4 maps the existing Launch manual/bypass choice to native tool approval',
  { skip: !supported },
  (t) => {
    const f = fixture();
    t.after(f.cleanup);
    for (const [permissions, mode] of [
      ['manual', 'manual'],
      ['bypass', 'auto'],
    ] as const) {
      const mapped = applyLaunchConfiguration(f.profile, {
        model: 'TEST-provider/TEST-model',
        permissions,
      });
      assert.equal(mapped.provider, 'opencode');
      if (mapped.provider !== 'opencode') throw Error('TEST expected OpenCode');
      assert.equal(mapped.nativeOptions.toolApprovalMode, mode);
      assert.equal(mapped.nativeOptions.variant, 'high');
      assert.equal(mapped.embedded?.externalDirectory, 'deny');
      assert.deepEqual(mapped.executable, f.profile.executable);
      assert.deepEqual(mapped.environment, f.profile.environment);
    }
    for (const choice of [
      { model: 'TEST-model' },
      { fastMode: true },
      { context: 'one-million' },
    ])
      assert.throws(() => applyLaunchConfiguration(f.profile, choice), {
        reason: 'launch-option-unsupported',
      });
    const changed = applyLaunchConfiguration(f.profile,
      { model: 'TEST-provider/TEST-next', effort: 'low' });
    assert.equal(changed.provider, 'opencode');
    if (changed.provider !== 'opencode') throw Error('TEST expected OpenCode');
    assert.equal(changed.model, 'TEST-next');
    assert.equal(changed.nativeOptions.variant, 'low');
    assert.deepEqual(changed.environment, f.profile.environment);
    assert.deepEqual(changed.executable, f.profile.executable);
    const old = runtimeMemberProfileSchema.parse({
      ...f.profile,
      protocolRevision: '2.0.21',
      embedded: undefined,
    });
    for (const permissions of ['manual', 'bypass'])
      assert.throws(() => applyLaunchConfiguration(old, { permissions }), {
        reason: 'launch-option-unsupported',
      });
    assert.throws(() => teamModelProbeProfile(old), { reason: 'probe-v2-unsupported' });
  }
);

test(
  'saved V2 Default preserves simple and provider-prefixed native model IDs for the finite probe',
  { skip: !supported },
  async (t) => {
    for (const model of ['TEST-model', 'TEST-provider/auto']) {
      const f = fixture(model);
      t.after(f.cleanup);
      const input = {
        launchId: 'TEST-launch',
        rosterRevision: 'TEST-roster',
        memberId: 'TEST-member',
        model: '__provider_default__',
        effort: 'high' as const,
      };
      const selected = applyTeamModelProbeSelection(f.profile, input);
      const selectedModel = selected.model;
      assert.equal(selectedModel, model);
      if (typeof selectedModel !== 'string') throw Error('TEST expected captured model');
      const management = teamModelProbeProfile(selected);
      assert.equal(management.provider, 'opencode');
      if (management.provider !== 'opencode') throw Error('TEST expected OpenCode');
      assert.equal(management.variant, 'high');
      assert.deepEqual(management.nativeModel, { providerId: 'TEST-provider', modelId: model });
      const coordinator = new ProviderManagementCoordinator([management], () => {}, f.root);
      const before = readdirSync(f.root);
      const nativeInput = { ...f.input, profileId: management.profileId,
        configRevision: management.configRevision, modelId: selectedModel };
      try {
        const probes = [
          coordinator.prepareTeamProbe(management)(nativeInput, () => true),
          createOpenCodeV2ModelProbe(management,
            { ...nativeInput, modelId: 'TEST-provider/' + selectedModel }, () => true),
        ];
        for (const probe of probes) {
          assert.deepEqual(readdirSync(f.root), before, 'Default probe preparation allocates no child or namespace');
          assert.equal(await probe.close(), true);
        }
      } finally { await coordinator.close(); }
      for (const modelId of ['', 'x'.repeat(257), 'TEST-provider/'])
        assert.throws(
          () => createOpenCodeV2ModelProbe(management, { ...f.input, modelId }, () => true),
          { code: 'invalid' }
        );
      assert.equal(selected.model, model, 'native model identity remains unchanged');
      assert.deepEqual(management.nativeModel, { providerId: 'TEST-provider', modelId: model });
      assert.deepEqual(readdirSync(f.root), before, 'accepted and rejected preparation leave no effects');
      const changed = applyTeamModelProbeSelection(f.profile, { ...input, effort: 'low' });
      if (changed.provider !== 'opencode') throw Error('TEST expected OpenCode');
      assert.equal(changed.nativeOptions.variant, 'low');
      assert.equal(changed.model, model);
    }
  }
);
