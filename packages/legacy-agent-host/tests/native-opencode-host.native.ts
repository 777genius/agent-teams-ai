import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { CONTEXT_MARKER, startOpenCodeModel } from './fixtures/native-opencode-team/model.ts';
import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

test(
  'standalone Host stdio routes two business messages through actual OpenCode Runtime and recovers receipts',
  { timeout: 180_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_OPENCODE_HOST_GO, '1', 'separate root GO required');
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
      harness: {
        sha256: await fileHash(import.meta.filename),
        modelSha256: await fileHash(
          join(import.meta.dirname, 'fixtures/native-opencode-team/model.ts')
        ),
        helperSha256: await fileHash(join(import.meta.dirname, 'fixtures/native-host.ts')),
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
    const binary = process.env.LEGACY_NATIVE_OPENCODE_PATH;
    assert.ok(binary, 'root supplies the exact prequalified OpenCode 1.18.35 executable');
    artifacts.native.path = await realpath(binary);
    artifacts.native.sha256 = await fileHash(artifacts.native.path);
    assert.equal(
      artifacts.native.sha256,
      '8c3c351b138cfe35905ab11846a1373f1beea590aee7eda412fb765b72c79d82'
    );

    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-host-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const directory of [
      'home',
      'opencode-home',
      'tmp',
      'workspace',
      'store',
      'xdg-config',
      'xdg-data',
      'xdg-cache',
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    const model = await startOpenCodeModel();
    t.after(() => model.close());
    // Private native configuration contains only this TEST provider and namespace.
    const nativeConfig = {
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
          name: 'TEST local',
          options: { baseURL: `${model.url}/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
          models: {
            'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } },
          },
        },
      },
    };
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done) => reservation.close(() => done()));
    let current: ReturnType<typeof startHost> | undefined;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    const receipts: Record<string, unknown>[] = [];
    let finalRuntime: Record<string, unknown> = {};
    let activity: Record<string, unknown> = {};
    let activityAfterRestart: Record<string, unknown> = {};
    let passed = false;
    let primaryFailure: { name: string; message: string } | undefined;
    let cleanupFailure: { name: string; message: string } | undefined;
    let openingReply: Record<string, unknown> | undefined;
    const errorFact = (error: unknown) =>
      error instanceof Error
        ? { name: error.name, message: error.message.slice(0, 2000) }
        : { name: 'UnknownError', message: 'Non-error TEST failure' };
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
      const delivery = {
        ...teamBinding,
        runId: scope.runId,
        memberId: 'carol-id',
        generation: '1',
      };
      const profile: TeamHostProfile = {
        schemaVersion: 1,
        owner,
        principalId: 'human',
        teams: [
          {
            scope,
            binding: teamBinding,
            members: [{ memberId: 'carol-id', name: 'carol', role: 'member', delivery }],
            grants: [
              {
                principalId: 'human',
                memberName: 'user',
                permissions: ['read', 'message.write', 'task.write', 'admin'],
              },
              {
                principalId: 'carol-session',
                memberName: 'carol',
                permissions: ['read', 'message.write', 'task.write'],
              },
            ],
          },
        ],
        runtime: {
          members: [
            {
              teamId: scope.teamId,
              memberId: 'carol-id',
              principalId: 'carol-session',
              provider: 'opencode',
              protocolRevision: '1.18.35',
              sessionId: `TEST-session-${namespace}`,
              generation: 1,
              configRevision: 'TEST-config-1',
              cwd: join(root, 'workspace'),
              model: 'TEST-model',
              endpoint,
              accountBinding: 'TEST-dummy-account',
              executable: artifacts.native,
              environment: {
                HOME: join(root, 'home'),
                TMPDIR: join(root, 'tmp'),
                XDG_CONFIG_HOME: join(root, 'xdg-config'),
                XDG_DATA_HOME: join(root, 'xdg-data'),
                XDG_CACHE_HOME: join(root, 'xdg-cache'),
                PATH: `${dirname(node)}:/usr/bin:/bin`,
                SHELL: '/bin/sh',
                OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeConfig),
                OPENCODE_DISABLE_MODELS_FETCH: '1',
                OPENCODE_DISABLE_AUTOUPDATE: '1',
                OPENCODE_DISABLE_TELEMETRY: '1',
                OPENCODE_DISABLE_SHARE: '1',
                NO_COLOR: '1',
              },
              nativeOptions: {
                providerId: 'TEST-local',
                agent: 'TEST-member',
                instructions: `${CONTEXT_MARKER}. You are carol of test-native-team working only in ${join(root, 'workspace')}.`,
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
      const command = (label: string) =>
        envelope(`human-native-${label.toLowerCase()}`, {
          operation: 'message.send',
          payload: { to: 'carol', text: `OPENCODE_TEAM_${label}` },
        });
      current = start();
      const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
      const opened = await current.rpc(
        'runtime.open',
        envelope('TEST-open', { memberId: 'carol-id' })
      );
      openingReply = opened;
      assert.equal(opened.ok, true);
      assert.equal(
        record(opened.value).nativeReady,
        true,
        'actual D native mandatory MCP discovery'
      );
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
            envelope('TEST-read', { memberId: 'carol-id' })
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
          (await current.rpc('runtime.dispatch', envelope('TEST-resume', { memberId: 'carol-id' })))
            .ok,
          true
        );
      }
      const listed = await current.rpc('team.tasks.list', envelope('TEST-list', null));
      assert.equal(listed.ok, true);
      const tasks = listed.value as unknown[];
      assert.equal(tasks.length, 1);
      const task = record(tasks[0]);
      assert.equal(task.status, 'completed');
      assert.equal(task.owner, 'carol');
      assert.equal(task.createdBy, 'carol');
      assert.deepEqual(
        (task.historyEvents as unknown[]).map(record).map((item) => item.actor),
        ['carol', 'carol', 'carol', 'carol']
      );
      assert.equal((task.comments as unknown[]).length, 1);
      assert.equal(record((task.comments as unknown[])[0]).author, 'carol');
      const inbox = JSON.parse(
        await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')
      ) as unknown[];
      assert.deepEqual(
        inbox.map(record).map(({ from, text }) => ({ from, text })),
        [
          { from: 'carol', text: 'REPLY_OPENCODE_ONE' },
          { from: 'carol', text: 'REPLY_OPENCODE_TWO' },
        ]
      );
      assert.equal(new Set(inbox.map(record).map((item) => item.messageId)).size, 2);
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
      assert.equal(model.observations.length, 11);
      assert.deepEqual(model.failures, []);
      assert.ok(model.observations.every((item) => item.contextEffective));
      assert.ok(
        model.observations
          .filter((item) => item.turn === 'OPENCODE_TEAM_TWO')
          .every((item) => item.priorTurn)
      );
      const activityReply = await current.rpc(
        'runtime.activity.snapshot',
        envelope('TEST-activity', { memberId: 'carol-id' })
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
        envelope('TEST-stop', { memberId: 'carol-id' })
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
        envelope('TEST-recovered', { memberId: 'carol-id' })
      );
      assert.equal(recovered.ok, true);
      assert.equal(record(recovered.value).attached, false);
      assert.equal((record(recovered.value).inputs as unknown[]).length, 2);
      const replayedActivity = await current.rpc(
        'runtime.activity.feed',
        envelope('TEST-activity-after-restart', { memberId: 'carol-id', cursor: activityCursor })
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
            envelope('TEST-recover-outbox', { memberId: 'carol-id' })
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
    } catch (error) {
      primaryFailure = errorFact(error);
      throw error;
    } finally {
      let cleanupConfirmed = current === undefined;
      try {
        if (current) {
          await current.close();
          cleanupConfirmed = true;
        }
      } catch (error) {
        cleanupFailure = errorFact(error);
      } finally {
        if (current) hosts.push(current.facts());
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
              primaryFailure,
              cleanupFailure,
              openingReply,
              businessReceipts: receipts,
              runtime: finalRuntime,
              activity,
              activityAfterRestart,
              modelObservations: model.observations,
              modelFailures: model.failures,
              scope:
                'Standalone Host stdio + RuntimeTeamCoordinator + public D + actual OpenCode native/MCP, single member',
              excluded: [
                'Desktop UI',
                'mixed providers',
                'whole P4',
                'aggregate team bootstrap',
                'shared OpenCode backing isolation',
                'native history restore',
                'real authentication',
              ],
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      }
      if (cleanupFailure && !primaryFailure) throw new Error(cleanupFailure.message);
    }
  }
);
