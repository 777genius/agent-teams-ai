import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { createOpenCodeV2ModelProbe } from '../dist/adapters/providers/OpenCodeV2ModelProbe.js';
import { applyLaunchConfiguration } from '../dist/composition/launchConfiguration.js';
import { runtimeMemberProfileSchema } from '../dist/composition/runtimeProfile.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';
import { applyTeamModelProbeSelection } from '../dist/composition/teamModelProbeRecipe.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';

const supported =
  ['linux', 'darwin', 'win32'].includes(process.platform) &&
  ['x64', 'arm64'].includes(process.arch) &&
  !(process.platform === 'linux' && process.arch === 'arm64');
function fixture(model = 'TEST-model') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-model-probe-')));
  const profile = runtimeMemberProfileSchema.parse({
    provider: 'opencode',
    nativeGeneration: 'v2',
    protocolRevision: '2.1.4',
    teamId: 'TEST-team',
    memberId: 'TEST-member',
    principalId: 'TEST-principal',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-revision',
    cwd: root,
    accountBinding: 'TEST-account',
    model,
    executable: { path: join(root, 'TEST-bun'), sha256: 'a'.repeat(64) },
    endpoint: 'http://127.0.0.1:19332',
    environment: Object.fromEntries(
      ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map((key) => [key, root])
    ),
    embedded: {
      version: '2.1.4',
      platform: process.platform,
      arch: process.arch,
      directory: join(root, 'engine'),
      manifestSha256: 'b'.repeat(64),
      externalDirectory: 'deny',
    },
    nativeOptions: {
      providerId: 'TEST-provider',
      agent: 'build',
      variant: 'high',
      toolApprovalMode: 'manual',
    },
    limits: {
      queuedInputs: 1,
      inputBytes: 4096,
      outputBytes: 8192,
      outputEvents: 128,
      pendingInteractions: 1,
      timeoutMs: 30000,
    },
  });
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

test(
  'embedded V2 cannot enter the V1 catalog/auth host or silently switch a probe model',
  { skip: !supported },
  (t) => {
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
      'rejected preparation must allocate no namespace or process'
    );
  }
);

test(
  'V2 model probe preparation is effect-free and revoked run cannot allocate or replay',
  { skip: !supported },
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const probe = createOpenCodeV2ModelProbe(f.management, f.input, () => false);
    assert.deepEqual(readdirSync(f.root), []);
    const signal = new AbortController().signal;
    const original = probe.run(signal);
    assert.equal(probe.run(signal), original, 'one private attempt, never retry a failed run');
    await assert.rejects(original, { code: 'held' });
    assert.equal(await probe.close(), true);
    assert.equal(await probe.close(), true);
    assert.deepEqual(readdirSync(f.root), []);
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
      { model: 'foreign/TEST-model' },
      { effort: 'high' },
      { fastMode: true },
      { context: 'one-million' },
    ])
      assert.throws(() => applyLaunchConfiguration(f.profile, choice), {
        reason: 'launch-option-unsupported',
      });
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
      for (const modelId of [selectedModel, 'TEST-provider/' + selectedModel]) {
        const probe = createOpenCodeV2ModelProbe(management, { ...f.input, modelId }, () => true);
        assert.deepEqual(readdirSync(f.root), [], 'Default probe preparation allocates no child or namespace');
        assert.equal(await probe.close(), true);
      }
      for (const modelId of [
        'auto',
        'TEST-provider/foreign',
        'foreign/' + selectedModel,
        'TEST-provider/TEST-provider/' + selectedModel,
      ])
        assert.throws(
          () => createOpenCodeV2ModelProbe(management, { ...f.input, modelId }, () => true),
          { code: 'invalid' }
        );
      assert.equal(selected.model, model, 'native model identity remains unchanged');
      assert.deepEqual(management.nativeModel, { providerId: 'TEST-provider', modelId: model });
      assert.deepEqual(readdirSync(f.root), [], 'accepted and rejected preparation leave no effects');
      assert.throws(() => applyTeamModelProbeSelection(f.profile, { ...input, effort: 'low' }), {
        reason: 'launch-option-unsupported',
      });
    }
  }
);
