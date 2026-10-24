import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { readOpenCodeCatalog } from '../dist/adapters/providers/readOpenCodeCatalog.js';
import { assertAccountNamespaces } from '../dist/composition/assertAccountNamespaces.js';
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

function fixture(
  options: {
    wrongConfig?: boolean;
    cleanupFails?: boolean;
    providerMetadataInConfigOnly?: boolean;
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
