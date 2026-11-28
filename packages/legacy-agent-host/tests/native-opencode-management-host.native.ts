import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { fileHash, startHost, treeHash } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ProviderManagementCatalog } from '../src/management/contracts.ts';

test(
  'Host owns native catalog/credentials and replays retained outcomes after restart without resurrecting forgotten credentials',
  { timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_OPENCODE_MANAGEMENT_HOST_GO, '1');
    const repo = resolve(import.meta.dirname, '../../..'),
      pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const binary = process.env.LEGACY_NATIVE_OPENCODE_PATH;
    assert.ok(binary);
    const executable = { path: await realpath(binary), sha256: await fileHash(binary) };
    assert.equal(
      executable.sha256,
      '8c3c351b138cfe35905ab11846a1373f1beea590aee7eda412fb765b72c79d82'
    );
    const entry = join(pkg, 'dist/cli.js');
    const artifacts = {
      nodeSha256: await fileHash(node),
      executable,
      hostEntrySha256: await fileHash(entry),
      sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
      distSha256: await treeHash(join(pkg, 'dist'), '.js'),
      harnessSha256: await fileHash(import.meta.filename),
      helperSha256: await fileHash(join(import.meta.dirname, 'fixtures/native-host.ts')),
      controllerSourceSha256: await treeHash(join(repo, 'agent-teams-controller/src'), '.js'),
      providerSha256: await fileHash(
        join(
          repo,
          'vendor/provider-migration/opencode-idle-v1/agent-teams-provider-implementations-0.0.0.tgz'
        )
      ),
    };
    assert.equal(artifacts.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256);
    assert.equal(artifacts.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256);
    assert.equal(
      artifacts.providerSha256,
      '64df7bcfed0e7e58d709cf79ab3723677461fd5ab1a76cc96fe96e7cdc85346b'
    );
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'TEST-native-opencode-management-host-'))
    );
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'config', 'data', 'cache', 'tmp', 'workspace', 'store'])
      await mkdir(join(root, name), { mode: 0o700 });
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((done) => reservation.close(() => done()));
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      principalId: 'TEST-human',
      owner: {
        ownerId: 'TEST-owner',
        revision: 'TEST-revision',
        storageRoot: join(root, 'store'),
        profileId: 'TEST-profile',
        protocolVersion: 1,
        buildId: 'TEST-management-host',
        nodeSha256: artifacts.nodeSha256,
        hostEntrySha256: artifacts.hostEntrySha256,
      },
      teams: [
        {
          scope: {
            projectId: 'TEST-project',
            workspaceId: 'TEST-workspace',
            teamId: 'TEST-team',
            runId: 'TEST-run',
            memberId: 'human',
            generation: '1',
          },
          binding: { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-team' },
          members: [],
          grants: [
            {
              principalId: 'TEST-human',
              memberName: 'user',
              permissions: ['read', 'task.write', 'message.write', 'admin'],
            },
          ],
        },
      ],
      management: [
        {
          provider: 'opencode',
          profileId: 'TEST-management',
          accountBinding: 'TEST-account',
          configRevision: 'TEST-config',
          cwd: join(root, 'workspace'),
          endpoint: `http://127.0.0.1:${address.port}`,
          timeoutMs: 30_000,
          executable,
          environment: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            PATH: `${dirname(node)}:/usr/bin:/bin`,
            XDG_CONFIG_HOME: join(root, 'config'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'),
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_TELEMETRY: '1',
            OPENCODE_DISABLE_SHARE: '1',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              autoupdate: false,
              share: 'disabled',
              enabled_providers: ['TEST-local'],
              provider: {
                'TEST-local': {
                  npm: '@ai-sdk/openai-compatible',
                  name: 'TEST native catalog',
                  options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'TEST-private-config-key' },
                  models: {
                    'TEST-model': { name: 'TEST model', limit: { context: 200000, output: 2000 } },
                  },
                },
              },
            }),
          },
        },
      ],
    };
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
    const start = () =>
      startHost({
        node,
        entry,
        root,
        profile: profilePath,
        profileHash,
      });
    const profileHash = await fileHash(profilePath);
    let host = start();
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    let passed = false,
      closed = false;
    let failure: string | undefined;
    let cleanupFailed = false;
    const observations: Record<string, unknown> = {};
    try {
      const handshake = await host.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((handshake.capabilities as string[]).includes('management.catalog'));
      assert.ok(!(handshake.capabilities as string[]).includes('runtime.member-session'));
      assert.deepEqual(
        await host.rpc('management.catalog', {
          profileId: 'TEST-foreign',
          configRevision: 'TEST-config',
        }),
        { ok: false, code: 'profile-changed' }
      );
      assert.deepEqual(
        await host.rpc('management.catalog', {
          profileId: 'TEST-management',
          configRevision: 'TEST-stale',
        }),
        { ok: false, code: 'profile-changed' }
      );
      assert.deepEqual(
        await host.rpc('management.catalog', {
          profileId: 'TEST-management',
          configRevision: 'TEST-config',
          endpoint: 'http://127.0.0.1:1',
        }),
        { ok: false, code: 'invalid' }
      );
      const catalog = await host.rpc('management.catalog', {
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
      });
      assert.equal(catalog.ok, true);
      const summary = catalog.value as ProviderManagementCatalog;
      const selected = summary.providers.find((provider) => provider.providerId === 'TEST-local');
      assert.ok(selected);
      assert.equal(selected?.displayName, 'TEST native catalog');
      assert.equal(selected.modelCount, 1);
      assert.deepEqual(selected.models, []);
      assert.equal(
        typeof selected.connected,
        'boolean',
        'native connected does not claim an authenticated model request'
      );
      const modelResult = await host.rpc('management.catalog', {
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        providerId: 'TEST-local',
      });
      assert.equal(modelResult.ok, true);
      const scoped = modelResult.value as ProviderManagementCatalog;
      assert.equal(scoped.providers.length, 1);
      assert.deepEqual(
        scoped.providers[0]?.models.map((model) => ({
          id: model.modelId,
          context: model.contextTokens,
          output: model.outputTokens,
        })),
        [{ id: 'TEST-model', context: 200000, output: 2000 }]
      );
      for (const response of [catalog, modelResult]) {
        const serialized = JSON.stringify(response);
        for (const excluded of [
          root,
          'TEST-private-config-key',
          'accountBinding',
          'OPENCODE_',
          'baseURL',
          'authorization',
        ])
          assert.equal(
            serialized.includes(excluded),
            false,
            `private ${excluded} stays out of Host RPC`
          );
      }
      observations.summary = summary;
      observations.models = scoped;
      const set = {
        commandId: 'TEST-set-credential',
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        providerId: 'TEST-local',
        kind: 'credential.set',
        key: 'TEST-native-auth-key',
      };
      const forget = {
        commandId: 'TEST-forget-credential',
        profileId: set.profileId,
        configRevision: set.configRevision,
        providerId: set.providerId,
        kind: 'credential.forget',
      };
      const setReceipt = await host.rpc('management.credential', set);
      assert.equal(setReceipt.ok, true);
      assert.equal((setReceipt.value as { phase: string }).phase, 'completed');
      const authPath = join(root, 'data/opencode/auth.json');
      const stored = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(stored['TEST-local'], { type: 'api', key: set.key });
      assert.deepEqual(
        await host.rpc('management.credential', { ...set, key: 'TEST-different-key' }),
        { ok: false, code: 'conflict' }
      );
      const forgetReceipt = await host.rpc('management.credential', forget);
      assert.equal(forgetReceipt.ok, true);
      assert.equal((forgetReceipt.value as { phase: string }).phase, 'completed');
      const assertForgotten = async () =>
        assert.equal(
          (JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>)['TEST-local'],
          undefined
        );
      await assertForgotten();
      observations.credentialReceipts = [setReceipt, forgetReceipt];
      await host.close();
      hosts.push(host.facts());
      closed = true;
      const assertListenerClosed = () =>
        new Promise<void>((done, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: address.port });
          socket.setTimeout(1000, () => {
            socket.destroy();
            reject(new Error('management listener absence unknown'));
          });
          socket.once('connect', () => {
            socket.destroy();
            reject(new Error('management listener still alive'));
          });
          socket.once('error', (error: NodeJS.ErrnoException) => {
            socket.destroy();
            if (error.code === 'ECONNREFUSED') done();
            else reject(error);
          });
        });
      await assertListenerClosed();
      host = start();
      closed = false;
      await host.rpc('host.handshake', { protocolVersion: 1 });
      for (const [request, expected] of [
        [set, setReceipt],
        [forget, forgetReceipt],
      ] as const) {
        assert.deepEqual(
          await host.rpc('management.credential.lookup', {
            commandId: request.commandId,
            profileId: request.profileId,
            configRevision: request.configRevision,
          }),
          expected
        );
        assert.deepEqual(await host.rpc('management.credential', request), expected);
      }
      await assertForgotten(); // A redispatched old set would resurrect the key: a native-effect replay oracle.
      await assertListenerClosed(); // Lookup/replay do not allocate even a management server.
      await host.close();
      hosts.push(host.facts());
      closed = true;
      observations.restartReplayWithoutCredentialResurrection = true;
      passed = true;
    } catch (error) {
      failure =
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 2000)
          : 'Unknown TEST error';
      throw error;
    } finally {
      if (!closed) {
        try {
          await host.close();
          hosts.push(host.facts());
          closed = true;
        } catch {
          cleanupFailed = true;
        }
      }
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            status: passed && !cleanupFailed ? 'PASS' : 'INCOMPLETE',
            root,
            artifacts,
            closed,
            host: host.facts(),
            hosts,
            failure,
            cleanupFailed,
            observations,
            scope:
              'Actual Host stdio/native OpenCode catalog, dummy credential set/forget, stable conflict/lookup and restart replay without native reallocation or credential resurrection. No successful model/auth login, conversation or Desktop/OAuth qualification.',
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      assert.equal(cleanupFailed, false, 'captured Host/provider cleanup must complete');
    }
  }
);
