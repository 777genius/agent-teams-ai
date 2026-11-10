import {
  uploadNativeMessageImage,
  readNativeMessageImage,
} from './fixtures/native-message-image.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { CONTEXT_MARKER, record, startCodexModel } from './fixtures/native-codex-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

test(
  'standalone Host stdio routes two business messages through actual Codex Runtime and recovers receipts',
  { timeout: 180_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_CODEX_HOST_GO, '1', 'separate root GO required');
    const repo = resolve(import.meta.dirname, '../../..');
    const pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const entry = join(pkg, 'dist/cli.js');
    const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
    assert.ok(artifact);
    const artifacts = {
      node: { path: node, sha256: await fileHash(node) },
      provider: { path: await realpath(resolve(repo, artifact)), sha256: '' },
      host: {
        entry,
        entrySha256: await fileHash(entry),
        sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
        distSha256: await treeHash(join(pkg, 'dist'), '.js'),
      },
      native: { path: '', sha256: '' },
      fixtureSources: {
        test: await fileHash(import.meta.filename),
        model: await fileHash(join(import.meta.dirname, 'fixtures/native-codex-team/model.ts')),
        image: await fileHash(join(import.meta.dirname, 'fixtures/native-message-image.ts')),
        png: await fileHash(
          join(import.meta.dirname, 'fixtures/native-claude-team/chat-attachments.ts')
        ),
      },
    };
    artifacts.provider.sha256 = await fileHash(artifacts.provider.path);
    assert.match(process.env.LEGACY_NATIVE_PROVIDER_SHA256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(artifacts.provider.sha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256);
    for (const [actual, expected] of [
      [artifacts.host.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256],
      [artifacts.host.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256],
    ]) {
      assert.match(expected ?? '', /^[a-f0-9]{64}$/);
      assert.equal(actual, expected);
    }
    const binary = process.env.LEGACY_NATIVE_CODEX_PATH;
    assert.ok(binary, 'root supplies the exact prequalified Codex 0.162.0 executable');
    artifacts.native.path = await realpath(binary);
    artifacts.native.sha256 = await fileHash(artifacts.native.path);
    assert.equal(
      artifacts.native.sha256,
      '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57'
    );

    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-codex-host-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const directory of [
      'home',
      'codex-home',
      'tmp',
      'workspace',
      'store',
      'xdg-config',
      'xdg-data',
      'xdg-cache',
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    const model = await startCodexModel({ nativeMessageImage: true });
    t.after(() => model.close());
    // Only the fresh TEST namespace is written. Production supplies Team MCP through captured CLI flags.
    await writeFile(
      join(root, 'codex-home/config.toml'),
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
set = { HOME = ${JSON.stringify(join(root, 'home'))}, TMPDIR = ${JSON.stringify(join(root, 'tmp'))}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST local fixture"
base_url = ${JSON.stringify(model.url + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
      { mode: 0o600 }
    );
    let current: ReturnType<typeof startHost> | undefined;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    const receipts: Record<string, unknown>[] = [];
    let finalRuntime: Record<string, unknown> = {};
    let activity: Record<string, unknown> = {};
    let activityAfterRestart: Record<string, unknown> = {};
    let imageProof: Awaited<ReturnType<typeof readNativeMessageImage>> | undefined;
    let passed = false;
    try {
      const namespace = basename(root);
      const owner = {
        ownerId: `TEST-owner-${namespace}`,
        revision: 'TEST-revision',
        storageRoot: join(root, 'store'),
        profileId: `TEST-profile-${namespace}`,
        protocolVersion: 1 as const,
        buildId: 'TEST-native-host',
        nodeSha256: artifacts.node.sha256,
        hostEntrySha256: artifacts.host.entrySha256,
      };
      const scope = {
        projectId: `TEST-project-${namespace}`,
        workspaceId: `TEST-workspace-${namespace}`,
        teamId: 'TEST-team',
        runId: `TEST-run-${namespace}`,
        memberId: 'human',
        generation: '1',
      };
      const teamBinding = {
        backendId: owner.ownerId,
        teamId: scope.teamId,
        teamName: 'test-native-team',
      };
      const delivery = { ...teamBinding, runId: scope.runId, memberId: 'bob-id', generation: '1' };
      const profile: TeamHostProfile = {
        schemaVersion: 1,
        owner,
        principalId: 'human',
        teams: [
          {
            scope,
            binding: teamBinding,
            members: [{ memberId: 'bob-id', name: 'bob', role: 'member', delivery }],
            grants: [
              {
                principalId: 'human',
                memberName: 'user',
                permissions: ['read', 'message.write', 'task.write', 'admin'],
              },
              {
                principalId: 'bob-session',
                memberName: 'bob',
                permissions: ['read', 'message.write', 'task.write'],
              },
            ],
          },
        ],
        runtime: {
          members: [
            {
              teamId: scope.teamId,
              memberId: 'bob-id',
              principalId: 'bob-session',
              provider: 'codex',
              protocolRevision: '0.162.0',
              sessionId: `TEST-session-${namespace}`,
              generation: 1,
              configRevision: 'TEST-config-1',
              cwd: join(root, 'workspace'),
              model: 'mock-model',
              accountBinding: 'TEST-dummy-account',
              executable: artifacts.native,
              environment: {
                HOME: join(root, 'home'),
                CODEX_HOME: join(root, 'codex-home'),
                TMPDIR: join(root, 'tmp'),
                XDG_CONFIG_HOME: join(root, 'xdg-config'),
                XDG_DATA_HOME: join(root, 'xdg-data'),
                XDG_CACHE_HOME: join(root, 'xdg-cache'),
                PATH: `${dirname(node)}:/usr/bin:/bin`,
                SHELL: '/bin/sh',
                TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
              },
              nativeOptions: {
                approvalPolicy: 'never',
                sandbox: 'workspace-write',
                modelProvider: 'TEST_fixture',
                developerInstructions: `${CONTEXT_MARKER}. You are bob of test-native-team working only in ${join(root, 'workspace')}.`,
              },
              limits: {
                queuedInputs: 2,
                inputBytes: 8192,
                outputBytes: 1_000_000,
                outputEvents: 1500,
                pendingInteractions: 4,
                timeoutMs: 45_000,
              },
            },
          ],
        },
      };
      const profilePath = join(root, 'profile.json');
      const profileBytes = JSON.stringify(profile);
      await writeFile(profilePath, profileBytes, { mode: 0o600 });
      const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
      const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
      const start = () =>
        startHost({ node, entry, root, profile: profilePath, profileHash: hash(profileBytes) });
      let imageReference: Awaited<ReturnType<typeof uploadNativeMessageImage>> | undefined;
      const command = (label: string) =>
        envelope(`human-native-${label.toLowerCase()}`, {
          operation: 'message.send',
          payload: {
            to: 'bob',
            text: `CODEX_TEAM_${label}`,
            ...(label === 'TWO' ? { attachments: [imageReference!] } : {}),
          },
        });
      current = start();
      const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
      const opened = await current.rpc(
        'runtime.open',
        envelope('TEST-open', { memberId: 'bob-id' })
      );
      assert.equal(opened.ok, true);
      assert.equal(
        record(opened.value).nativeReady,
        true,
        'actual D native mandatory MCP discovery'
      );
      imageReference = await uploadNativeMessageImage(current, envelope, 'bob');
      for (const label of ['ONE', 'TWO']) {
        const receipt = await current.rpc('team.execute', command(label));
        assert.equal(receipt.ok, true);
        assert.equal(record(receipt.value).phase, 'completed');
        receipts.push(receipt);
        const inputId = record(record(receipt.value).effects).deliveryId;
        assert.equal(typeof inputId, 'string');
        const deadline = Date.now() + 60_000;
        let terminal = false;
        while (Date.now() < deadline) {
          assert.deepEqual(model.failures, []);
          const read: Record<string, unknown> = await current.rpc(
            'runtime.read',
            envelope('TEST-read', { memberId: 'bob-id' })
          );
          assert.equal(read.ok, true);
          finalRuntime = record(read.value);
          const input = (finalRuntime.inputs as unknown[])
            .map(record)
            .find((item) => item.inputId === inputId);
          if (input?.phase === 'terminal') {
            assert.equal(input.terminal, 'succeeded');
            terminal = true;
            break;
          }
          await tick();
        }
        assert.equal(terminal, true, 'bounded native input reaches durable terminal');
        assert.deepEqual(await current.rpc('team.execute', command(label)), receipt);
        assert.equal(
          (await current.rpc('runtime.dispatch', envelope('TEST-resume', { memberId: 'bob-id' })))
            .ok,
          true
        );
      }
      imageProof = await readNativeMessageImage(current, envelope, receipts[1]!);
      assert.equal(model.observations.filter((row) => row.nativeImage).length, 3);
      const listed = await current.rpc('team.tasks.list', envelope('TEST-list', null));
      assert.equal(listed.ok, true);
      const tasks = listed.value as unknown[];
      assert.equal(tasks.length, 1);
      const task = record(tasks[0]);
      assert.equal(task.status, 'completed');
      assert.equal(task.owner, 'bob');
      assert.equal(task.createdBy, 'bob');
      assert.deepEqual(
        (task.historyEvents as unknown[]).map(record).map((item) => item.actor),
        ['bob', 'bob', 'bob', 'bob']
      );
      assert.equal((task.comments as unknown[]).length, 1);
      assert.equal(record((task.comments as unknown[])[0]).author, 'bob');
      const inbox = JSON.parse(
        await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')
      ) as unknown[];
      assert.deepEqual(
        inbox.map(record).map(({ from, text }) => ({ from, text })),
        [
          { from: 'bob', text: 'REPLY_CODEX_ONE' },
          { from: 'bob', text: 'REPLY_CODEX_TWO' },
        ]
      );
      assert.equal(new Set(inbox.map(record).map((item) => item.messageId)).size, 2);
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
      assert.equal(model.observations.length, 11);
      assert.deepEqual(model.failures, []);
      assert.ok(model.observations.every((item) => item.contextEffective));
      assert.ok(
        model.observations
          .filter((item) => item.turn === 'CODEX_TEAM_TWO')
          .every((item) => item.priorTurn)
      );
      const activityReply = await current.rpc(
        'runtime.activity.snapshot',
        envelope('TEST-activity', { memberId: 'bob-id' })
      );
      assert.equal(activityReply.ok, true);
      activity = record(activityReply.value);
      const latest = record(activity.latest);
      const inputs = new Set(
        receipts.map((receipt) => record(record(receipt.value).effects).deliveryId)
      );
      const text = (latest.text as unknown[]).map(record);
      const tools = (latest.tools as unknown[]).map(record);
      assert.ok(text.length > 0, 'actual native text reaches durable Host activity');
      assert.ok(
        tools.some((event) => record(event.data).kind === 'tool'),
        'native tool calls reach Host activity'
      );
      assert.ok(
        tools.some(
          (event) =>
            record(event.data).kind === 'tool-result' && record(event.data).isError === true
        ),
        'native Bash exit7 remains a failed tool result, independently of successful input terminal'
      );
      for (const event of [...text, ...tools])
        assert.ok(inputs.has(event.inputId), 'activity keeps exact business input attribution');
      const activityCursor = activity.cursor;
      assert.equal(typeof activityCursor, 'string');
      const stopped = await current.rpc(
        'runtime.stop',
        envelope('TEST-stop', { memberId: 'bob-id' })
      );
      assert.equal(stopped.ok, true);
      finalRuntime = record(stopped.value);
      assert.equal(finalRuntime.phase, 'closed');
      assert.equal(finalRuntime.custody, 'released');
      await current.close();
      hosts.push(current.facts());
      current = undefined;
      const requestsBeforeRestart = model.observations.length;
      current = start();
      await current.rpc('host.handshake', { protocolVersion: 1 });
      for (const [index, label] of ['ONE', 'TWO'].entries()) {
        assert.deepEqual(await current.rpc('team.lookup', command(label)), receipts[index]);
        assert.deepEqual(await current.rpc('team.execute', command(label)), receipts[index]);
      }
      const recovered = await current.rpc(
        'runtime.read',
        envelope('TEST-recovered', { memberId: 'bob-id' })
      );
      assert.equal(recovered.ok, true);
      assert.equal(record(recovered.value).attached, false);
      assert.deepEqual(await readNativeMessageImage(current, envelope, receipts[1]!), imageProof);
      assert.equal((record(recovered.value).inputs as unknown[]).length, 2);
      const replayedActivity = await current.rpc(
        'runtime.activity.feed',
        envelope('TEST-activity-after-restart', { memberId: 'bob-id', cursor: activityCursor })
      );
      assert.equal(replayedActivity.ok, true);
      activityAfterRestart = record(replayedActivity.value);
      assert.equal(
        record(activityAfterRestart.gap).reason,
        'incarnation',
        'old cursor explicitly requires rehydration after host restart'
      );
      assert.equal(
        (
          await current.rpc(
            'runtime.dispatch',
            envelope('TEST-recover-outbox', { memberId: 'bob-id' })
          )
        ).ok,
        true
      );
      await current.close();
      hosts.push(current.facts());
      current = undefined;
      assert.equal(
        model.observations.length,
        requestsBeforeRestart,
        'recovered receipts/outbox never launch or resubmit native inputs'
      );
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
      passed = true;
    } finally {
      let cleanupConfirmed = current === undefined;
      try {
        if (current) {
          await current.close();
          cleanupConfirmed = true;
          hosts.push(current.facts());
        }
      } finally {
        await model.close();
        await writeFile(
          join(root, 'receipt.json'),
          JSON.stringify(
            {
              status: passed ? 'PASS' : 'INCOMPLETE',
              root,
              artifacts,
              hosts,
              cleanupConfirmed,
              businessReceipts: receipts,
              imageProof,
              runtime: finalRuntime,
              activity,
              activityAfterRestart,
              modelObservations: model.observations,
              modelFailures: model.failures,
              scope:
                'Standalone Host stdio + RuntimeTeamCoordinator + public D + actual Codex native/MCP, single member',
              excluded: [
                'Desktop UI',
                'mixed providers',
                'whole P4',
                'aggregate team bootstrap',
                'real authentication',
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
