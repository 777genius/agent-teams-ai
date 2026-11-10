import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import { OpenCodeManagementHost } from '../dist/adapters/providers/OpenCodeManagementHost.js';
import { fileHash, treeHash } from './fixtures/native-host.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { OpenCodeManagementProfile } from '../src/adapters/providers/OpenCodeManagementHost.ts';

test(
  'actual OpenCode management owns catalog/auth in the selected TEST namespace without a conversation',
  { timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_OPENCODE_MANAGEMENT_GO, '1');
    const repo = resolve(import.meta.dirname, '../../..');
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
    const artifacts = {
      node: { path: node, sha256: await fileHash(node) },
      executable,
      sourceSha256: await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'),
      distSha256: await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'),
      harnessSha256: await fileHash(import.meta.filename),
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
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-management-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'config', 'data', 'cache', 'tmp', 'workspace'])
      await mkdir(join(root, name), { mode: 0o700 });
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done) => reservation.close(() => done()));
    const profile: OpenCodeManagementProfile = {
      provider: 'opencode',
      profileId: 'TEST-management',
      accountBinding: 'TEST-account',
      configRevision: 'TEST-revision',
      endpoint,
      executable,
      timeoutMs: 30_000,
      cwd: join(root, 'workspace'),
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
              name: 'TEST selected provider',
              options: { baseURL: 'http://127.0.0.1:1/v1' },
              models: {
                'TEST-model': {
                  name: 'TEST catalog model',
                  limit: { context: 200000, output: 2000 },
                },
              },
            },
          },
        }),
      },
    };
    await writeFile(join(root, 'profile.json'), JSON.stringify(profile, null, 2), { mode: 0o600 });
    let child: ChildProcessWithoutNullStreams | undefined;
    const requests: { path: string; method: string; status?: number }[] = [];
    const facts: Record<string, boolean> = {};
    let passed = false,
      clean = false;
    const host = new OpenCodeManagementHost(
      profile,
      { canAllocate: () => true, isCurrent: () => true },
      {
        createProcess(captured, canAllocate) {
          const custody = new CapturedProcess(captured, canAllocate);
          return {
            launch(request) {
              assert.equal(child, undefined);
              child = custody.launch(request);
              return child;
            },
            seal: () => custody.seal(),
            isRunning: () => custody.isRunning(),
            confirmStopped: () => custody.confirmStopped(),
          };
        },
        async fetchImpl(input, init) {
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, endpoint);
          assert.ok(
            [
              '/config',
              '/provider',
              '/config/providers',
              '/provider/auth',
              '/auth/TEST-local',
            ].includes(url.pathname)
          );
          const fact: { path: string; method: string; status?: number } = {
            path: url.pathname,
            method: request.method,
          };
          requests.push(fact);
          const response = await fetch(request);
          fact.status = response.status;
          return response;
        },
      }
    );
    try {
      await host.start();
      await host.run(async (client) => {
        const catalog = await client.getProviders();
        const selected = catalog.all?.find((provider) => provider.id === 'TEST-local');
        assert.equal(selected?.name, 'TEST selected provider');
        assert.ok(selected?.models?.['TEST-model']);
        facts.catalog = true;
        await client.getConfigProviders();
        await client.getProviderAuth();
        assert.equal(
          await client.setProviderAuth('TEST-local', { type: 'api', key: 'TEST-NOT-A-REAL-KEY' }),
          true
        );
        const authPath = join(root, 'data/opencode/auth.json');
        const stored = JSON.parse(await readFile(authPath, 'utf8')) as Record<
          string,
          { type: string; key: string }
        >;
        assert.deepEqual(stored['TEST-local'], { type: 'api', key: 'TEST-NOT-A-REAL-KEY' });
        facts.selectedNamespaceCredential = true;
        assert.equal(await client.deleteProviderAuth('TEST-local'), true);
        const removed = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
        assert.equal(removed['TEST-local'], undefined);
        facts.forgotCredential = true;
      });
      passed = true;
    } finally {
      clean = await host.close();
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            status: passed && clean ? 'PASS' : 'INCOMPLETE',
            scope:
              'Actual native management catalog and TEST dummy auth persistence/forget; no conversation, OAuth login, Desktop or real credentials.',
            root,
            artifacts,
            facts,
            requests,
            clean,
            child: child
              ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }
              : null,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      assert.equal(clean, true, 'captured management server and descendants retired');
    }
  }
);
