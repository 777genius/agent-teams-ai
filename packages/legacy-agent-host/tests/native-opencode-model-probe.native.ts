import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { fileHash, startHost, treeHash, tick } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../src/composition/TeamHost.ts';
import type { ProviderModelProbeSnapshot } from '../src/management/contracts.ts';

const command = promisify(execFile);
const value = <T>(raw: Record<string, unknown>): T => {
  assert.equal(raw.ok, true);
  return raw.value as T;
};
test(
  'actual OpenCode effective model-limit no-tool probe through standalone Host; durable replay/restart never repeats inference',
  { timeout: 120000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_OPENCODE_MODEL_PROBE_GO, '1');
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
      sourceSha256: await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'),
      distSha256: await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'),
      nodeSha256: await fileHash(node),
      nativeSha256: executable.sha256,
      harnessSha256: await fileHash(import.meta.filename),
      helperSha256: await fileHash(join(import.meta.dirname, 'fixtures/native-host.ts')),
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
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-model-probe-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'tmp', 'config', 'data', 'cache', 'workspace', 'store'])
      await mkdir(join(root, name), { mode: 0o700 });
    const limits = { contextTokens: 4096, outputTokens: 128 };
    const requests: { model: string; tools: number; promptMatched: boolean; maxTokens: number }[] =
      [];
    const failures: string[] = [];
    let release!: () => void;
    const responseGate = new Promise<void>((done) => {
      release = done;
    });
    const model = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, 'POST');
        assert.match(request.url ?? '', /\/v1\/chat\/completions$/);
        assert.equal(requests.length, 0, 'single native inference request');
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          assert.ok(size < 1000000);
          chunks.push(bytes);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        assert.equal(body.model, 'TEST-model');
        assert.equal(
          body.max_tokens,
          limits.outputTokens,
          'native request uses the tested output limit'
        );
        const tools = Array.isArray(body.tools) ? body.tools.length : 0;
        assert.equal(tools, 0, 'actual native model request offers no tools');
        const promptMatched = JSON.stringify(body.messages).includes(
          'Reply only OK. Do not use tools, access files or run commands.'
        );
        assert.equal(promptMatched, true);
        requests.push({
          model: 'TEST-model',
          tools,
          promptMatched,
          maxTokens: Number(body.max_tokens),
        });
        await responseGate;
        const event = (delta: Record<string, unknown>, finish: string | null) => ({
          id: 'TEST-model-probe-reply',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'TEST-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify(event({ role: 'assistant', content: 'OK' }, null))}\n\n`
        );
        response.write(`data: ${JSON.stringify(event({}, 'stop'))}\n\n`);
        response.end('data: [DONE]\n\n');
      })().catch(() => {
        failures.push('TEST model request refused');
        if (!response.headersSent) response.writeHead(400);
        response.end('TEST model request refused');
      });
    });
    await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
    const modelAddress = model.address();
    assert.ok(modelAddress && typeof modelAddress !== 'string');
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((done) => reservation.close(() => done()));
    const entry = join(repo, 'packages/legacy-agent-host/dist/cli.js');
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      principalId: 'TEST-human',
      teams: [],
      owner: {
        ownerId: 'TEST-owner',
        revision: 'TEST-v1',
        profileId: 'TEST-host',
        protocolVersion: 1,
        buildId: 'TEST-model-probe-host',
        storageRoot: join(root, 'store'),
        nodeSha256: artifacts.nodeSha256,
        hostEntrySha256: await fileHash(entry),
      },
      management: [
        {
          provider: 'opencode',
          profileId: 'TEST-management',
          configRevision: 'TEST-config',
          accountBinding: 'TEST-account',
          executable,
          cwd: join(root, 'workspace'),
          endpoint: `http://127.0.0.1:${address.port}`,
          timeoutMs: 30000,
          modelProbeTimeoutMs: 60000,
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
                  options: {
                    baseURL: `http://127.0.0.1:${modelAddress.port}/v1`,
                    apiKey: 'TEST-dummy',
                  },
                  models: {
                    'TEST-model': {
                      name: 'TEST model',
                      limit: { context: 200000, output: 2000, input: 100000 },
                    },
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
    const profileHash = await fileHash(profilePath);
    const start = () => startHost({ node, entry, root, profile: profilePath, profileHash });
    let host = start(),
      closed = false,
      passed = false;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    const nativePids: number[] = [];
    const request = {
      commandId: 'TEST-probe-original',
      limits,
      profileId: 'TEST-management',
      configRevision: 'TEST-config',
      providerId: 'TEST-local',
      modelId: 'TEST-local/TEST-model',
    };
    const lookup = {
      commandId: request.commandId,
      profileId: request.profileId,
      configRevision: request.configRevision,
    };
    const wait = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 70000;
      while (Date.now() < end) {
        if (await check()) return;
        assert.equal(failures.length, 0);
        await tick();
      }
      throw new Error('Original native probe did not reach expected state');
    };
    try {
      assert.equal(
        (await host.rpc('host.handshake', { protocolVersion: 1 })).buildId,
        'TEST-model-probe-host'
      );
      assert.equal(
        value<ProviderModelProbeSnapshot>(await host.rpc('management.probe.start', request)).phase,
        'running'
      );
      await wait(async () => {
        if (requests.length === 1) return true;
        const pending = value<ProviderModelProbeSnapshot>(
          await host.rpc('management.probe.read', lookup)
        );
        assert.equal(pending.phase, 'running', 'Native probe retired before inference');
        return false;
      });
      const processRows = (await command('/bin/ps', ['-axo', 'pid=,ppid='])).stdout
        .trim()
        .split('\n');
      for (const line of processRows) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        if (parent === host.facts().pid && pid) nativePids.push(pid);
      }
      assert.ok(
        nativePids.length > 0,
        'native process is captured while the model response is deliberately pending'
      );
      release();
      await wait(
        async () =>
          value<ProviderModelProbeSnapshot>(await host.rpc('management.probe.read', lookup))
            .phase !== 'running'
      );
      const result = value<ProviderModelProbeSnapshot>(
        await host.rpc('management.probe.read', lookup)
      );
      assert.equal(result.phase, 'completed');
      assert.equal(result.ok, true);
      assert.deepEqual(result.limits, limits);
      for (const pid of nativePids)
        assert.throws(
          () => process.kill(pid, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH'
        );
      assert.equal(
        value<ProviderModelProbeSnapshot>(await host.rpc('management.probe.start', request)).ok,
        true
      );
      assert.equal(requests.length, 1);
      await host.close();
      closed = true;
      hosts.push(host.facts());
      assert.equal(host.facts().exitCode, 0);
      host = start();
      closed = false;
      assert.equal(
        (await host.rpc('host.handshake', { protocolVersion: 1 })).buildId,
        'TEST-model-probe-host'
      );
      assert.equal(
        value<ProviderModelProbeSnapshot>(await host.rpc('management.probe.start', request)).ok,
        true
      );
      assert.equal(requests.length, 1);
      await host.close();
      closed = true;
      hosts.push(host.facts());
      assert.equal(host.facts().exitCode, 0);
      passed = true;
    } finally {
      release();
      if (!closed) {
        await host.close().catch(() => {});
        hosts.push(host.facts());
      }
      model.closeAllConnections();
      await new Promise<void>((done) => model.close(() => done()));
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            status: passed ? 'PASS' : 'INCOMPLETE',
            artifacts,
            requestedLimits: limits,
            hosts,
            nativePids,
            requests,
            failures,
            scope:
              'Actual pinned OpenCode/D/standalone Host, localhost scripted inference/dummy auth; no tools offered, original receipt replay/restart. Not Desktop controls or vendor account/model qualification.',
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
    }
  }
);
