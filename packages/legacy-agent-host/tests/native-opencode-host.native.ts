import {
  uploadNativeMessageImage,
  readNativeMessageImage,
} from './fixtures/native-message-image.ts';
import { execFileSync } from 'node:child_process';
import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import {
  OpenCodeClientFactory,
  createOpenCodeV1DriverFactory,
} from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeV1DriverConfig } from '@agent-teams/provider-implementations/opencode';
import type {
  Session,
  Event,
  OpenConfig,
  CloseReceipt,
} from '@agent-teams/provider-session-contracts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { CONTEXT_MARKER, startOpenCodeModel } from './fixtures/native-opencode-team/model.ts';
import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const normalGo = process.env.LEGACY_NATIVE_OPENCODE_HOST_GO === '1';
const sharedGo = process.env.LEGACY_NATIVE_OPENCODE_SHARED_GO === '1';
assert.ok(!(normalGo && sharedGo), 'select one explicit native OpenCode scenario before any effect');

test(
  'standalone Host stdio routes two business messages through actual OpenCode Runtime and recovers receipts',
  { timeout: 180_000, skip: sharedGo && !normalGo },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_OPENCODE_HOST_GO, '1', 'separate root GO required');
    const repo = resolve(import.meta.dirname, '../../..');
    const pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const observerPath = process.env.LEGACY_NATIVE_FETCH_OBSERVER_PATH;
    const observerSha256 = process.env.LEGACY_NATIVE_FETCH_OBSERVER_SHA256;
    let diagnosticObserver: { path: string; sha256: string } | undefined;
    if (observerPath !== undefined || observerSha256 !== undefined) {
      assert.ok(observerPath);
      assert.match(observerSha256 ?? '', /^[a-f0-9]{64}$/);
      assert.equal(await realpath(observerPath), observerPath);
      assert.equal(await fileHash(observerPath), observerSha256);
      diagnosticObserver = { path: observerPath, sha256: observerSha256! };
    }
    const entry = join(pkg, 'dist/cli.js');
    const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
    assert.ok(artifact);
    const artifacts = {
      ...(diagnosticObserver ? { diagnosticObserver } : {}),
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
        model: await fileHash(join(import.meta.dirname, 'fixtures/native-opencode-team/model.ts')),
        image: await fileHash(join(import.meta.dirname, 'fixtures/native-message-image.ts')),
        png: await fileHash(
          join(import.meta.dirname, 'fixtures/native-claude-team/chat-attachments.ts')
        ),
      },
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
    assert.ok(binary, 'root supplies the exact prequalified OpenCode 1.19.4 executable');
    artifacts.native.path = await realpath(binary);
    artifacts.native.sha256 = await fileHash(artifacts.native.path);
    assert.equal(
      artifacts.native.sha256,
      '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b'
    );

    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-host-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    const diagnosticLog = join(root, 'fetch-diagnostic.jsonl');
    if (diagnosticObserver) await writeFile(diagnosticLog, '', { flag: 'wx', mode: 0o600 });
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
    const model = await startOpenCodeModel({ nativeMessageImage: true });
    t.after(() => model.close());
    // Private native configuration contains only this TEST provider and namespace.
    const nativeConfig = {
      autoupdate: false,
      share: 'disabled',
      enabled_providers: ['TEST-local'],
      model: 'TEST-local/TEST-model',
      small_model: 'TEST-local/TEST-model',
      permission: { '*': 'deny', bash: 'ask' },
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
            'TEST-model': {
              name: 'TEST-model',
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 200000, output: 2000 },
            },
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
    const permissionReplies: Record<string, unknown>[] = [];
    let finalRuntime: Record<string, unknown> = {};
    let activity: Record<string, unknown> = {};
    let activityAfterRestart: Record<string, unknown> = {};
    let imageProof: Awaited<ReturnType<typeof readNativeMessageImage>> | undefined;
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
              protocolRevision: '1.19.4',
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
        startHost({
          node,
          entry,
          root,
          profile: profilePath,
          profileHash: hash(profileBytes),
          ...(diagnosticObserver ? { testImports: [diagnosticObserver.path] } : {}),
        });
      let imageReference: Awaited<ReturnType<typeof uploadNativeMessageImage>> | undefined;
      const command = (label: string) =>
        envelope(`human-native-${label.toLowerCase()}`, {
          operation: 'message.send',
          payload: {
            to: 'carol',
            text: `OPENCODE_TEAM_${label}`,
            ...(label === 'TWO' ? { attachments: [imageReference!] } : {}),
          },
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
      imageReference = await uploadNativeMessageImage(current, envelope, 'carol');
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
          const interactions = (finalRuntime.interactions as unknown[]).map(record);
          const pending = interactions.filter((item) => item.phase === 'pending');
          assert.ok(pending.length <= 1, 'one native permission at a time');
          for (const interaction of pending) {
            assert.equal(interaction.inputId, inputId);
            assert.equal(interaction.kind, 'permission');
            assert.equal(typeof interaction.interactionRef, 'string');
            assert.ok(
              !permissionReplies.some((row) => row.interactionRef === interaction.interactionRef),
              'no permission reply retry'
            );
            const replied: Record<string, unknown> = await current.rpc(
              'runtime.interaction',
              envelope('TEST-allow-' + label, {
                memberId: 'carol-id',
                expectedGeneration: '1',
                inputId,
                interactionRef: interaction.interactionRef,
                reply: { kind: 'permission', decision: 'allow' },
              })
            );
            assert.equal(replied.ok, true);
            const resolved = (record(replied.value).interactions as unknown[])
              .map(record)
              .filter((item) => item.interactionRef === interaction.interactionRef);
            assert.equal(resolved.length, 1);
            assert.equal(resolved[0]!.phase, 'resolved');
            permissionReplies.push({
              inputId,
              interactionRef: interaction.interactionRef,
              replied,
            });
          }
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
        assert.equal(
          permissionReplies.filter((row) => row.inputId === inputId).length,
          1,
          'native Bash permission replied exactly once for original DM'
        );
        assert.deepEqual(await current.rpc('team.execute', command(label)), receipt);
        assert.equal(
          (await current.rpc('runtime.dispatch', envelope('TEST-resume', { memberId: 'carol-id' })))
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
      assert.deepEqual(await readNativeMessageImage(current, envelope, receipts[1]!), imageProof);
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
        let diagnosticFinalVerificationFailure: { name: string; message: string } | undefined;
        let diagnostics: { path: string; sha256: string; sizeBytes: number } | undefined;
        if (diagnosticObserver) {
          try {
            assert.equal(await fileHash(diagnosticObserver.path), diagnosticObserver.sha256);
            diagnostics = {
              path: diagnosticLog,
              sha256: await fileHash(diagnosticLog),
              sizeBytes: (await stat(diagnosticLog)).size,
            };
          } catch (error) {
            diagnosticFinalVerificationFailure = errorFact(error);
          }
        }
        await writeFile(
          join(root, 'receipt.json'),
          JSON.stringify(
            {
              status: passed && !diagnosticFinalVerificationFailure ? 'PASS' : 'INCOMPLETE',
              ...(diagnosticObserver
                ? {
                    diagnosticOnly: true,
                    ordinaryHostQualified: false,
                    diagnostics,
                    diagnosticFinalVerificationFailure,
                  }
                : {}),
              root,
              artifacts,
              hosts,
              cleanupConfirmed,
              primaryFailure,
              cleanupFailure,
              openingReply,
              businessReceipts: receipts,
              imageProof,
              permissionReplies,
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
        if (diagnosticFinalVerificationFailure && !primaryFailure && !cleanupFailure)
          assert.fail('TEST diagnostic final verification failed; original receipt retained');
      }
      if (cleanupFailure && !primaryFailure) throw new Error(cleanupFailure.message);
    }
  }
);

/** Public D/native API scope only. The Host member adapter still owns dedicated servers. */
test(
  'actual public D shares one OpenCode1.19.4 server across two native sessions without closing its neighbor',
  { timeout: 180_000, skip: normalGo && !sharedGo },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_OPENCODE_SHARED_GO, '1');
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
      '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b'
    );
    const nativeVersion = execFileSync(executable.path, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    assert.equal(nativeVersion, '1.19.4');
    const providerArchive = join(
      repo,
      'vendor/provider-migration/readonly-probe-metadata-v1/agent-teams-provider-implementations-0.0.0.tgz'
    );
    assert.equal(
      await fileHash(providerArchive),
      '2aa5d730d6ed8c237b3d94a84ea462c49f773a69b20344e04fa486a99fcfbaae'
    );
    // Same bounded archive/installed-JS comparison as the existing Desktop verifier,
    // kept inside the package test boundary; no UI-helper or runtime import.
    const installed = await realpath(
      join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations')
    );
    const members = execFileSync('/usr/bin/tar', ['-tf', providerArchive], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    })
      .trim()
      .split('\n')
      .filter((name) => /^package\/dist\/.+\.js$/.test(name));
    assert.ok(members.length > 0 && members.length <= 512);
    assert.equal(new Set(members).size, members.length);
    for (const member of members) {
      assert.equal(member.split('/').includes('..'), false);
      assert.deepEqual(
        await readFile(join(installed, member.slice('package/'.length))),
        execFileSync('/usr/bin/tar', ['-xOf', providerArchive, member], {
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      );
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-shared-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const name of ['home', 'tmp', 'workspace', 'config', 'data', 'cache'])
      await mkdir(join(root, name), { mode: 0o700 });
    const model = await startOpenCodeModel({ sharedSessionProbe: true });
    let modelClosed = false;
    t.after(async () => {
      if (!modelClosed) {
        modelClosed = true;
        await model.close();
      }
    });
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done) => reservation.close(() => done()));
    const sharedContext = CONTEXT_MARKER + ':' + basename(root);
    const config = {
      autoupdate: false,
      share: 'disabled',
      enabled_providers: ['TEST-local'],
      model: 'TEST-local/TEST-model',
      small_model: 'TEST-local/TEST-model',
      permission: { '*': 'deny' },
      agent: {
        title: { disable: true },
        summary: { disable: true },
        'TEST-shared': { mode: 'primary', prompt: sharedContext },
      },
      compaction: { auto: false },
      provider: {
        'TEST-local': {
          npm: '@ai-sdk/openai-compatible',
          name: 'TEST shared local',
          options: { baseURL: model.url + '/v1', apiKey: 'TEST-LOCALHOST-ONLY' },
          models: {
            'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } },
          },
        },
      },
    };
    const custody = new CapturedProcess({
      provider: 'opencode',
      cwd: join(root, 'workspace'),
      executable,
      environment: {
        HOME: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        PATH: dirname(node) + ':/usr/bin:/bin',
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: 'TEST-shared-password',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_TELEMETRY: '1',
        OPENCODE_DISABLE_SHARE: '1',
        NO_COLOR: '1',
      },
    });
    const apiCalls: { method: string; path: string; status: number }[] = [];
    const nativeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, endpoint);
      const headers = new Headers(request.headers);
      headers.set('x-opencode-directory', join(root, 'workspace'));
      headers.set(
        'authorization',
        'Basic ' + Buffer.from('opencode:TEST-shared-password').toString('base64')
      );
      const response = await fetch(new Request(request, { headers, redirect: 'error' }));
      apiCalls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    };
    const api = () =>
      new OpenCodeClientFactory({ fetchImpl: nativeFetch }).create(endpoint, {
        signal: AbortSignal.timeout(10_000),
        remainingMs: () => 10_000,
      });
    const opened: {
      role: 'A' | 'B';
      nativeSessionId: string;
      driver: Session;
      events: Event[];
      observer: Promise<void>;
      closeAttempted: boolean;
    }[] = [];
    const closeReceipts: { role: string; receipt?: CloseReceipt; failure?: string }[] = [],
      observerFailures: string[] = [];
    let child: ReturnType<CapturedProcess['launch']> | undefined,
      completed = false,
      cleanupConfirmed = false;
    let cleanupCalls = 0,
      nativeLaunchAttempts = 0,
      nativeCreateAttempts = 0;
    const createdNative: { role: string; id: string; directory: string | undefined }[] = [];
    let primaryFailure: unknown,
      cleanupFailure: unknown,
      afterAClose: Record<string, unknown> | undefined;
    const closeOnce = async (actor: (typeof opened)[number]) => {
      assert.equal(actor.closeAttempted, false);
      actor.closeAttempted = true;
      const entry: (typeof closeReceipts)[number] = { role: actor.role };
      closeReceipts.push(entry);
      try {
        entry.receipt = await actor.driver.close();
        return entry.receipt;
      } catch (error) {
        entry.failure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    const artifacts = {
      executable,
      nativeVersion,
      node: { path: node, sha256: await fileHash(node) },
      providerArchive,
      providerSha256: await fileHash(providerArchive),
      harnessSha256: await fileHash(import.meta.filename),
      modelSha256: await fileHash(
        join(import.meta.dirname, 'fixtures/native-opencode-team/model.ts')
      ),
      helperSha256: await fileHash(join(import.meta.dirname, 'fixtures/native-host.ts')),
      processOwnerSourceSha256: await fileHash(
        join(repo, 'packages/legacy-agent-host/src/adapters/providers/CapturedProcess.ts')
      ),
      processOwnerDistSha256: await fileHash(
        join(repo, 'packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js')
      ),
    };
    await writeFile(
      join(root, 'prepared.json'),
      JSON.stringify(
        {
          root,
          endpoint,
          artifacts,
          nativeCreates: 2,
          nativeInputs: 3,
          scope:
            'Actual single OpenCode server, public D two native sessions; inference alone scripted; no production Host shared pool',
        },
        null,
        2
      ),
      { flag: 'wx', mode: 0o600 }
    );
    try {
      nativeLaunchAttempts++;
      child = custody.launch({
        command: executable.path,
        cwd: join(root, 'workspace'),
        args: ['serve', '--hostname', '127.0.0.1', '--port', String(address.port)],
      });
      child.stdout.on('data', () => {});
      const readyUntil = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < readyUntil && custody.isRunning()) {
        try {
          const effective = record(await api().getConfig());
          if (
            effective.model === 'TEST-local/TEST-model' &&
            record(record(effective.agent)['TEST-shared']).prompt === sharedContext
          ) {
            ready = true;
            break;
          }
        } catch {
          /* only read-only startup probe */
        }
        await tick();
      }
      assert.equal(ready, true, 'actual selected native server is available');
      for (const role of ['A', 'B'] as const) {
        // Each mutation is sent once. An uncertain create never triggers replacement.
        assert.equal(custody.isRunning(), true);
        nativeCreateAttempts++;
        const native = await api().createSession({ title: 'TEST shared ' + role });
        createdNative.push({ role, id: native.id, directory: native.directory });
        assert.match(native.id, /^ses_[A-Za-z0-9]+$/);
        assert.equal(native.directory, join(root, 'workspace'));
        const request: OpenConfig = {
          tenantId: 'TEST-tenant',
          projectId: 'TEST-project',
          sessionId: 'TEST-driver-' + role,
          generation: 1,
          configRevision: 'TEST-r1',
          requiredCapabilities: ['text'],
        };
        const selected: OpenCodeV1DriverConfig = {
          endpoint,
          version: '1.19.4',
          workspacePath: join(root, 'workspace'),
          nativeSessionId: native.id,
          trustedBinding: 'TEST-shared-' + role,
          accountBinding: 'TEST-account',
          profileBinding: 'TEST-profile-' + role,
          runBinding: 'TEST-run',
          configRevision: request.configRevision,
          binding: {
            tenantId: request.tenantId,
            projectId: request.projectId,
            sessionId: request.sessionId,
            generation: request.generation,
          },
          model: { providerID: 'TEST-local', modelID: 'TEST-model' },
          agent: 'TEST-shared',
          limits: {
            queuedInputs: 2,
            inputBytes: 8192,
            outputBytes: 1_000_000,
            outputEvents: 1000,
            pendingInteractions: 2,
            timeoutMs: 45_000,
          },
          fetchImpl: nativeFetch,
          probe: async () => {
            const current = await api().getSession(native.id);
            return (
              custody.isRunning() &&
              current.id === native.id &&
              current.directory === join(root, 'workspace')
            );
          },
          // A logical session close cannot claim release of a still-live shared backing.
          // No manager/reference counter is invented by this test.
          confirmStopped: async () => false,
        };
        const factory = createOpenCodeV1DriverFactory({
          capabilities: ['text', 'interrupt'],
          resolveConfiguration: async () => selected,
          readCheckpoint: async () => undefined,
        });
        const result = await factory.open(request),
          events: Event[] = [];
        const observer = (async () => {
          for await (const event of result.driver.observe()) events.push(event);
        })().catch((error) => {
          observerFailures.push(error instanceof Error ? error.message : String(error));
        });
        opened.push({
          role,
          nativeSessionId: native.id,
          driver: result.driver,
          events,
          observer,
          closeAttempted: false,
        });
      }
      assert.notEqual(opened[0]!.nativeSessionId, opened[1]!.nativeSessionId);
      assert.notEqual(opened[0]!.driver.sessionRef, opened[1]!.driver.sessionRef);
      const turn = async (actor: (typeof opened)[number], label: 'A1' | 'B1' | 'B2') => {
        const inputId = 'TEST_SHARED_OPENCODE_' + label,
          operationRef = 'TEST-operation-' + label;
        assert.ok((await actor.driver.submit({ inputId, operationRef, content: inputId })).ok);
        const end = Date.now() + 45_000;
        while (
          Date.now() < end &&
          !actor.events.some((event) => event.kind === 'result' && event.inputId === inputId)
        ) {
          assert.deepEqual(model.failures, []);
          await tick();
        }
        const own = actor.events.filter((event) => event.inputId === inputId);
        assert.equal(
          own.filter((event) => event.kind === 'result' && event.outcome === 'succeeded').length,
          1
        );
        assert.ok(
          own.some((event) => event.kind === 'text' && event.text.includes('REPLY_' + inputId))
        );
        assert.ok(
          own.every(
            (event) =>
              event.sessionRef === actor.driver.sessionRef && event.operationRef === operationRef
          )
        );
        assert.equal(
          opened
            .find((other) => other !== actor)!
            .events.some((event) => event.inputId === inputId),
          false
        );
      };
      await turn(opened[0]!, 'A1');
      await turn(opened[1]!, 'B1');
      const aClose = await closeOnce(opened[0]!);
      assert.deepEqual(aClose, { logicallyClosed: true, cleanup: 'unknown' });
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(custody.isRunning(), true);
      const nativeB = await api().getSession(opened[1]!.nativeSessionId);
      assert.equal(nativeB.id, opened[1]!.nativeSessionId);
      afterAClose = {
        aClose,
        originalServeAlive: true,
        nativeBId: nativeB.id,
        bCloseAttempted: opened[1]!.closeAttempted,
      };
      await turn(opened[1]!, 'B2');
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(custody.isRunning(), true);
      assert.deepEqual(await closeOnce(opened[1]!), { logicallyClosed: true, cleanup: 'unknown' });
      assert.equal(
        apiCalls.filter((call) => call.method === 'POST' && call.path === '/session').length,
        2
      );
      assert.deepEqual(
        model.observations.map((value) => value.turn),
        ['TEST_SHARED_OPENCODE_A1', 'TEST_SHARED_OPENCODE_B1', 'TEST_SHARED_OPENCODE_B2']
      );
      assert.deepEqual(model.failures, []);
      assert.deepEqual(observerFailures, []);
      completed = true;
    } catch (error) {
      primaryFailure = error;
    } finally {
      for (const actor of opened)
        if (!actor.closeAttempted) {
          try {
            await closeOnce(actor);
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
      try {
        cleanupCalls++;
        cleanupConfirmed = await custody.confirmStopped();
      } catch (error) {
        cleanupFailure ??= error;
      }
      await Promise.all(opened.map((actor) => actor.observer));
      modelClosed = true;
      try {
        await model.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            status:
              completed &&
              cleanupConfirmed &&
              !cleanupFailure &&
              !model.failures.length &&
              !observerFailures.length
                ? 'PASS'
                : 'INCOMPLETE',
            root,
            artifacts,
            scope:
              'Actual native OpenCode1.19.4 + public D shared-endpoint two-session isolation. A close retains UNKNOWN whole-backing cleanup; B next attributed input/reply succeeds; final only original held process owner cleanup.',
            hostSharedReferenceManagement: 'UNSUPPORTED_CURRENT_DEDICATED_HOST_ADAPTER',
            fullPlanSharedCustodyClaim: false,
            primaryFailure:
              primaryFailure instanceof Error ? primaryFailure.message : primaryFailure,
            cleanupFailure:
              cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure,
            originalServe: {
              pid: child?.pid,
              exitCode: child?.exitCode,
              signalCode: child?.signalCode,
            },
            cleanupConfirmed,
            cleanupCalls,
            cleanupOwner:
              'existing CapturedProcess owns only the original held OpenCode child; no adopted PID or SDK root',
            nativeLaunchAttempts,
            nativeCreateAttempts,
            createdNative,
            afterAClose,
            closeReceipts,
            apiCalls,
            modelObservations: model.observations,
            modelFailures: model.failures,
            observerFailures,
            actors: opened.map((actor) => ({
              role: actor.role,
              nativeSessionId: actor.nativeSessionId,
              sessionRef: actor.driver.sessionRef,
              closeAttempted: actor.closeAttempted,
              events: actor.events,
            })),
            excluded: [
              'production Host shared pool/reference manager',
              'MCP/Team/bootstrap/UI',
              'native A session deletion',
              'full F06/Stage1',
              'Stage2',
            ],
          },
          null,
          2
        ),
        { flag: 'wx', mode: 0o600 }
      );
    }
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailure) throw cleanupFailure;
    assert.equal(
      cleanupConfirmed,
      true,
      'only original captured OpenCode process owner cleanup may settle final physical custody'
    );
  }
);
