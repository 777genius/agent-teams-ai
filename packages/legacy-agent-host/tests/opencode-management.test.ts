import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { OpenCodeClientFactory } from '@agent-teams/provider-implementations/opencode';

import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { readOpenCodeCatalog } from '../dist/adapters/providers/readOpenCodeCatalog.js';
import { assertAccountNamespaces } from '../dist/composition/assertAccountNamespaces.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import type { OpenCodeManagementClient } from '../src/adapters/providers/OpenCodeManagementHost.ts';
import type { OpenCodeManagementProfile } from '../src/adapters/providers/OpenCodeManagementHost.ts';
import type { CapturedProcessLaunch } from '../src/adapters/providers/CapturedProcess.ts';

class ControlledChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [
    this.stdin,
    this.stdout,
    this.stderr,
    undefined,
    undefined,
  ];
}

test('derived V1 owners finish original reads and preserve pending OAuth before reusing an endpoint', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v1-endpoint-')));
  const path = join(root, 'TEST-native'), bytes = '#!/bin/sh\nexit 0\n';
  writeFileSync(path, bytes, { mode: 0o700 });
  const otherData = join(root, 'other-data');
  mkdirSync(otherData);
  const profile: OpenCodeManagementProfile = {
    provider: 'opencode', profileId: 'TEST-global', configRevision: 'TEST-global-revision',
    accountBinding: 'TEST-global-account', cwd: root, endpoint: 'http://127.0.0.1:14567', timeoutMs: 1000,
    executable: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(key => [key, root])),
  };
  const other = { ...profile, profileId: 'TEST-project', configRevision: 'TEST-project-revision',
    accountBinding: 'TEST-project-account', timeoutMs: 2000,
    environment: { ...profile.environment, XDG_DATA_HOME: otherData } };
  const runs: OpenCodeManagementHost[] = [], closed = new Set<OpenCodeManagementHost>();
  let clock = Date.now(), gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let entered = Promise.withResolvers<void>(), callbacks = 0;
  t.mock.method(Date, 'now', () => clock);
  const factory = new OpenCodeClientFactory({ fetchImpl: async input => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/provider') return Response.json({ all: [], default: {}, connected: [] });
    if (path === '/config/providers') return Response.json({ providers: [], default: {} });
    if (path === '/config') return Response.json({});
    if (path === '/provider/auth') return Response.json({ 'TEST-oauth': [{ type: 'oauth', label: 'TEST code' }] });
    if (path.endsWith('/oauth/authorize')) return Response.json({ url: 'https://TEST.invalid/code', method: 'code', instructions: 'TEST instructions' });
    assert.ok(path.endsWith('/oauth/callback'));
    callbacks++;
    return Response.json(true);
  } });
  t.mock.method(OpenCodeManagementHost.prototype, 'run', async function<T>(
    this: OpenCodeManagementHost, action: (client: OpenCodeManagementClient) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    runs.push(this); entered.resolve();
    await gate?.promise;
    options.signal?.throwIfAborted();
    assert.equal(closed.has(this), false, 'a pending read retains its original host');
    const result = await action(factory.create(profile.endpoint, {
      signal: options.signal ?? new AbortController().signal, remainingMs: () => options.timeoutMs ?? 1000,
    }));
    assert.equal(closed.has(this), false);
    return result;
  });
  t.mock.method(OpenCodeManagementHost.prototype, 'close', async function(this: OpenCodeManagementHost) {
    closed.add(this); return true;
  });
  const owner = new ProviderManagementCoordinator([profile, other], () => {}, root);
  const a = { profileId: profile.profileId, configRevision: profile.configRevision };
  const b = { profileId: other.profileId, configRevision: other.configRevision };
  const waitPhase = async (operationId: string, phase: string) => {
    for (let count = 0; count < 100; count++) {
      if (owner.oauth.read({ ...a, operationId })?.phase === phase) return;
      await new Promise<void>(done => setImmediate(done));
    }
    assert.fail(`Original OAuth did not reach ${phase}`);
  };
  try {
    gate = Promise.withResolvers<void>();
    const first = owner.catalog(a);
    await entered.promise;
    const second = owner.catalog(b);
    await Promise.resolve();
    assert.equal(runs.length, 1);
    assert.equal(closed.size, 0);
    gate.resolve(); gate = undefined;
    assert.deepEqual((await Promise.all([first, second])).map(row => row.profileId), [a.profileId, b.profileId]);
    assert.ok(closed.has(runs[0]!));
    assert.notEqual(runs[0], runs[1]);

    owner.oauth.start({ ...a, operationId: 'TEST-original-code', providerId: 'TEST-oauth', methodIndex: 0 });
    await waitPhase('TEST-original-code', 'waiting-for-code');
    const original = runs.at(-1)!, count = runs.length;
    await assert.rejects(owner.catalog(b), /busy/, 'the occupied old namespace is protected even when B has another auth root');
    await assert.rejects(owner.catalog(a), /busy/, 'metadata cannot race the active command close/release gap');
    assert.equal(runs.length, count);
    assert.equal(closed.has(original), false);
    owner.oauth.complete({ ...a, operationId: 'TEST-original-code', commandId: 'TEST-submit', code: 'TEST-code' });
    await waitPhase('TEST-original-code', 'completed');
    assert.equal(runs.at(-1), original);
    assert.equal(callbacks, 1);
    await owner.catalog(b);
    assert.ok(closed.has(original));

    owner.oauth.start({ ...a, operationId: 'TEST-cancel-code', providerId: 'TEST-oauth', methodIndex: 0 });
    await waitPhase('TEST-cancel-code', 'waiting-for-code');
    const cancelled = runs.at(-1)!;
    gate = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>();
    owner.oauth.complete({ ...a, operationId: 'TEST-cancel-code', commandId: 'TEST-cancel-submit', code: 'TEST-code' });
    await entered.promise;
    const afterCancel = owner.catalog(b);
    assert.equal((await owner.oauth.cancel({ ...a, operationId: 'TEST-cancel-code' })).phase, 'cancelled');
    assert.ok(closed.has(cancelled), 'control cleanup does not wait for the endpoint work queue');
    gate.resolve(); gate = undefined;
    await afterCancel;
    assert.equal(callbacks, 1, 'a cancelled queued callback cannot submit');

    gate = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>();
    const active = owner.catalog(b);
    await entered.promise;
    const beforeExpired = runs.length;
    const expired = assert.rejects(owner.catalog(a), /held/);
    clock += profile.timeoutMs;
    gate.resolve(); gate = undefined;
    await active; await expired;
    assert.equal(runs.length, beforeExpired, 'queue wait consumes the original deadline before allocation');
  } finally {
    gate?.resolve();
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('V1 endpoint handoff retains unknown cleanup and rechecks revocation after original close', async t => {
  for (const mode of ['unknown', 'revoked'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v1-handoff-refusal-')));
    const path = join(root, 'TEST-native'), bytes = '#!/bin/sh\nexit 0\n';
    writeFileSync(path, bytes, { mode: 0o700 });
    const profile: OpenCodeManagementProfile = {
      provider: 'opencode', profileId: 'TEST-old', configRevision: 'TEST-revision', accountBinding: 'TEST-account',
      cwd: root, endpoint: 'http://127.0.0.1:14567', timeoutMs: 1000,
      executable: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
      environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(key => [key, root])),
    };
    const other = { ...profile, profileId: 'TEST-new' };
    const seen: OpenCodeManagementHost[] = [], closes: OpenCodeManagementHost[] = [];
    const closing = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let current = true;
    const run = t.mock.method(OpenCodeManagementHost.prototype, 'run', async function(this: OpenCodeManagementHost) {
      seen.push(this); return { profileId: profile.profileId, configRevision: profile.configRevision, providers: [] };
    });
    const close = t.mock.method(OpenCodeManagementHost.prototype, 'close', async function(this: OpenCodeManagementHost) {
      closes.push(this); entered.resolve();
      if (mode === 'revoked') await closing.promise;
      return mode === 'revoked';
    });
    const owner = new ProviderManagementCoordinator([profile, other], () => {
      if (!current) throw new Error('TEST authority revoked');
    }, root);
    try {
      await owner.catalog({ profileId: profile.profileId, configRevision: profile.configRevision });
      const input = { profileId: other.profileId, configRevision: other.configRevision };
      const refused = assert.rejects(owner.catalog(input), mode === 'unknown' ? /held/ : /revoked/);
      await entered.promise;
      if (mode === 'revoked') { current = false; closing.resolve(); }
      await refused;
      if (mode === 'unknown') await assert.rejects(owner.catalog(input), /held/);
      assert.equal(seen.length, 1, 'no replacement work after unknown cleanup or lost authority');
      assert.ok(closes.length > 0 && closes.every(host => host === seen[0]));
    } finally {
      closing.resolve();
      await owner.close().catch(() => {});
      run.mock.restore(); close.mock.restore();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function fixture(
  options: {
    wrongConfig?: boolean;
    cleanupFails?: boolean;
    providerMetadataInConfigOnly?: boolean;
    modelMetadata?: Record<string, unknown>;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-opencode-management-')));
  const env: Record<string, string> = {};
  for (const [key, directory] of Object.entries({
    HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
  })) {
    env[key] = join(root, directory);
    mkdirSync(env[key]!);
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...(options.providerMetadataInConfigOnly
      ? {
          provider: {
            'TEST-local': {
              npm: '@ai-sdk/openai-compatible',
              options: { apiKey: 'TEST-must-stay-private', baseURL: 'http://127.0.0.1:1' },
            },
          },
        }
      : {}),
    agent: { 'TEST-preserved': { prompt: 'TEST user instructions', hidden: false } },
  });
  const profile: OpenCodeManagementProfile = {
    provider: 'opencode',
    profileId: 'TEST-profile',
    accountBinding: 'TEST-account',
    configRevision: 'TEST-revision',
    cwd: root,
    environment: env,
    endpoint: 'http://127.0.0.1:14567',
    timeoutMs: 1000,
    executable: { path: '/TEST-controlled-executable', sha256: 'a'.repeat(64) },
  };
  let running = false,
    current = true,
    allocate = true,
    sealed = false,
    stops = 0;
  let config: unknown;
  let authorization = '';
  const calls: { path: string; method: string; body: string }[] = [];
  const launches: CapturedProcessLaunch[] = [];
  let beforeReply = () => {};
  let fail = false;
  const host = new OpenCodeManagementHost(
    profile,
    {
      canAllocate: () => allocate,
      isCurrent: () => current,
    },
    {
      createProcess(captured, canAllocate) {
        assert.equal(captured.accountBinding, profile.accountBinding);
        config = JSON.parse(captured.environment.OPENCODE_CONFIG_CONTENT!);
        authorization =
          'Basic ' +
          Buffer.from(`opencode:${captured.environment.OPENCODE_SERVER_PASSWORD}`).toString(
            'base64'
          );
        assert.equal(captured.environment.OPENCODE_SERVER_USERNAME, 'opencode');
        return {
          launch(request) {
            assert.ok(canAllocate() && !sealed);
            launches.push(request);
            running = true;
            return new ControlledChild();
          },
          seal() {
            sealed = true;
          },
          isRunning: () => running,
          async confirmStopped() {
            stops++;
            running = false;
            return !options.cleanupFails;
          },
        };
      },
      async fetchImpl(input, init) {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, profile.endpoint);
        assert.equal(request.headers.get('authorization'), authorization);
        assert.equal(request.headers.get('x-opencode-directory'), profile.cwd);
        assert.equal(request.redirect, 'error');
        const path = new URL(request.url).pathname;
        calls.push({ path, method: request.method, body: await request.text() });
        assert.ok(!path.startsWith('/session'), 'management never creates a conversation');
        if (fail) throw new Error('TEST-private-api-key-should-not-escape');
        let response: unknown = true;
        if (path === '/config') response = options.wrongConfig ? { agent: {} } : config;
        const provider = {
          id: 'TEST-local',
          name: 'TEST provider',
          source: 'config',
          ...(options.providerMetadataInConfigOnly
            ? {}
            : { options: { apiKey: 'TEST-must-stay-private', baseURL: 'http://127.0.0.1:1' } }),
          models: {
            'TEST-model': {
              name: 'TEST model',
              limit: { context: 4096, output: 1024 },
              privateExtra: 'TEST-must-stay-private',
              ...options.modelMetadata,
            },
          },
        };
        if (path === '/provider') response = { all: [provider], connected: [] };
        if (path === '/config/providers') response = { providers: [provider], default: {} };
        if (path === '/provider/auth')
          response = { 'TEST-local': [{ type: 'api', label: 'TEST API key' }] };
        if (path.endsWith('/oauth/authorize'))
          response = {
            url: 'https://TEST.invalid/login',
            method: 'code',
            instructions: 'TEST instructions',
          };
        beforeReply();
        return Response.json(response);
      },
    }
  );
  return {
    host,
    profile,
    launches,
    calls,
    stopCount: () => stops,
    config: () => config as Record<string, unknown>,
    changeConfig: () => {
      config = { agent: {} };
    },
    revoke: () => {
      current = false;
    },
    denyAllocation: () => {
      allocate = false;
    },
    revokeOnReply: () => {
      beforeReply = () => {
        current = false;
      };
    },
    failRequests: () => {
      fail = true;
    },
    replaceDataDirectory() {
      renameSync(env.XDG_DATA_HOME!, join(root, 'old-data'));
      mkdirSync(env.XDG_DATA_HOME!);
    },
    async cleanup() {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('catalog and auth use captured native profile, without Session SPI or ambient credentials', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  await Promise.all([f.host.start(), f.host.start()]);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0]?.args, ['serve', '--hostname', '127.0.0.1', '--port', '14567']);
  assert.deepEqual((f.config().agent as Record<string, unknown>)['TEST-preserved'], {
    prompt: 'TEST user instructions',
    hidden: false,
  });
  await f.host.run(async (client) => {
    assert.equal('createSession' in client, false);
    assert.equal((await client.getProviders()).all?.[0]?.id, 'TEST-local');
    assert.equal((await client.getProviderAuth())['TEST-local']?.[0]?.type, 'api');
    assert.equal(
      await client.setProviderAuth('TEST-local', { type: 'api', key: 'TEST-dummy' }),
      true
    );
    assert.equal((await client.authorizeProviderOAuth('TEST-local', { method: 0 })).method, 'code');
    assert.equal(
      await client.completeProviderOAuth('TEST-local', { method: 0, code: 'TEST-code' }),
      true
    );
    assert.equal(await client.deleteProviderAuth('TEST-local'), true);
  });
  const binding = { profileId: f.profile.profileId, configRevision: f.profile.configRevision };
  const summary = await f.host.run((client) => readOpenCodeCatalog(client, binding));
  assert.equal(summary.providers[0]?.modelCount, 1);
  assert.deepEqual(summary.providers[0]?.models, []);
  const models = await f.host.run((client) => readOpenCodeCatalog(client, binding, 'TEST-local'));
  assert.deepEqual(models.providers[0]?.models, [
    {
      modelId: 'TEST-model',
      displayName: 'TEST model',
      contextTokens: 4096,
      outputTokens: 1024,
      free: null,
      declaredInputModalities: null,
    },
  ]);
  assert.equal(JSON.stringify([summary, models]).includes('TEST-must-stay-private'), false);
  assert.ok(f.calls.some((c) => c.path === '/auth/TEST-local' && c.method === 'PUT'));
  assert.ok(f.calls.some((c) => c.path === '/auth/TEST-local' && c.method === 'DELETE'));
  assert.equal(await f.host.close(), true);
  assert.equal(await f.host.close(), true);
  assert.equal(f.stopCount(), 1);
  await assert.rejects(f.host.start(), { code: 'unavailable' });
  assert.equal(f.launches.length, 1);
});

test('status and sessions cannot bind one captured account to different native credential namespaces', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.doesNotThrow(() => assertAccountNamespaces([f.profile, structuredClone(f.profile)]));
  const changed = {
    ...f.profile,
    environment: { ...f.profile.environment, XDG_DATA_HOME: '/TEST-another-account' },
  };
  assert.throws(() => assertAccountNamespaces([f.profile, changed]), { code: 'invalid-profile' });
  assert.doesNotThrow(() =>
    assertAccountNamespaces([f.profile, { ...changed, accountBinding: 'TEST-other-account' }])
  );
});

test('allocation denied or close before start cannot create a native process', async (t) => {
  for (const closed of [false, true]) {
    const f = fixture();
    t.after(() => f.cleanup());
    if (closed) await f.host.close();
    else f.denyAllocation();
    await assert.rejects(f.host.start(), { code: 'unavailable' });
    assert.equal(f.launches.length, 0);
  }
});

test('foreign effective config is refused and cleanup uncertainty stays held', async (t) => {
  for (const cleanupFails of [false, true]) {
    const f = fixture({ wrongConfig: true, cleanupFails });
    t.after(() => f.cleanup());
    await assert.rejects(f.host.start(), { code: cleanupFails ? 'held' : 'profile-changed' });
    assert.equal(f.stopCount(), 1);
    assert.equal(await f.host.close(), !cleanupFails);
    assert.equal(
      f.calls.some((c) => c.path !== '/config'),
      false
    );
  }
});

test('changed native config or replaced namespace cannot authorize an auth mutation', async (t) => {
  for (const replaceDirectory of [false, true]) {
    const f = fixture();
    t.after(() => f.cleanup());
    await f.host.start();
    if (replaceDirectory) f.replaceDataDirectory();
    else f.changeConfig();
    await assert.rejects(
      f.host.run((client) => client.deleteProviderAuth('TEST-local')),
      { code: 'profile-changed' }
    );
    assert.equal(
      f.calls.some((c) => c.path.startsWith('/auth/')),
      false
    );
  }
});

test('late response after authority revocation is refused and errors never expose credentials', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  await f.host.start();
  f.revokeOnReply();
  await assert.rejects(
    f.host.run((client) => client.getProviders()),
    { code: 'unavailable' }
  );
  const g = fixture();
  t.after(() => g.cleanup());
  await g.host.start();
  g.failRequests();
  await assert.rejects(
    g.host.run((client) => client.getProviders()),
    (error: unknown) => {
      assert.equal((error as Error).message.includes('TEST-private'), false);
      assert.equal((error as { code: string }).code, 'unavailable');
      return true;
    }
  );
});

test('official native catalog may omit custom npm/options; effective config still establishes the local route without exposing config', async (t) => {
  const f = fixture({ providerMetadataInConfigOnly: true });
  t.after(() => f.cleanup());
  const result = await f.host.run((client) =>
    readOpenCodeCatalog(
      client,
      { profileId: f.profile.profileId, configRevision: f.profile.configRevision },
      'TEST-local'
    )
  );
  assert.equal(result.providers[0]?.configuredAuthless, true);
  assert.equal(JSON.stringify(result).includes('TEST-must-stay-private'), false);
  assert.equal(JSON.stringify(result).includes('baseURL'), false);
});

test('native input declarations survive the bounded safe management catalog', async (t) => {
  const f = fixture({
    modelMetadata: { capabilities: { input: { text: true, image: true, video: true } } },
  });
  t.after(() => f.cleanup());
  const result = await f.host.run((client) =>
    readOpenCodeCatalog(
      client,
      { profileId: f.profile.profileId, configRevision: f.profile.configRevision },
      'TEST-local'
    )
  );
  assert.deepEqual(result.providers[0]?.models[0]?.declaredInputModalities, [
    'image',
    'text',
    'video',
  ]);
  assert.equal(JSON.stringify(result).includes('TEST-must-stay-private'), false);
});
