/** TEST-only native model probe through the existing Host management journal. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { fileHash, startHost, tick } from './fixtures/native-host.ts';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ProviderModelProbeSnapshot } from '../dist/management/contracts.js';

const value = <T>(result: Record<string, unknown>): T => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value as T;
};
test(
  'native 2.1.4 no-tool model probe, cancellation and cold lookup share the original management receipts',
  {
    skip: process.env.OPENCODE_V2_MODEL_PROBE_GO !== '1',
    timeout: 240000,
  },
  async () => {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.equal(process.version, 'v24.21.0');
    const repo = resolve(import.meta.dirname, '../../..'),
      pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(process.execPath),
      entry = join(pkg, 'dist/cli.js');
    const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
    const engine = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
    const receiptPath = process.env.OPENCODE_V2_MODEL_PROBE_RECEIPT!;
    assert.ok(receiptPath?.startsWith('/'));
    const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
    // Reuse the exact Host source boundary; qualification cannot execute stale
    // output or attribute uncommitted adapter/harness changes to another HEAD.
    const build = await buildNativeV1Host(repo, sourceHead);
    const digests = {
      node: await fileHash(node),
      bun: await fileHash(bun),
      manifest: await fileHash(join(engine, 'opencode-v2-engine-manifest.json')),
      hostSource: build.hostSourceDigest,
      hostDist: build.hostDistDigest,
      provider: build.providerDigest,
    };
    assert.equal(digests.manifest, process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-v2-model-probe-')));
    const requests: { tools: number; promptMatched: boolean; model: string }[] = [];
    const gates: (() => void)[] = [];
    const failures: string[] = [];
    const nativePids: number[] = [];
    const steps: string[] = [];
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    let host: ReturnType<typeof startHost> | undefined;
    let originalFailure: unknown,
      passed = false,
      cleanup = false;
    const cleanupErrors: unknown[] = [];
    const model = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const data = Buffer.from(chunk as Uint8Array);
          bytes += data.length;
          assert.ok(bytes <= 1024 * 1024);
          chunks.push(data);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        assert.equal(body.model, 'TEST-model');
        assert.ok(
          body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0),
          'the actual native inference request must advertise zero tools'
        );
        const promptMatched = JSON.stringify(body.messages).includes(
          'Reply only OK. Do not use tools, access files or run commands.'
        );
        assert.equal(promptMatched, true);
        assert.ok(requests.length < 2, 'no native inference replay');
        let release!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        gates.push(release);
        response.once('close', release);
        requests.push({ tools: 0, promptMatched, model: 'TEST-model' });
        await gate;
        if (response.destroyed) return;
        const event = (delta: Record<string, unknown>, finish: string | null) => ({
          id: 'TEST-native-v2-probe-reply',
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
        failures.push('TEST_native_model_request_refused');
        if (!response.headersSent) response.writeHead(400);
        response.end('TEST native model request refused');
      });
    });
    try {
      for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'tmp', 'store'])
        await mkdir(join(root, name), { mode: 0o700 });
      await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
      const address = model.address();
      assert.ok(address && typeof address !== 'string');
      const profile: TeamHostProfile = {
        schemaVersion: 1,
        principalId: 'TEST-human',
        teams: [],
        owner: {
          ownerId: 'TEST-model-probe-owner',
          revision: 'TEST-owner-v1',
          profileId: 'TEST-host',
          storageRoot: join(root, 'store'),
          protocolVersion: 1,
          buildId: 'TEST-native-v2-model-probe',
          nodeSha256: digests.node,
          hostEntrySha256: await fileHash(entry),
        },
        management: [
          {
            provider: 'opencode',
            profileId: 'TEST-management',
            configRevision: 'TEST-config',
            nativeGeneration: 'v2',
            protocolRevision: '2.1.4',
            accountBinding: 'TEST-account',
            cwd: join(root, 'workspace'),
            executable: { path: bun, sha256: digests.bun },
            endpoint: 'http://127.0.0.1:19332',
            timeoutMs: 30000,
            modelProbeTimeoutMs: 60000,
            nativeModel: { providerId: 'TEST-local', modelId: 'TEST-model' },
            environment: {
              HOME: join(root, 'home'),
              TMPDIR: join(root, 'tmp'),
              XDG_CONFIG_HOME: join(root, 'config'),
              XDG_DATA_HOME: join(root, 'data'),
              XDG_CACHE_HOME: join(root, 'cache'),
              PATH: `${dirname(node)}:/usr/bin:/bin`,
              NO_COLOR: '1',
            },
            embedded: {
              version: '2.1.4',
              platform: 'linux',
              arch: 'x64',
              directory: engine,
              manifestSha256: digests.manifest,
              externalDirectory: 'deny',
              providerConfiguration: {
                package: 'aisdk:@ai-sdk/openai-compatible',
                settings: {
                  baseURL: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: 'TEST-LOCALHOST-ONLY',
                },
                models: {
                  'TEST-model': {
                    name: 'TEST-model',
                    limit: { context: 200000, output: 128 },
                    capabilities: { tools: true, input: ['text'], output: ['text'] },
                  },
                },
              },
            },
          },
        ],
      };
      const profilePath = join(root, 'profile.json');
      await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
      const profileHash = await fileHash(profilePath);
      const start = () => startHost({ node, entry, root, profile: profilePath, profileHash });
      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
      const base = {
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        providerId: 'TEST-local',
        modelId: 'TEST-local/TEST-model',
      };
      const wait = async (check: () => Promise<boolean>) => {
        const deadline = Date.now() + 75000;
        do {
          assert.deepEqual(failures, []);
          if (await check()) return;
          await tick();
        } while (Date.now() < deadline);
        throw Error('TEST native model probe did not settle');
      };
      for (const [commandId, cancel] of [
        ['TEST-original', false],
        ['TEST-cancelled', true],
      ] as const) {
        const request = { ...base, commandId };
        const lookup = {
          commandId,
          profileId: base.profileId,
          configRevision: base.configRevision,
        };
        const expectedRequests = cancel ? 2 : 1;
        assert.equal(
          value<ProviderModelProbeSnapshot>(await host.rpc('management.probe.start', request))
            .phase,
          'running'
        );
        assert.equal(
          value<ProviderModelProbeSnapshot>(await host.rpc('management.probe.start', request))
            .phase,
          'running'
        );
        await wait(async () => {
          if (requests.length === expectedRequests) return true;
          const state = value<ProviderModelProbeSnapshot>(
            await host!.rpc('management.probe.read', lookup)
          );
          assert.equal(state.phase, 'running', JSON.stringify(state));
          return false;
        });
        const pid: number | undefined = host.facts().pid;
        assert.ok(pid);
        // Some Linux kernels omit /proc/<pid>/task/<tid>/children. This is a
        // read-only proof, never a PID-adoption or cleanup mechanism.
        const children: number[] = [];
        for (const candidate of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
          const stat = await readFile(`/proc/${candidate}/stat`, 'utf8').catch(() => undefined);
          if (!stat) continue;
          const fields = stat
            .slice(stat.lastIndexOf(') ') + 2)
            .trim()
            .split(/\s+/);
          if (Number(fields[1]) === pid && fields[0] !== 'Z') children.push(Number(candidate));
        }
        assert.equal(children.length, 1, 'the existing Host owns exactly one embedded probe child');
        nativePids.push(children[0]!);
        assert.equal(await fileHash(`/proc/${children[0]}/exe`), digests.bun);
        if (cancel) {
          const cancelled: ProviderModelProbeSnapshot = value(
            await host.rpc('management.probe.cancel', lookup)
          );
          assert.equal(cancelled.phase, 'cancelled');
          assert.equal(cancelled.ok, false);
        } else {
          gates[0]!();
          await wait(
            async () =>
              value<ProviderModelProbeSnapshot>(await host!.rpc('management.probe.read', lookup))
                .phase !== 'running'
          );
          const result: ProviderModelProbeSnapshot = value(
            await host.rpc('management.probe.read', lookup)
          );
          assert.equal(result.phase, 'completed', JSON.stringify(result));
          assert.equal(result.ok, true);
        }
        assert.throws(() => process.kill(-children[0]!, 0), { code: 'ESRCH' });
        assert.deepEqual(await readdir(join(root, 'config')), []);
        // Native account storage may initialize its normal opencode directory.
        // The finite probe removes only its own database/config namespaces.
        assert.deepEqual(
          (await readdir(join(root, 'data'))).filter((name) =>
            name.startsWith('agent-teams-v2-probe-')
          ),
          []
        );
        const replay: ProviderModelProbeSnapshot = value(
          await host.rpc('management.probe.start', request)
        );
        assert.equal(replay.phase, cancel ? 'cancelled' : 'completed');
        assert.equal(replay.ok, !cancel);
        assert.equal(requests.length, expectedRequests);
        steps.push(
          cancel
            ? 'original_probe_cancelled_and_owned_child_gone_no_replay'
            : 'actual_native_no_tool_request_completed_once_and_owned_child_gone'
        );
      }
      await host.close();
      hosts.push(host.facts());
      host = undefined;
      await assertNativeV1Build(repo, sourceHead, build);
      host = start();
      await host.rpc('host.handshake', { protocolVersion: 1 });
      for (const [commandId, phase, ok] of [
        ['TEST-original', 'completed', true],
        ['TEST-cancelled', 'cancelled', false],
      ] as const) {
        const result: ProviderModelProbeSnapshot = value(
          await host.rpc('management.probe.start', { ...base, commandId })
        );
        assert.equal(result.phase, phase);
        assert.equal(result.ok, ok);
      }
      assert.equal(requests.length, 2);
      assert.deepEqual(failures, []);
      await host.close();
      hosts.push(host.facts());
      host = undefined;
      assert.ok(
        hosts.every((row) => row.exitCode === 0 && row.signalCode === null && row.stdoutValid)
      );
      steps.push('cold_original_management_receipts_returned_without_new_native_inference');
      await assertNativeV1Build(repo, sourceHead, build);
      passed = true;
    } catch (error) {
      originalFailure = error;
    } finally {
      if (host)
        try {
          await host.close();
          hosts.push(host.facts());
          host = undefined;
        } catch (error) {
          cleanupErrors.push(error);
        }
      for (const release of gates) release();
      model.closeAllConnections();
      await new Promise<void>((done) => model.close(() => done()));
      for (const pid of nativePids)
        try {
          assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
        } catch (error) {
          cleanupErrors.push(error);
        }
      if (failures.length) originalFailure ??= Error('TEST native model request refused');
      cleanup = cleanupErrors.length === 0;
      if (cleanup)
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          cleanup = false;
          cleanupErrors.push(error);
        }
      try {
        await writeFile(
          receiptPath,
          JSON.stringify(
            {
              kind: 'TEST_NATIVE_V2_MODEL_PROBE',
              sourceHead,
              status: passed && cleanup && !originalFailure ? 'PASS' : 'INCOMPLETE',
              cleanup,
              version: '2.1.4',
              digests,
              steps,
              requests,
              nativeProcessCount: nativePids.length,
              hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({
                exitCode,
                signalCode,
                stdoutValid,
              })),
              vendorAuthQualified: false,
              desktopQualified: false,
              releaseQualified: false,
            },
            null,
            2
          ) + '\n',
          { mode: 0o600 }
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (originalFailure && cleanupErrors.length)
      throw new AggregateError(
        [originalFailure, ...cleanupErrors],
        'TEST probe and cleanup failed'
      );
    if (originalFailure) throw originalFailure;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST probe cleanup failed');
  }
);
