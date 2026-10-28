import {
  addNativeCrossTeamTarget,
  captureNativeCrossTeamSources,
  runNativeCrossTeamProof,
} from './fixtures/native-cross-team-proof.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTEXT_MARKER as claudeContext,
  record,
  startNativeTeamModel,
} from './fixtures/native-claude-team/model.ts';
import {
  CONTEXT_MARKER as codexContext,
  startCodexModel,
} from './fixtures/native-codex-team/model.ts';
import {
  CONTEXT_MARKER as openCodeContext,
  startOpenCodeModel,
} from './fixtures/native-opencode-team/model.ts';
import { fileHash, startHost, tick, treeHash } from './fixtures/native-host.ts';
import { FileCheckpointStorage } from '../dist/adapters/runtime/FileCheckpointStorage.js';
import { readdir } from 'node:fs/promises';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

// This scripts inference only. All tools, MCP, sessions and workspace effects run
// through three actual pinned agents and one production Host/Team/Runtime composition.
const exerciseCrossTeam = process.env.LEGACY_NATIVE_MIXED_CROSS_TEAM_GO === '1';
const exerciseRestore = process.env.LEGACY_NATIVE_MIXED_RESTORE_GO === '1';
const exercisePeers = process.env.LEGACY_NATIVE_MIXED_PEERS_GO === '1';
test(
  exercisePeers
    ? 'mixed native providers exchange all six peer routes after selected restore'
    : exerciseRestore
      ? 'mixed native team restores selected history into new generations across Host restart'
      : 'mixed native team bootstraps three providers and preserves member/task/input ownership across restart',
  { timeout: 240_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_MIXED_HOST_GO, '1');
    assert.ok(
      !exerciseCrossTeam || (!exerciseRestore && !exercisePeers),
      'one fresh baseline3 + target1 cross-Team composition; no redundant restore/peer replay'
    );
    const repo = resolve(import.meta.dirname, '../../..');
    const pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const entry = join(pkg, 'dist/cli.js');
    const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
    assert.ok(artifact);
    const providerArchive = await realpath(resolve(repo, artifact));
    const source = await treeHash(join(pkg, 'src'), '.ts');
    const dist = await treeHash(join(pkg, 'dist'), '.js');
    assert.equal(source, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256);
    assert.equal(dist, process.env.LEGACY_NATIVE_HOST_DIST_SHA256);
    const providerSha256 = await fileHash(providerArchive);
    assert.equal(providerSha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256);
    const providerRoot = resolve(
      dirname(fileURLToPath(import.meta.resolve('@agent-teams/provider-implementations/codex'))),
      '..'
    );
    const entries = execFileSync('/usr/bin/tar', ['-tf', providerArchive], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((path) => /^package\/dist\/.+\.js$/.test(path));
    assert.ok(entries.length > 0);
    for (const path of entries) {
      assert.ok(!path.includes('..'));
      assert.deepEqual(
        await readFile(join(providerRoot, path.slice('package/'.length))),
        execFileSync('/usr/bin/tar', ['-xOf', providerArchive, path])
      );
    }
    const providerRequire = createRequire(
      import.meta.resolve('@agent-teams/provider-implementations/claude')
    );
    const sdkRequire = createRequire(providerRequire.resolve('@anthropic-ai/claude-agent-sdk'));
    const claudePath = await realpath(
      sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
    );
    const codexPath = process.env.LEGACY_NATIVE_CODEX_PATH;
    const openCodePath = process.env.LEGACY_NATIVE_OPENCODE_PATH;
    assert.ok(codexPath && openCodePath);
    const executables = {
      claude: { path: claudePath, sha256: await fileHash(claudePath) },
      codex: { path: await realpath(codexPath), sha256: await fileHash(codexPath) },
      opencode: { path: await realpath(openCodePath), sha256: await fileHash(openCodePath) },
    };
    assert.equal(
      executables.claude.sha256,
      'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f'
    );
    assert.equal(
      executables.codex.sha256,
      '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57'
    );
    assert.equal(
      executables.opencode.sha256,
      '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b'
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-mixed-host-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const directory of [
      'home',
      'tmp',
      'store',
      ...['alice', 'bob', 'carol'].flatMap((name) => [
        name,
        `${name}/home`,
        `${name}/tmp`,
        `${name}/config`,
        `${name}/data`,
        `${name}/cache`,
        `${name}/workspace`,
      ]),
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    const crossSourcePinsBefore = exerciseCrossTeam
      ? await captureNativeCrossTeamSources(root)
      : [];
    const claudeModel = await startNativeTeamModel({
      peerMessaging: exercisePeers,
      ...(exerciseCrossTeam
        ? { crossTeam: { actor: 'source' as const, contextMarker: claudeContext } }
        : {}),
    });
    t.after(() => claudeModel.close());
    const codexModel = await startCodexModel({ peerMessaging: exercisePeers });
    t.after(() => codexModel.close());
    const openCodeModel = await startOpenCodeModel({ peerMessaging: exercisePeers });
    t.after(() => openCodeModel.close());
    const modelRows = [claudeModel, codexModel, openCodeModel];
    const crossModel = exerciseCrossTeam
      ? await startNativeTeamModel({
          crossTeam: { actor: 'target', contextMarker: 'TEST_NATIVE_CROSS_TARGET_CONTEXT' },
        })
      : undefined;
    if (crossModel) t.after(() => crossModel.close());
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done) => reservation.close(() => done()));
    const owner = {
      ownerId: 'TEST-mixed-' + basename(root),
      revision: 'TEST-revision',
      storageRoot: join(root, 'store'),
      profileId: 'TEST-profile',
      protocolVersion: 1 as const,
      buildId: 'TEST-mixed-host',
      nodeSha256: await fileHash(node),
      hostEntrySha256: await fileHash(entry),
    };
    const scope = {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: 'TEST-team',
      runId: 'TEST-run',
      memberId: 'human',
      generation: '1',
    };
    const teamBinding = {
      backendId: owner.ownerId,
      teamId: scope.teamId,
      teamName: 'test-native-team',
    };
    const names = ['alice', 'bob', 'carol'] as const;
    const environment = (name: string) => ({
      HOME: join(root, name, 'home'),
      TMPDIR: join(root, name, 'tmp'),
      XDG_CONFIG_HOME: join(root, name, 'config'),
      XDG_DATA_HOME: join(root, name, 'data'),
      XDG_CACHE_HOME: join(root, name, 'cache'),
      PATH: `${dirname(node)}:/usr/bin:/bin`,
      SHELL: '/bin/sh',
    });
    const common = (name: string) => ({
      teamId: scope.teamId,
      memberId: name + '-id',
      principalId: name + '-session',
      sessionId: 'TEST-session-' + name,
      generation: 1,
      configRevision: 'TEST-config-' + name,
      cwd: join(root, name, 'workspace'),
      accountBinding: 'TEST-dummy-' + name,
      limits: {
        queuedInputs: 2,
        inputBytes: 8192,
        outputBytes: 1_000_000,
        outputEvents: 1500,
        pendingInteractions: 4,
        timeoutMs: 45_000,
      },
    });
    await writeFile(
      join(root, 'bob/config/config.toml'),
      `model = "mock-model"
model_provider = "TEST_fixture"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
remote_models = false
shell_snapshot = false
skip_host_skill_discovery = true
enable_request_compression = false
multi_agent = false
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(join(root, 'bob/home'))}, TMPDIR = ${JSON.stringify(join(root, 'bob/tmp'))}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST fixture"
base_url = ${JSON.stringify(codexModel.url + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
      { mode: 0o600 }
    );
    const profile: TeamHostProfile = {
      schemaVersion: 1,
      owner,
      principalId: 'human',
      teams: [
        {
          scope,
          binding: teamBinding,
          members: names.map((name) => ({
            memberId: name + '-id',
            name,
            role: 'member',
            delivery: {
              ...teamBinding,
              runId: scope.runId,
              memberId: name + '-id',
              generation: '1',
            },
          })),
          grants: [
            {
              principalId: 'human',
              memberName: 'user',
              permissions: ['read', 'task.write', 'message.write', 'admin'],
            },
            ...names.map((name) => ({
              principalId: name + '-session',
              memberName: name,
              permissions: ['read', 'task.write', 'message.write'] as (
                | 'read'
                | 'task.write'
                | 'message.write'
              )[],
            })),
          ],
        },
      ],
      runtime: {
        members: [
          {
            ...common('alice'),
            provider: 'claude',
            model: 'claude-sonnet-4-6',
            executable: executables.claude,
            environment: {
              ...environment('alice'),
              CLAUDE_CONFIG_DIR: join(root, 'alice/config'),
              ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY',
              ANTHROPIC_BASE_URL: claudeModel.url,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
              DISABLE_AUTOUPDATER: '1',
              DISABLE_ERROR_REPORTING: '1',
              DISABLE_TELEMETRY: '1',
              NO_COLOR: '1',
              TERM: 'dumb',
            },
            nativeTools: ['Bash'],
            autoAllowedTools: ['Bash'],
            nativeOptions: { projectInstructions: { append: claudeContext } },
          },
          {
            ...common('bob'),
            provider: 'codex',
            protocolRevision: '0.162.0',
            model: 'mock-model',
            executable: executables.codex,
            environment: {
              ...environment('bob'),
              CODEX_HOME: join(root, 'bob/config'),
              TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
            },
            nativeOptions: {
              approvalPolicy: 'never',
              sandbox: 'workspace-write',
              modelProvider: 'TEST_fixture',
              developerInstructions: codexContext,
            },
          },
          {
            ...common('carol'),
            provider: 'opencode',
            protocolRevision: '1.19.4',
            model: 'TEST-model',
            executable: executables.opencode,
            endpoint,
            environment: {
              ...environment('carol'),
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                autoupdate: false,
                share: 'disabled',
                enabled_providers: ['TEST-local'],
                model: 'TEST-local/TEST-model',
                small_model: 'TEST-local/TEST-model',
                permission: { '*': 'deny', bash: 'allow' },
                agent: {
                  title: { disable: true },
                  summary: { disable: true },
                  'TEST-member': { mode: 'primary' },
                },
                compaction: { auto: false },
                provider: {
                  'TEST-local': {
                    npm: '@ai-sdk/openai-compatible',
                    name: 'TEST fixture',
                    options: { baseURL: openCodeModel.url + '/v1', apiKey: 'TEST-LOCALHOST-ONLY' },
                    models: {
                      'TEST-model': {
                        name: 'TEST-model',
                        limit: { context: 200000, output: 2000 },
                      },
                    },
                  },
                },
              }),
              OPENCODE_DISABLE_MODELS_FETCH: '1',
              OPENCODE_DISABLE_AUTOUPDATE: '1',
              OPENCODE_DISABLE_TELEMETRY: '1',
              OPENCODE_DISABLE_SHARE: '1',
              NO_COLOR: '1',
            },
            nativeOptions: {
              providerId: 'TEST-local',
              agent: 'TEST-member',
              instructions: openCodeContext,
            },
          },
        ],
      },
    };
    if (crossModel) await addNativeCrossTeamTarget(profile, root, crossModel.url);
    const profilePath = join(root, 'profile.json');
    const profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    const binding = { schemaVersion: 1, handleId: 'TEST-mixed-handle', owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    const start = () =>
      startHost({ node, entry, root, profile: profilePath, profileHash: digest(profileBytes) });
    let current: ReturnType<typeof startHost> | undefined;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    const receipts: {
      command: ReturnType<typeof envelope>;
      receipt: Record<string, unknown>;
      memberId: string;
      inputId: unknown;
    }[] = [];
    const runtime = new Map<string, Record<string, unknown>>();
    const sourceRuntime = new Map<string, Record<string, unknown>>();
    const generations = new Map<string, string>(names.map((name) => [name, '1']));
    const restoreSelections: Record<string, { reference: string; nativeIdentityDigest: string }> =
      {};
    const checkpointStore = new FileCheckpointStorage(join(root, 'store'));
    const identityDigest = (name: string, reference: string) => {
      const opaque = record(checkpointStore.readCheckpointPayload(reference).opaque);
      const value =
        name === 'alice'
          ? opaque.nativeSession
          : name === 'bob'
            ? opaque.nativeThreadId
            : opaque.nativeSessionId;
      assert.equal(typeof value, 'string');
      assert.ok(String(value).length > 0);
      return digest(String(value));
    };
    let crossProof: Awaited<ReturnType<typeof runNativeCrossTeamProof>> | undefined;
    let launch: Record<string, unknown> = {},
      passed = false,
      cleanupConfirmed = true;
    try {
      current = start();
      cleanupConfirmed = false;
      await current.rpc('host.handshake', { protocolVersion: 1 });
      const initial = record(
        (await current.rpc('team.launch.read', envelope('TEST-launch-read', {}))).value
      );
      const launched = await current.rpc(
        'team.launch.start',
        envelope('TEST-launch', {
          launchId: initial.launchId,
          rosterRevision: initial.rosterRevision,
          configuration: {
            members: [
              {
                memberId: 'alice-id',
                model: 'claude-opus-4-6',
                effort: 'medium',
                fastMode: false,
                permissions: 'bypass',
                context: 'model-default',
              },
            ],
          },
        })
      );
      assert.equal(launched.ok, true);
      const readyDeadline = Date.now() + 60_000;
      do {
        launch = record(
          (await current.rpc('team.launch.read', envelope('TEST-launch-read', {}))).value
        );
        if (launch.status === 'ready') break;
        assert.ok(!['failed', 'unknown'].includes(String(launch.status)), JSON.stringify(launch));
        await tick();
      } while (Date.now() < readyDeadline);
      assert.equal(launch.status, 'ready', JSON.stringify(launch));
      assert.equal(launch.ready, 3);
      for (const label of ['ONE', 'TWO']) {
        // Independent native turns overlap; Team mutations still share their canonical owner.
        for (const [index, name] of names.entries()) {
          const command = envelope(`TEST-${name}-${label}`, {
            operation: 'message.send',
            payload: {
              to: name,
              text: `${['NATIVE', 'CODEX', 'OPENCODE'][index]}_TEAM_${label}`,
            },
          });
          const receipt: Record<string, unknown> = await current.rpc('team.execute', command);
          assert.equal(receipt.ok, true);
          assert.equal(record(receipt.value).phase, 'completed');
          receipts.push({
            command,
            receipt,
            memberId: name + '-id',
            inputId: record(record(receipt.value).effects).deliveryId,
          });
        }
        const deadline = Date.now() + 75_000;
        let pending: typeof receipts;
        do {
          for (const model of modelRows) assert.deepEqual(model.failures, []);
          for (const name of names) {
            const read = await current.rpc(
              'runtime.read',
              envelope('TEST-read', { memberId: name + '-id' })
            );
            assert.equal(read.ok, true);
            runtime.set(name + '-id', record(read.value));
          }
          pending = receipts.filter(({ memberId, inputId }) => {
            const input = [
              ...(runtime.get(memberId)!.inputs as unknown[]),
              ...((sourceRuntime.get(memberId)?.inputs ?? []) as unknown[]),
            ]
              .map(record)
              .find((row) => row.inputId === inputId);
            if (input?.phase !== 'terminal') return true;
            assert.equal(input.terminal, 'succeeded');
            return false;
          });
          if (pending.length) await tick();
        } while (pending.length && Date.now() < deadline);
        assert.equal(pending.length, 0, 'every native input reaches its own durable terminal');
        if (exerciseRestore && label === 'ONE') {
          const settledDeadline = Date.now() + 60_000;
          let settled = false;
          do {
            for (const name of names)
              runtime.set(
                name + '-id',
                record(
                  (
                    await current.rpc(
                      'runtime.read',
                      envelope('TEST-drain-read', { memberId: name + '-id' })
                    )
                  ).value
                )
              );
            const outboxDirectory = join(root, 'store/teams/test-native-team/.host-owner/outbox');
            const outbox = await Promise.all(
              (await readdir(outboxDirectory)).map(async (file) =>
                record(JSON.parse(await readFile(join(outboxDirectory, file), 'utf8')))
              )
            );
            settled =
              [...runtime.values()].every((state) =>
                (state.inputs as unknown[]).map(record).every((input) => input.phase === 'terminal')
              ) && outbox.every((row) => row.phase === 'admitted');
            if (!settled) await tick();
          } while (!settled && Date.now() < settledDeadline);
          assert.equal(
            settled,
            true,
            'all generated notifications settle before selecting history'
          );
          for (const name of names) {
            const memberId = name + '-id';
            sourceRuntime.set(memberId, runtime.get(memberId)!);
            const cp = await current.rpc(
              'runtime.checkpoint',
              envelope('TEST-capture-' + name, {
                memberId,
                checkpointId: 'TEST-history-A',
                expectedGeneration: generations.get(name),
              })
            );
            assert.equal(cp.ok, true, JSON.stringify(cp));
            const value = record(cp.value);
            assert.equal(value.status, 'published');
            assert.equal(typeof value.reference, 'string');
            restoreSelections[name] = {
              reference: String(value.reference),
              nativeIdentityDigest: identityDigest(name, String(value.reference)),
            };
            const stopped = await current.rpc(
              'runtime.stop',
              envelope('TEST-source-stop-' + name, {
                memberId,
                expectedGeneration: generations.get(name),
              })
            );
            assert.equal(stopped.ok, true);
            assert.equal(record(stopped.value).custody, 'released');
          }
          await current.close();
          hosts.push(current.facts());
          current = undefined;
          cleanupConfirmed = true;
          const countsBeforeRestore = modelRows.map((model) => model.observations.length);
          current = start();
          cleanupConfirmed = false;
          await current.rpc('host.handshake', { protocolVersion: 1 });
          assert.deepEqual(
            modelRows.map((model) => model.observations.length),
            countsBeforeRestore
          );
          for (const name of names) {
            const memberId = name + '-id',
              selected = restoreSelections[name]!;
            const command = envelope('TEST-selected-restore-' + name, {
              memberId,
              reference: selected.reference,
              expectedGeneration: generations.get(name),
            });
            const [restored, duplicate]: [Record<string, unknown>, Record<string, unknown>] =
              await Promise.all([
                current.rpc('runtime.restore', command),
                current.rpc('runtime.restore', command),
              ]);
            assert.ok(restored);
            assert.deepEqual(
              duplicate,
              restored,
              'concurrent original restore shares one allocation/result'
            );
            assert.equal(restored.ok, true, JSON.stringify(restored));
            const state = record(restored.value);
            assert.equal(state.nativeReady, true, `${name} restored native/config/MCP readiness`);
            assert.equal(state.attached, true);
            assert.deepEqual(state.inputs, []);
            assert.equal(typeof state.generation, 'string');
            assert.notEqual(state.generation, generations.get(name));
            const stale = await current.rpc(
              'runtime.stop',
              envelope('TEST-stale-stop-' + name, {
                memberId,
                expectedGeneration: generations.get(name),
              })
            );
            assert.deepEqual(stale, { ok: false, code: 'conflict', outcome: 'rejected' });
            generations.set(name, String(state.generation));
          }
          const afterRestore = record(
            (await current.rpc('team.launch.read', envelope('TEST-after-restore', {}))).value
          );
          assert.equal(afterRestore.ready, 3);
          assert.notEqual(afterRestore.rosterRevision, launch.rosterRevision);
          launch = afterRestore;
        }
      }
      if (exercisePeers) {
        for (const [index, name] of names.entries()) {
          const command = envelope('TEST-human-peer-' + name, {
            operation: 'message.send',
            payload: {
              to: name,
              text: ['NATIVE', 'CODEX', 'OPENCODE'][index] + '_PEER_SEND',
            },
          });
          const receipt: Record<string, unknown> = await current.rpc('team.execute', command);
          assert.equal(receipt.ok, true);
          assert.equal(record(receipt.value).phase, 'completed');
          receipts.push({
            command,
            receipt,
            memberId: name + '-id',
            inputId: record(record(receipt.value).effects).deliveryId,
          });
        }
        const deadline = Date.now() + 75_000;
        let settled = false;
        do {
          for (const model of modelRows) assert.deepEqual(model.failures, []);
          for (const name of names)
            runtime.set(
              name + '-id',
              record(
                (
                  await current.rpc(
                    'runtime.read',
                    envelope('TEST-peer-read', { memberId: name + '-id' })
                  )
                ).value
              )
            );
          const userRows = JSON.parse(
            await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')
          ) as unknown[];
          settled =
            userRows
              .map(record)
              .filter((row) => typeof row.text === 'string' && row.text.startsWith('PEER_'))
              .length === 3 &&
            modelRows.every(
              (model) =>
                model.observations.filter(
                  (row) => row.turn.includes('_PEER_ACK_FROM_') && row.step === 0
                ).length === 2
            ) &&
            [...runtime.values()].every((state) =>
              (state.inputs as unknown[])
                .map(record)
                .every((row) => row.phase === 'terminal' && row.terminal === 'succeeded')
            );
          if (!settled) await tick();
        } while (!settled && Date.now() < deadline);
        assert.equal(
          settled,
          true,
          'six actual native peer deliveries and six peer acknowledgements settle'
        );
        const directory = join(root, 'store/teams/test-native-team/.host-owner/commands');
        const commands = await Promise.all(
          (await readdir(directory)).map(async (file) =>
            record(JSON.parse(await readFile(join(directory, file), 'utf8')))
          )
        );
        const verifyRoute = async (from: string, to: string, text: string, commandId: string) => {
          const inbox = (
            JSON.parse(
              await readFile(
                join(root, 'store/teams/test-native-team/inboxes', to + '.json'),
                'utf8'
              )
            ) as unknown[]
          ).map(record);
          const matches = inbox.filter((row) => row.text === text);
          assert.equal(matches.length, 1);
          assert.equal(matches[0]!.from, from);
          assert.equal(matches[0]!.to, to);
          const command = commands.find((row) => row.commandId === commandId);
          assert.ok(command);
          assert.equal(command.phase, 'completed');
          assert.equal(command.principalId, from + '-session');
          const intent = record(
            JSON.parse(
              await readFile(
                join(
                  root,
                  'store/teams/test-native-team/.host-owner/outbox',
                  String(record(command.effects).deliveryId) + '.json'
                ),
                'utf8'
              )
            )
          );
          assert.equal(record(intent.binding).memberId, to + '-id');
          assert.equal(record(intent.binding).generation, generations.get(to));
          assert.equal(intent.phase, 'admitted');
        };
        for (const [index, to] of names.entries()) {
          for (const from of names.filter((name) => name !== to)) {
            await verifyRoute(
              from,
              to,
              ['NATIVE', 'CODEX', 'OPENCODE'][index] + '_PEER_FROM_' + from.toUpperCase(),
              `TEST-native-peer-${from}-to-${to}`
            );
            await verifyRoute(
              to,
              from,
              ['NATIVE', 'CODEX', 'OPENCODE'][names.indexOf(from)] +
                '_PEER_ACK_FROM_' +
                to.toUpperCase(),
              `TEST-native-peer-${to}-from-${from}-ack`
            );
          }
        }
      }
      const tasks = (await current.rpc('team.tasks.list', envelope('TEST-tasks', null)))
        .value as unknown[];
      assert.equal(tasks.length, 3);
      for (const name of names) {
        const owned = tasks.map(record).filter((task) => task.owner === name);
        assert.equal(owned.length, 1);
        const task = owned[0]!;
        assert.equal(task.status, 'completed');
        assert.equal(task.createdBy, name);
        assert.ok(
          (task.historyEvents as unknown[]).map(record).every((event) => event.actor === name)
        );
        assert.equal(record((task.comments as unknown[])[0]).author, name);
        assert.equal(
          await readFile(join(root, name, 'workspace/native-effect.txt'), 'utf8'),
          'ONE\nTWO\n'
        );
        const activity = record(
          (
            await current.rpc(
              'runtime.activity.snapshot',
              envelope('TEST-activity', { memberId: name + '-id' })
            )
          ).value
        );
        const inputIds = new Set(
          (runtime.get(name + '-id')!.inputs as unknown[]).map(record).map((row) => row.inputId)
        );
        for (const row of receipts.filter((row) => row.memberId === name + '-id'))
          assert.ok(
            inputIds.has(row.inputId) ||
              (sourceRuntime.get(name + '-id')?.inputs as unknown[] | undefined)
                ?.map(record)
                .some((input) => input.inputId === row.inputId)
          );
        for (const inputId of inputIds) {
          assert.match(String(inputId), /^[a-f0-9-]{36}$/);
          const outbox = record(
            JSON.parse(
              await readFile(
                join(
                  root,
                  'store/teams/test-native-team/.host-owner/outbox',
                  String(inputId) + '.json'
                ),
                'utf8'
              )
            )
          );
          assert.equal(
            record(outbox.binding).memberId,
            name + '-id',
            'every input has its own original Team delivery, including system notifications'
          );
          assert.equal(outbox.phase, 'admitted');
        }
        const latest = record(activity.latest);
        const events = [...(latest.text as unknown[]), ...(latest.tools as unknown[])].map(record);
        assert.ok(events.length > 0);
        assert.ok(
          events.every((event) => inputIds.has(event.inputId)),
          'activity cannot cross member/session boundaries'
        );
      }
      const inbox = JSON.parse(
        await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')
      ) as unknown[];
      const replies = inbox
        .map(record)
        .filter((row) => typeof row.text === 'string' && row.text.startsWith('REPLY_'));
      assert.equal(replies.length, 6);
      assert.ok(claudeModel.observations.length > 0);
      assert.ok(
        claudeModel.observations.every((row) => row.requestedModel === 'claude-opus-4-6'),
        'selected model survives actual native checkpoint/restore'
      );
      assert.ok(
        claudeModel.observations.every((row) => row.requestedEffort === 'medium'),
        'selected effort survives actual native checkpoint/restore'
      );
      for (const name of names) assert.equal(replies.filter((row) => row.from === name).length, 2);
      assert.equal(new Set(replies.map((row) => row.messageId)).size, 6);
      if (crossModel) {
        crossProof = await runNativeCrossTeamProof({
          host: current,
          profile,
          root,
          sourceModel: claudeModel,
          targetModel: crossModel,
          sourcePinsBefore: crossSourcePinsBefore,
        });
        runtime.set('alice-id', crossProof.sourceRuntime);
      }
      for (const name of names) {
        if (exerciseRestore) {
          const cp = await current.rpc(
            'runtime.checkpoint',
            envelope('TEST-capture-B-' + name, {
              memberId: name + '-id',
              checkpointId: 'TEST-history-B',
              expectedGeneration: generations.get(name),
            })
          );
          assert.equal(cp.ok, true);
          assert.equal(record(cp.value).status, 'published');
          assert.equal(
            identityDigest(name, String(record(cp.value).reference)),
            restoreSelections[name]!.nativeIdentityDigest,
            `${name} keeps the exact selected native session/thread identity across restart`
          );
          const index = names.indexOf(name);
          assert.ok(
            modelRows[index]!.observations.filter((row) => row.turn.endsWith('_TWO')).every(
              (row) => row.priorTurn
            ),
            `${name} second native model request really contains history A`
          );
        }
        const stopped = await current.rpc(
          'runtime.stop',
          envelope('TEST-stop-' + name, {
            memberId: name + '-id',
            expectedGeneration: generations.get(name),
          })
        );
        assert.equal(stopped.ok, true);
        assert.equal(record(stopped.value).custody, 'released');
      }
      await current.close();
      hosts.push(current.facts());
      current = undefined;
      cleanupConfirmed = true;
      const counts = modelRows.map((model) => model.observations.length);
      current = start();
      cleanupConfirmed = false;
      await current.rpc('host.handshake', { protocolVersion: 1 });
      if (crossProof) await crossProof.verifyAfterRestart(current);
      for (const row of receipts) {
        assert.deepEqual(await current.rpc('team.lookup', row.command), row.receipt);
        assert.deepEqual(await current.rpc('team.execute', row.command), row.receipt);
      }
      for (const name of names) {
        const recovered = record(
          (
            await current.rpc(
              'runtime.read',
              envelope('TEST-recovered', { memberId: name + '-id' })
            )
          ).value
        );
        assert.equal(recovered.attached, false);
        assert.equal(
          (recovered.inputs as unknown[]).length,
          (runtime.get(name + '-id')!.inputs as unknown[]).length
        );
      }
      await current.close();
      hosts.push(current.facts());
      current = undefined;
      cleanupConfirmed = true;
      assert.deepEqual(
        modelRows.map((model) => model.observations.length),
        counts,
        'restart/replay cannot dispatch native inputs'
      );
      assert.deepEqual(
        counts,
        names.map(
          (name) =>
            11 -
            (exerciseCrossTeam && name === 'alice' ? 2 : 0) +
            (exercisePeers ? 5 : 0) +
            (runtime.get(name + '-id')!.inputs as unknown[]).length +
            ((sourceRuntime.get(name + '-id')?.inputs as unknown[] | undefined)?.length ?? 0) -
            2
        )
      );
      if (exerciseCrossTeam)
        assert.deepEqual(await captureNativeCrossTeamSources(), crossSourcePinsBefore);
      passed = true;
    } finally {
      try {
        if (current) {
          await current.close();
          hosts.push(current.facts());
          cleanupConfirmed = true;
        }
      } finally {
        await Promise.allSettled(modelRows.map((model) => model.close()));
        await writeFile(
          join(root, 'receipt.json'),
          JSON.stringify(
            {
              status: passed ? 'PASS' : 'INCOMPLETE',
              root,
              artifacts: {
                source,
                dist,
                entry: await fileHash(entry),
                providerSha256,
                executables,
                harness: await fileHash(import.meta.filename),
              },
              launch,
              hosts,
              cleanupConfirmed,
              exerciseRestore,
              exercisePeers,
              exerciseCrossTeam,
              crossSourcePinsBefore,
              crossSourcePinsAfter: exerciseCrossTeam ? await captureNativeCrossTeamSources() : [],
              crossTeam: crossProof?.evidence,
              restoreSelections,
              sourceRuntime: Object.fromEntries(sourceRuntime),
              businessReceipts: receipts,
              runtime: Object.fromEntries(runtime),
              modelObservations: modelRows.map((model) => model.observations),
              modelFailures: modelRows.map((model) => model.failures),
              scope:
                'One mixed native Claude/Codex/OpenCode Team; aggregate bootstrap, concurrent two-turn work, canonical Task/MCP/message/activity and restart replay' +
                (exerciseCrossTeam
                  ? '; second host-owned Team1 native cross-Team roundtrip and cold no-replay'
                  : ''),
              excluded: [
                'Desktop controls',
                ...(exerciseCrossTeam ? ['group'] : ['second Team/cross-Team/group']),
                ...(exerciseRestore ? [] : ['native history restore']),
                'shared OpenCode host',
                'vendor authentication',
                'whole P0-P8/M01-M19 acceptance',
              ],
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      }
    }
  }
);
