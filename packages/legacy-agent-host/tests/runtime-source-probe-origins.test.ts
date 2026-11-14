import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ClaudeManagementHost } from '../dist/adapters/providers/ClaudeManagementHost.js';
import { CodexManagementHost } from '../dist/adapters/providers/CodexManagementHost.js';
import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';

import type { CapturedNativeProcessFactory } from '../dist/adapters/providers/capturedNativeProcessFactory.js';
import type { RuntimeSourceProcessOrigin } from '../dist/composition/runtimeSourceProcessOrigin.js';
import type { ModelProbeInput, ModelProbePreparation } from '../dist/management/ModelProbeOwner.js';
import type { ProviderManagementProfile } from '../dist/management/profile.js';

function fixture(provider: ProviderManagementProfile['provider']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-probe-origins-')));
  for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'storage'])
    mkdirSync(join(root, name));
  const common = {
    profileId: 'TEST-equal-profile', configRevision: 'TEST-equal-revision', accountBinding: 'TEST-account',
    cwd: join(root, 'workspace'), timeoutMs: 2000, modelProbeTimeoutMs: 2000,
    executable: { path: join(root, 'TEST-never-launched'), sha256: 'a'.repeat(64) },
  };
  const profile: ProviderManagementProfile = provider === 'codex'
    ? { ...common, provider, protocolRevision: '0.169.0',
      environment: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'config'), PATH: root } }
    : provider === 'claude'
      ? { ...common, provider, sdkRevision: '0.3.305', configNamespace: 'custom-directory',
        environment: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), PATH: root } }
      : { ...common, provider, endpoint: 'http://127.0.0.1:19282',
        environment: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), PATH: root } };
  const identity = { profileId: profile.profileId, configRevision: profile.configRevision };
  const input = (commandId: string): ModelProbeInput => ({ ...identity, commandId,
    providerId: provider === 'claude' ? 'anthropic' : provider, modelId: 'TEST-model' });
  const origin = (revision: string): RuntimeSourceProcessOrigin => ({
    sourceId: 'e'.repeat(64), revision: revision.repeat(64),
    origin: { kind: 'runtime', projectPath: profile.cwd, teamId: 'TEST-team', memberId: 'TEST-member',
      scope: { teamId: 'TEST-team', projectId: 'TEST-project', workspaceId: 'TEST-workspace' },
      recipeIdentity: 'f'.repeat(64) },
  });
  return { root, storage: join(root, 'storage'), profile, identity, input, origin };
}

function refusingProcess(label: string, events: string[], stop: () => Promise<boolean> = async () => true): CapturedNativeProcessFactory {
  return (_profile, current) => {
    assert.equal(current(), true);
    events.push('create:' + label);
    return {
      launch: () => assert.fail('This coordinator fixture never launches a process'),
      seal: () => { events.push('seal:' + label); },
      isRunning: () => false,
      confirmStopped: async () => {
        events.push('stop-enter:' + label);
        const clean = await stop();
        events.push((clean ? 'stopped:' : 'unconfirmed:') + label);
        return clean;
      },
    };
  };
}

async function finished(owner: ProviderManagementCoordinator, input: ModelProbeInput) {
  for (let count = 0; count < 100; count++) {
    const value = owner.probes.read({ commandId: input.commandId,
      profileId: input.profileId, configRevision: input.configRevision });
    if (value && value.phase !== 'running') return value;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('The original controlled model operation did not settle');
}

for (const [provider, route] of [
  ['codex', 'ordinary'], ['codex', 'prepared'],
  ['claude', 'ordinary'], ['claude', 'prepared'],
] as const)
  test(`${provider} ${route} equal-profile probe origins survive the original metadata wait without retargeting`, { timeout: 10000 }, async t => {
    const f = fixture(provider), events: string[] = [], captured: RuntimeSourceProcessOrigin[] = [];
    const profileBytes = JSON.stringify(f.profile);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const metadataFailure = new Error('TEST finite metadata outcome');
    const host = provider === 'codex' ? CodexManagementHost : ClaudeManagementHost;
    t.mock.method(host.prototype, 'read', async () => {
      entered.resolve(); await release.promise; throw metadataFailure;
    });
    let nativeProbes = 0;
    t.mock.method(host.prototype, 'probe', async () => { nativeProbes++; return true; });
    const owner = new ProviderManagementCoordinator([f.profile], () => {}, f.storage, {
      createProcess: refusingProcess('metadata', events),
      captureProcess: (profile, origin) => {
        assert.deepEqual(profile, f.profile, 'capture uses the complete unmodified admitted profile');
        assert.ok(origin); captured.push(structuredClone(origin));
        return refusingProcess(origin.revision[0]!, events);
      },
    });
    const start = (input: ModelProbeInput, prepare: ModelProbePreparation) => route === 'prepared'
      ? owner.probes.startPrepared(input, () => true, undefined, undefined, prepare)
      : owner.probes.start(input, () => true, prepare);
    const a = f.input('TEST-original-A'), b = f.input('TEST-original-B');
    const originA = f.origin('1'), originB = f.origin('2'), expectedA = structuredClone(originA);
    const rawA = structuredClone(f.profile);
    const prepareA = owner.prepareTeamProbe(rawA, originA);
    rawA.environment.HOME = join(f.root, 'TEST-replaced-caller-home');
    originA.revision = '3'.repeat(64);
    const metadata = provider === 'codex' ? owner.codex.read(f.identity) : owner.claude.read(f.identity);
    const metadataRejected = assert.rejects(metadata, error => error === metadataFailure);
    try {
      await entered.promise;
      assert.equal(start(a, prepareA).phase, 'running');
      const prepareB = owner.prepareTeamProbe(structuredClone(f.profile), originB);
      originB.revision = '4'.repeat(64);
      assert.throws(() => start(b, prepareB), /busy/);
      assert.deepEqual(captured, [expectedA], 'busy admission cannot prepare or replace the queued origin');
      assert.deepEqual(events.filter(value => value.startsWith('create:')), ['create:metadata']);
      const store = new FileManagementCommandStore(f.storage);
      assert.equal(store.read(a.commandId)?.kind, 'model.probe', 'durable original precedes native work');
      assert.equal(store.read(b.commandId), undefined);
      release.resolve(); await metadataRejected;
      assert.equal((await finished(owner, a)).ok, true);
      assert.ok(events.indexOf('stopped:metadata') < events.indexOf('create:1'));
      assert.equal(start(b, prepareB).phase, 'running');
      assert.equal((await finished(owner, b)).ok, true);
      assert.deepEqual(captured, [expectedA, f.origin('2')]);
      assert.deepEqual(events.filter(value => value.startsWith('create:')), ['create:metadata', 'create:1', 'create:2']);
      assert.ok(events.indexOf('stopped:1') < events.indexOf('create:2'));
      assert.equal(start(a, prepareB).phase, 'completed', 'same-ID replay cannot capture the later origin');
      assert.deepEqual(captured, [expectedA, f.origin('2')]);
      assert.equal(nativeProbes, 2);
      assert.equal(JSON.stringify(f.profile), profileBytes);
      const savedA = store.read(a.commandId)!, savedB = store.read(b.commandId)!;
      assert.equal(savedA.selectionDigest, savedB.selectionDigest, 'source sidecars do not relabel equal profile digests');
      for (const saved of [savedA, savedB]) {
        assert.equal(JSON.stringify(saved).includes('"sourceId"'), false);
        assert.equal(JSON.stringify(saved).includes('"processOrigin"'), false);
      }
    } finally {
      release.resolve(); await metadataRejected;
      await owner.close(); rmSync(f.root, { recursive: true, force: true });
    }
  });

for (const clean of [true, false])
  test(`V1 equal-profile cache retirement ${clean ? 'releases only the original before B' : 'holds B after unconfirmed original cleanup'}`, { timeout: 10000 }, async t => {
    const f = fixture('opencode'), events: string[] = [];
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const profileBytes = JSON.stringify(f.profile);
    t.mock.method(OpenCodeManagementHost.prototype, 'probeModel', async () => true);
    const owner = new ProviderManagementCoordinator([f.profile], () => {}, f.storage, {
      captureProcess: (profile, origin) => {
        assert.deepEqual(profile, f.profile, 'origin is captured before private V1 server overlays');
        assert.ok(origin);
        return refusingProcess(origin.revision[0]!, events, origin.revision === '1'.repeat(64)
          ? async () => { entered.resolve(); await release.promise; return clean; }
          : undefined);
      },
    });
    // Coordinator-cache scope only: A is a trusted prepared native owner, not a
    // fabricated durable ModelProbeOwner admission. B uses the actual durable fence.
    const a = owner.prepareTeamProbe(f.profile, f.origin('1'))(f.input('TEST-cache-A'), () => true);
    const b = f.input('TEST-durable-B');
    try {
      assert.equal(await a.run(new AbortController().signal), true);
      assert.equal(owner.probes.start(b, () => true, owner.prepareTeamProbe(f.profile, f.origin('2'))).phase, 'running');
      await entered.promise;
      assert.deepEqual(events.filter(value => value.startsWith('create:')), ['create:1']);
      assert.equal(new FileManagementCommandStore(f.storage).read(b.commandId)?.kind, 'model.probe');
      release.resolve();
      const result = await finished(owner, b);
      assert.equal(result.phase, clean ? 'completed' : 'held'); assert.equal(result.ok, clean);
      assert.deepEqual(events.filter(value => value.startsWith('create:')), clean ? ['create:1', 'create:2'] : ['create:1']);
      if (clean) assert.ok(events.indexOf('stopped:1') < events.indexOf('create:2'));
      assert.equal(JSON.stringify(f.profile), profileBytes);
    } finally {
      release.resolve(); assert.equal(await a.close(), clean);
      if (clean) await owner.close(); else await assert.rejects(owner.close(), /held/);
      rmSync(f.root, { recursive: true, force: true });
    }
  });

test('V1 catalog rechecks the actual model fence after awaiting original same-profile retirement', { timeout: 10000 }, async t => {
  const f = fixture('opencode'), events: string[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.mock.method(OpenCodeManagementHost.prototype, 'probeModel', async () => true);
  t.mock.method(OpenCodeManagementHost.prototype, 'run', async () => assert.fail('A fenced catalog cannot enter its native operation'));
  const owner = new ProviderManagementCoordinator([f.profile], () => {}, f.storage, {
    captureProcess: (_profile, origin) => refusingProcess(origin?.revision[0] ?? 'catalog', events,
      origin?.revision === '1'.repeat(64)
        ? async () => { entered.resolve(); await release.promise; return true; }
        : undefined),
  });
  // Retain only the coordinator's original cache; no durable A receipt is invented.
  const a = owner.prepareTeamProbe(f.profile, f.origin('1'))(f.input('TEST-cache-A'), () => true);
  const c = f.input('TEST-durable-C');
  try {
    assert.equal(await a.run(new AbortController().signal), true);
    const catalog = assert.rejects(owner.catalog(f.identity), /busy/);
    await entered.promise;
    assert.equal(owner.probes.start(c, () => true, owner.prepareTeamProbe(f.profile, f.origin('3'))).phase, 'running');
    assert.equal(new FileManagementCommandStore(f.storage).read(c.commandId)?.resourceHeld, true);
    assert.deepEqual(events.filter(value => value.startsWith('create:')), ['create:1']);
    release.resolve(); await catalog;
    assert.equal((await finished(owner, c)).ok, true);
    assert.deepEqual(events.filter(value => value.startsWith('create:')), ['create:1', 'create:3']);
    assert.ok(events.indexOf('stopped:1') < events.indexOf('create:3'));
  } finally {
    release.resolve(); await a.close(); await owner.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
