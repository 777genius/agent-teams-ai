import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { createOpenCodeV2EmbeddedServer } from '../dist/adapters/providers/OpenCodeV2EmbeddedServer.js';
import { createOpenCodeV2CredentialClient, createOpenCodeV2OwnedSessionClient } from '@agent-teams/provider-implementations/opencode';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { captureOpenCodeV2Configuration } from '../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js';
import { openCodeV2NoToolConfig } from '../dist/adapters/providers/OpenCodeV2EmbeddedConfig.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';
import type { AcceptedOpenCodeV2FileKey } from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';

const directory = process.env.OPENCODE_V2_EMBEDDED_TEST_GRAPH;
const bun = process.env.OPENCODE_V2_EMBEDDED_TEST_BUN;

test(
  'pinned embedded engine starts privately, reports actual custody and closes its owned process group',
  {
    skip: !directory || !bun || process.platform !== 'linux' || process.arch !== 'x64',
    timeout: 180_000,
  },
  async (t) => {
    const deadline = Date.now() + 180_000;
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-stage1-embedded-v2-'));
    const folder = (name: string) => path.join(root, name);
    for (const part of ['workspace', 'home', 'config', 'data', 'state', 'cache', 'temp'])
      await mkdir(folder(part));
    await writeFile(
      path.join(folder('workspace'), '.env'),
      'OPENCODE_SERVER_PASSWORD=TEST-ambient-secret\n'
    );
    await writeFile(
      path.join(folder('workspace'), 'bunfig.toml'),
      'preload = ["./TEST-untrusted-preload.ts"]\n'
    );
    await writeFile(
      path.join(folder('workspace'), 'TEST-untrusted-preload.ts'),
      'throw new Error("ambient preload executed");\n'
    );
    await writeFile(
      path.join(folder('home'), '.bunfig.toml'),
      `preload = [${JSON.stringify(path.join(folder('workspace'), 'TEST-untrusted-preload.ts'))}]\n`
    );
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    assert.ok(address && typeof address === 'object');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve()))
    );
    const nativeProfile: Parameters<typeof createOpenCodeV2EmbeddedServer>[0]['profile'] = {
        provider: 'opencode',
        cwd: folder('workspace'),
        executable: {
          path: bun!,
          sha256: '6d5bb405b1d037a2a466b92757de7e47e4369930fa94bd42f8ff44ba49de6c57',
        },
        environment: {
          PATH: '/usr/bin:/bin',
          HOME: folder('home'),
          XDG_CONFIG_HOME: folder('config'),
          XDG_DATA_HOME: folder('data'),
          XDG_STATE_HOME: folder('state'),
          XDG_CACHE_HOME: folder('cache'),
          TMPDIR: folder('temp'),
          NO_COLOR: '1',
          OPENCODE_SERVER_PASSWORD: 'TEST-forbidden-env-password',
        },
      };
    const embedded: Parameters<typeof createOpenCodeV2EmbeddedServer>[0]['embedded'] = {
        directory: directory!,
        manifestSha256: '840d7cc145155e0ad97a407af87eb347da1a9cbf034d19c632897e1a5efbff9b',
        version: '2.1.4',
        platform: 'linux',
        arch: 'x64',
      };
    const relativeKey = path.join(folder('workspace'), 'TEST-relative.key');
    await writeFile(relativeKey, 'TEST-', { mode: 0o600 });
    await writeFile(path.join(folder('home'), 'TEST-home.key'), 'native-', { mode: 0o600 });
    const absoluteKey = path.join(root, 'TEST-absolute.key');
    await writeFile(absoluteKey, 'private-key', { mode: 0o600 });
    await writeFile(path.join(folder('workspace'), 'opencode.json'), JSON.stringify({
      provider: { 'TEST-provider': { npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://127.0.0.1:9/v1',
          apiKey: `{file:TEST-relative.key}{file:~/TEST-home.key}{file:${absoluteKey}}` },
        models: { 'TEST-model': { name: 'TEST native source model', limit: { context: 32768, output: 64 } } },
      } },
    }), { mode: 0o600 });
    const management = openCodeManagementProfileSchema.parse({ ...nativeProfile,
      profileId: 'TEST-source-profile', configRevision: 'TEST-source-revision', accountBinding: 'TEST-source-account',
      nativeGeneration: 'v2', protocolRevision: '2.1.4', endpoint, embedded: { ...embedded, externalDirectory: 'deny' },
      nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
    });
    management.embedded!.configurationSource = captureOpenCodeConfigurationSource(management).reference;
    const configuration = captureOpenCodeV2Configuration(management, management.nativeModel!, () => true);
    const server = createOpenCodeV2EmbeddedServer({
      profile: nativeProfile,
      embedded,
      configDirectory: folder('config'),
      databasePath: path.join(folder('data'), 'engine.sqlite'),
      config: { ...openCodeV2NoToolConfig(management, configuration.configuration).config,
        permission: { external_directory: 'deny' } },
      ...(configuration.selectedFile ? { selectedFile: { source: configuration.selectedFile, mode: 'fresh' as const } } : {}),
      canAllocate: () => true,
      endpoint,
    });
    let cleanup = false, failed = false, primary: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      assert.ok(configuration.selectedFile);
      assert.equal(configuration.key, undefined, 'the parent never materializes the manual source');
      const ready = await server.start();
      assert.equal(ready.endpoint, endpoint);
      assert.equal(server.isOriginalLive(ready), true);
      assert.equal(server.isOriginalLive({ ...ready }), false, 'only the nonce-checked original ready object is accepted');
      assert.deepEqual(await server.start(), ready, 'startup is not repeated');
      const unauthorized = await fetch(`${ready.endpoint}/api/session`);
      assert.equal(unauthorized.status, 401);
      const authenticated = await fetch(`${ready.endpoint}/api/session`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${server.readPassword()}`).toString('base64')}`,
        },
      });
      assert.equal(authenticated.status, 200);
      const sessions = (await authenticated.json()) as { data: unknown[] };
      assert.deepEqual(sessions.data, []);
      const info = await fetch(`${ready.endpoint}/api/info`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${server.readPassword()}`).toString('base64')}`,
        },
      });
      assert.equal(info.status, 200);
      const metadata = (await info.json()) as { version: string; pid: number };
      assert.equal(metadata.version, '2.1.4');
      assert.equal(metadata.pid, ready.pid);
      const custody = await server.readNativeCustody(new AbortController().signal);
      assert.equal(custody?.executablePath, bun);
      assert.equal(custody?.pid, ready.pid);
      assert.equal(custody?.startIdentity, ready.startIdentity);
      assert.equal(custody?.version, '2.1.4');
      const environment = await readFile(`/proc/${ready.pid}/environ`, 'utf8');
      assert.equal(environment.includes(server.readPassword()), false);
      assert.equal(environment.includes('TEST-forbidden-env-password'), false);
      assert.equal(environment.includes('TEST-ambient-secret'), false);
      assert.equal((await stat(path.join(folder('data'), 'engine.sqlite'))).isFile(), true);
      const requests: string[] = [];
      const countedFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init), url = new URL(request.url);
        requests.push(request.method + ' ' + url.pathname);
        assert.ok(requests.length <= 12, 'only the twelve original selected-source qualification requests');
        return fetch(request);
      };
      const denied = await countedFetch(`${endpoint}/api/integration/TEST-provider/connect/key?${
        new URLSearchParams({ 'location[directory]': management.cwd })}`, {
        method: 'POST', signal: t.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedSource: { schemaVersion: 1, reference: 'a'.repeat(64),
          deadline: Math.min(deadline, Date.now() + 30000) } }),
      });
      assert.equal(denied.status, 401);
      await denied.arrayBuffer();
      const transport = { endpoint, directory: management.cwd, version: '2.1.4' as const,
        signal: t.signal, deadline, readPassword: server.readPassword, fetchImpl: countedFetch,
        beforeRequest: async (signal: AbortSignal) => {
          signal.throwIfAborted(); assert.ok(Date.now() < deadline && server.isOriginalLive(ready));
          const actual = await server.readNativeCustody(signal);
          assert.equal(actual?.pid, ready.pid); assert.equal(actual?.startIdentity, ready.startIdentity);
          assert.ok(configuration.isCurrent() && server.isOriginalLive(ready));
          return () => { assert.ok(server.isOriginalLive(ready)); };
        } };
      const owner = createOpenCodeV2OwnedSessionClient({ ...transport, nativeSessionId: 'ses_TEST' });
      let keyClient: ReturnType<typeof createOpenCodeV2CredentialClient> | undefined;
      const proofState: { accepted?: AcceptedOpenCodeV2FileKey } = {};
      try {
        const catalog = await owner.readCatalog('TEST-provider');
        assert.ok(catalog.provider);
        assert.equal(catalog.provider.id, 'TEST-provider');
        assert.equal(catalog.provider.integrationId, undefined);
        const directory = await owner.readDirectory();
        const matching = directory.integrations.filter(row => row.id === 'TEST-provider');
        assert.equal(matching.length, 1, 'the original native directory supplies the same-ID relation');
        const integrationId = matching[0]!.id, source = server.selectedFileKey(ready, integrationId);
        keyClient = createOpenCodeV2CredentialClient({ ...transport, integrationId });
        const accept = (proof: Parameters<typeof source.acceptProof>[0]): undefined => {
          const current = source.acceptProof(proof);
          if (proofState.accepted) assert.equal(current.scopeDigest, proofState.accepted.scopeDigest);
          proofState.accepted = current; return undefined;
        };
        const connected = await keyClient.connectSelectedSource(source.reference, accept);
        assert.ok(proofState.accepted && proofState.accepted.filesCurrent());
        assert.equal(JSON.stringify(JSON.parse(Buffer.from(proofState.accepted.encoded, 'base64url').toString('utf8')))
          .includes('TEST-native-private-key'), false, 'the private proof carries no secret bytes');
        const retained = await keyClient.readSelectedSource(source.reference, accept);
        assert.equal(retained.connections.length, 1);
        assert.equal(retained.connections[0]?.type, 'credential');
        assert.equal(retained.connections[0]?.id, connected.credentialId);
        const catalogReads = ['GET /api/provider', 'GET /api/model', 'GET /api/model/default'];
        const integrationRead = 'GET /api/integration/' + integrationId;
        assert.deepEqual(requests, ['POST /api/integration/TEST-provider/connect/key',
          ...catalogReads, ...catalogReads, 'GET /api/integration', integrationRead,
          `POST /api/integration/${integrationId}/connect/key`, integrationRead, integrationRead]);
        assert.equal(requests.length + 3, 15, 'the original session/session/info calls remain separate and unchanged');
      } finally {
        try { await keyClient?.dispose(); } finally { await owner.dispose(); }
      }
      cleanup = await server.stopOwned();
      assert.equal(cleanup, true);
      assert.equal(server.isOriginalLive(ready), false, 'Stop revokes the original read-only lifetime capture');
      assert.equal(await server.confirmStopped(), true);
      assert.equal(await server.readNativeCustody(new AbortController().signal), undefined);
      assert.throws(() => process.kill(-ready.pid, 0), { code: 'ESRCH' });
      assert.ok(proofState.accepted?.filesCurrent(), 'post-close source revalidation creates no new native owner');
      await writeFile(relativeKey, 'TEST-changed-', { mode: 0o600 });
      assert.equal(proofState.accepted.filesCurrent(), false, 'the original delegated dependency cannot authorize changed bytes');
    } catch (error) { failed = true; primary = error; }
    finally {
      cleanup = false;
      // Reuse the original single-flight stop even after an early assertion/fetch failure.
      try { await server.stopOwned(); } catch (error) { cleanupErrors.push(error); }
      try { cleanup = await server.confirmStopped(); } catch (error) { cleanupErrors.push(error); }
      if (!cleanup) cleanupErrors.push(new Error('physical child cleanup must be confirmed'));
      if (cleanup) try { await rm(root, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (failed && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'Native proof and cleanup failed');
    if (failed) throw primary;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Native proof cleanup failed');
  }
);
