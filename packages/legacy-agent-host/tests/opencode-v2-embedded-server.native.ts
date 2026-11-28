import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import {
  createOpenCodeV2CredentialClient,
  createOpenCodeV2OwnedSessionClient,
} from '@agent-teams/provider-implementations/opencode';
import type { AcceptedOpenCodeV2FileKey } from '../dist/adapters/providers/OpenCodeV2SelectedFileKey.js';

import { fileHash } from './fixtures/native-host.ts';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';

const go = process.env.OPENCODE_V2_EMBEDDED_SERVER_GO === '1';

test(
  'pinned embedded engine starts privately, reports actual custody and closes its owned process group',
  {
    skip: !go,
    timeout: 180_000,
  },
  async (t) => {
    assert.equal(process.version, 'v24.21.0');
    assert.equal(`${process.platform}-${process.arch}`, 'linux-x64');
    assert.equal(process.env.OPENCODE_V2_TEST_PLATFORM, 'linux-x64');
    const directory = process.env.OPENCODE_V2_EMBEDDED_GRAPH;
    const bun = process.env.OPENCODE_V2_EMBEDDED_BUN;
    const bunSha256 = process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256;
    const manifestSha256 = process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256;
    const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
    assert.ok(
      directory && bun && bunSha256 && manifestSha256 && sourceHead,
      'Explicit native GO requires the complete original input tuple'
    );
    assert.ok(path.isAbsolute(directory) && path.isAbsolute(bun));
    assert.equal(await realpath(directory), directory);
    assert.equal(await realpath(bun), bun);
    assert.ok((await lstat(directory)).isDirectory() && (await lstat(bun)).isFile());
    const repo = path.resolve(import.meta.dirname, '../../..');
    const lock = JSON.parse(await readFile(path.join(repo, 'runtime.lock.json'), 'utf8'));
    const delivery = lock.opencodeV2Delivery?.['linux-x64'];
    assert.equal(lock.version, '0.0.161');
    assert.equal(delivery?.requiredBunVersion, '1.3.11');
    assert.equal(manifestSha256, delivery.manifest.sha256);
    assert.equal(bunSha256, '45598a2814020c231575487a560e47d397d6902355d7e08171a2e56221a6d675');
    assert.equal(await fileHash(bun), bunSha256);
    assert.equal(
      await fileHash(path.join(directory, 'opencode-v2-engine-manifest.json')),
      manifestSha256
    );
    assert.equal(
      (await readFile(path.resolve(bun, '../../COMMIT_SHA'), 'utf8')).trim(),
      delivery.sourceCommit
    );
    assert.equal(
      execFileSync(bun, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
      delivery.requiredBunVersion
    );
    const sourceBuild = await buildNativeV1Host(repo, sourceHead);
    // Import only after the exact-source build; a prior emitted module cannot qualify this run.
    const { createOpenCodeV2EmbeddedServer } =
      await import('../dist/adapters/providers/OpenCodeV2EmbeddedServer.js');
    const { captureOpenCodeConfigurationSource } =
      await import('../dist/adapters/providers/OpenCodeConfigurationSource.js');
    const { captureOpenCodeV2Configuration } =
      await import('../dist/adapters/providers/OpenCodeV2CapturedConfiguration.js');
    const { openCodeV2NoToolConfig } =
      await import('../dist/adapters/providers/OpenCodeV2EmbeddedConfig.js');
    const { openCodeManagementProfileSchema } = await import('../dist/management/profile.js');
    const deadline = Date.now() + 180_000;
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-stage1-embedded-v2-'));
    let setupOnly = true;
    t.after(async () => {
      if (setupOnly) await rm(root, { recursive: true, force: true });
    });
    const folder = (name: string) => path.join(root, name);
    for (const part of [
      'workspace',
      'home',
      'config',
      'data',
      'state',
      'cache',
      'temp',
      'engine-config',
      'engine-data',
    ])
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
        path: bun,
        sha256: bunSha256,
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
      directory,
      manifestSha256,
      version: '2.1.4',
      platform: 'linux',
      arch: 'x64',
    };
    const relativeKey = path.join(folder('workspace'), 'TEST-relative.key');
    await writeFile(relativeKey, 'TEST-', { mode: 0o600 });
    await writeFile(path.join(folder('home'), 'TEST-home.key'), 'native-', { mode: 0o600 });
    const absoluteKey = path.join(root, 'TEST-absolute.key');
    await writeFile(absoluteKey, 'private-key', { mode: 0o600 });
    await writeFile(
      path.join(folder('workspace'), 'opencode.json'),
      JSON.stringify({
        provider: {
          'TEST-provider': {
            npm: '@ai-sdk/openai-compatible',
            options: {
              baseURL: 'http://127.0.0.1:9/v1',
              apiKey: `{file:TEST-relative.key}{file:~/TEST-home.key}{file:${absoluteKey}}`,
            },
            models: {
              'TEST-model': {
                name: 'TEST native source model',
                limit: { context: 32768, output: 64 },
              },
            },
          },
        },
      }),
      { mode: 0o600 }
    );
    const management = openCodeManagementProfileSchema.parse({
      ...nativeProfile,
      profileId: 'TEST-source-profile',
      configRevision: 'TEST-source-revision',
      accountBinding: 'TEST-source-account',
      timeoutMs: 10_000,
      nativeGeneration: 'v2',
      protocolRevision: '2.1.4',
      endpoint,
      embedded: { ...embedded, externalDirectory: 'deny' },
      nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
    });
    management.embedded!.configurationSource =
      captureOpenCodeConfigurationSource(management).reference;
    const configuration = captureOpenCodeV2Configuration(
      management,
      management.nativeModel!,
      () => true
    );
    const server = createOpenCodeV2EmbeddedServer({
      profile: nativeProfile,
      embedded,
      configDirectory: folder('engine-config'),
      databasePath: path.join(folder('engine-data'), 'engine.sqlite'),
      config: {
        ...openCodeV2NoToolConfig(management, configuration.configuration).config,
        permission: { external_directory: 'deny' },
      },
      ...(configuration.selectedFile
        ? { selectedFile: { source: configuration.selectedFile, mode: 'fresh' as const } }
        : {}),
      canAllocate: () => true,
      endpoint,
    });
    let cleanup = false,
      failed = false,
      primary: unknown;
    const cleanupErrors: unknown[] = [];
    const requests: string[] = [];
    try {
      assert.ok(configuration.selectedFile);
      assert.equal(configuration.key, undefined, 'the parent never materializes the manual source');
      setupOnly = false;
      const ready = await server.start();
      assert.equal(ready.endpoint, endpoint);
      assert.equal(server.isOriginalLive(ready), true);
      assert.equal(
        server.isOriginalLive({ ...ready }),
        false,
        'only the nonce-checked original ready object is accepted'
      );
      assert.deepEqual(await server.start(), ready, 'startup is not repeated');
      assert.ok(
        configuration.isCurrent(),
        'private native startup preserves the captured donor source'
      );
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
      assert.equal((await stat(path.join(folder('engine-data'), 'engine.sqlite'))).isFile(), true);
      let repeatedReadPhase = false;
      const countedFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init),
          url = new URL(request.url);
        requests.push(request.method + ' ' + url.pathname);
        assert.ok(
          requests.length <= (repeatedReadPhase ? 14 : 12),
          'the original twelve selected-source requests and two explicit repeated reads only'
        );
        return fetch(request);
      };
      const denied = await countedFetch(
        `${endpoint}/api/integration/TEST-provider/connect/key?${new URLSearchParams({
          'location[directory]': management.cwd,
        })}`,
        {
          method: 'POST',
          signal: t.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            selectedSource: {
              schemaVersion: 1,
              reference: 'a'.repeat(64),
              deadline: Math.min(deadline, Date.now() + 30000),
            },
          }),
        }
      );
      assert.equal(denied.status, 401);
      await denied.arrayBuffer();
      const transport = {
        endpoint,
        directory: management.cwd,
        version: '2.1.4' as const,
        signal: t.signal,
        deadline,
        readPassword: server.readPassword,
        fetchImpl: countedFetch,
        beforeRequest: async (signal: AbortSignal) => {
          signal.throwIfAborted();
          assert.ok(Date.now() < deadline && server.isOriginalLive(ready));
          const actual = await server.readNativeCustody(signal);
          assert.equal(actual?.pid, ready.pid);
          assert.equal(actual?.startIdentity, ready.startIdentity);
          assert.ok(configuration.isCurrent() && server.isOriginalLive(ready));
          return () => {
            assert.ok(server.isOriginalLive(ready));
          };
        },
      };
      const owner = createOpenCodeV2OwnedSessionClient({
        ...transport,
        nativeSessionId: 'ses_TEST',
      });
      let keyClient: ReturnType<typeof createOpenCodeV2CredentialClient> | undefined;
      const proofState: { accepted?: AcceptedOpenCodeV2FileKey } = {};
      try {
        const catalog = await owner.readCatalog('TEST-provider');
        assert.ok(catalog.provider);
        assert.equal(catalog.provider.id, 'TEST-provider');
        assert.equal(catalog.provider.integrationId, undefined);
        const directory = await owner.readDirectory();
        const matching = directory.integrations.filter((row) => row.id === 'TEST-provider');
        assert.equal(
          matching.length,
          1,
          'the original native directory supplies the same-ID relation'
        );
        const integrationId = matching[0]!.id,
          source = server.selectedFileKey(ready, integrationId);
        keyClient = createOpenCodeV2CredentialClient({ ...transport, integrationId });
        const accept =
          (method: 'GET' | 'POST') =>
          (proof: Parameters<typeof source.acceptProof>[0]): undefined => {
            const current = source.acceptProof(proof, { method, deadline });
            if (proofState.accepted)
              assert.equal(current.scopeDigest, proofState.accepted.scopeDigest);
            proofState.accepted = current;
            return undefined;
          };
        const connected = await keyClient.connectSelectedSource(source.reference, accept('POST'));
        assert.ok(proofState.accepted && proofState.accepted.filesCurrent());
        assert.equal(
          JSON.stringify(
            JSON.parse(Buffer.from(proofState.accepted.encoded, 'base64url').toString('utf8'))
          ).includes('TEST-native-private-key'),
          false,
          'the private proof carries no secret bytes'
        );
        const retained = await keyClient.readSelectedSource(source.reference, accept('GET'));
        assert.equal(retained.connections.length, 1);
        assert.equal(retained.connections[0]?.type, 'credential');
        assert.equal(retained.connections[0]?.id, connected.credentialId);
        // The pinned reader awaits native model activation before the provider snapshot.
        const catalogReads = ['GET /api/model', 'GET /api/provider', 'GET /api/model/default'];
        const integrationRead = 'GET /api/integration/' + integrationId;
        assert.deepEqual(requests, [
          'POST /api/integration/TEST-provider/connect/key',
          ...catalogReads,
          ...catalogReads,
          'GET /api/integration',
          integrationRead,
          `POST /api/integration/${integrationId}/connect/key`,
          integrationRead,
          integrationRead,
        ]);
        assert.equal(
          requests.length + 3,
          15,
          'the original session/session/info calls remain separate and unchanged'
        );
        const originalProof = proofState.accepted.encoded;
        assert.equal(
          JSON.parse(Buffer.from(originalProof, 'base64url').toString('utf8')).schemaVersion,
          2
        );
        repeatedReadPhase = true;
        for (let index = 0; index < 2; index++) {
          const repeated: Awaited<
            ReturnType<ReturnType<typeof createOpenCodeV2CredentialClient>['readSelectedSource']>
          > = await keyClient.readSelectedSource(source.reference, accept('GET'));
          assert.deepEqual(repeated.connections, retained.connections);
          assert.equal(
            proofState.accepted.encoded,
            originalProof,
            'Repeated GET retains the original durable witness and one physical connection'
          );
          assert.ok(proofState.accepted.filesCurrent());
        }
        assert.deepEqual(requests.slice(12), [integrationRead, integrationRead]);
        assert.equal(
          requests.filter((request) => request.startsWith('POST ')).length,
          2,
          'One unauthorized negative request and one original Connect; no repeated Connect'
        );
      } finally {
        try {
          await keyClient?.dispose();
        } finally {
          await owner.dispose();
        }
      }
      cleanup = await server.stopOwned();
      assert.equal(cleanup, true);
      assert.equal(
        server.isOriginalLive(ready),
        false,
        'Stop revokes the original read-only lifetime capture'
      );
      assert.equal(await server.confirmStopped(), true);
      assert.equal(await server.readNativeCustody(new AbortController().signal), undefined);
      assert.throws(() => process.kill(-ready.pid, 0), { code: 'ESRCH' });
      assert.ok(
        proofState.accepted?.filesCurrent(),
        'post-close source revalidation creates no new native owner'
      );
      await writeFile(relativeKey, 'TEST-changed-', { mode: 0o600 });
      assert.equal(
        proofState.accepted.filesCurrent(),
        false,
        'the original delegated dependency cannot authorize changed bytes'
      );
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      cleanup = false;
      // Reuse the original single-flight stop even after an early assertion/fetch failure.
      try {
        await server.stopOwned();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        cleanup = await server.confirmStopped();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!cleanup) cleanupErrors.push(new Error('physical child cleanup must be confirmed'));
      try {
        await assertNativeV1Build(repo, sourceHead, sourceBuild);
        assert.equal(await fileHash(bun), bunSha256);
        assert.equal(
          await fileHash(path.join(directory, 'opencode-v2-engine-manifest.json')),
          manifestSha256
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanup)
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
    }
    if (failed)
      t.diagnostic(
        JSON.stringify({ kind: 'TEST_NATIVE_V2_SELECTED_SOURCE_FAILURE', requests, cleanup })
      );
    if (failed && cleanupErrors.length)
      throw new AggregateError([primary, ...cleanupErrors], 'Native proof and cleanup failed');
    if (failed) throw primary;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'Native proof cleanup failed');
    t.diagnostic(
      JSON.stringify({
        kind: 'TEST_NATIVE_V2_SELECTED_SOURCE',
        status: 'PASS',
        sourceHead,
        platform: 'linux-x64',
        nodeVersion: process.version,
        bunSha256,
        manifestSha256,
        ...sourceBuild,
        originalRequests: 15,
        repeatedReads: 2,
        durableWitnessVersion: 2,
        cleanup,
      })
    );
  }
);
