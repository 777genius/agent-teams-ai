import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CONTEXT_MARKER,
  record,
  startNativeTeamModel,
} from './fixtures/native-claude-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

test(
  'fresh saved Team capture launches its prompt through actual Claude and cold-replays without allocation',
  { timeout: 180_000 },
  async (t) => {
    assert.equal(process.env.LEGACY_NATIVE_CLAUDE_CAPTURE_GO, '1', 'separate root GO required');
    const repo = resolve(import.meta.dirname, '../../..');
    const pkg = join(repo, 'packages/legacy-agent-host');
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(await realpath(process.execPath), node);
    const entry = join(pkg, 'dist/cli.js');
    const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
    assert.equal(
      artifact,
      'vendor/provider-migration/claude-probe-v3/agent-teams-provider-implementations-0.0.0.tgz'
    );
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
    };
    artifacts.provider.sha256 = await fileHash(artifacts.provider.path);
    assert.equal(
      artifacts.provider.sha256,
      '543cfa030a0d0cda0c5b091c207906c6f175ed6cd9eec28090094ff0b085af59'
    );
    assert.match(process.env.LEGACY_NATIVE_PROVIDER_SHA256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(artifacts.provider.sha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256);
    for (const [actual, expected] of [
      [artifacts.host.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256],
      [artifacts.host.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256],
    ]) {
      assert.match(expected ?? '', /^[a-f0-9]{64}$/);
      assert.equal(actual, expected);
    }
    // Resolve exactly as pinned SDK query does; never select a PATH executable.
    const providerRequire = createRequire(
      import.meta.resolve('@agent-teams/provider-implementations/claude')
    );
    const sdk = providerRequire.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkRequire = createRequire(sdk);
    artifacts.native.path = await realpath(
      sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
    );
    artifacts.native.sha256 = await fileHash(artifacts.native.path);
    assert.equal(
      artifacts.native.sha256,
      'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f'
    );
    assert.equal(
      record(JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8')) as unknown)
        .version,
      '0.3.305'
    );
    assert.match(process.env.LEGACY_NATIVE_CLAUDE_SHA256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(artifacts.native.sha256, process.env.LEGACY_NATIVE_CLAUDE_SHA256);

    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-claude-capture-')));
    t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
    for (const directory of [
      'home',
      'config',
      'tmp',
      'workspace',
      'store',
      'xdg-config',
      'xdg-data',
      'xdg-cache',
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    const model = await startNativeTeamModel({
      allowModelProbes: true,
      principalId: () => {
        const state = record(
          JSON.parse(
            readFileSync(join(root, 'store/teams/test-native-team/.host-owner/state.json'), 'utf8')
          ) as unknown
        );
        const captures = (state.runtimeCaptures as unknown[]).map(record);
        const capture = captures.find((item) => item.commandId === 'TEST-fresh-capture');
        assert.ok(capture, 'actual Team owner registered the fresh capture');
        const member = (capture.members as unknown[])
          .map(record)
          .find((item) => item.memberId === 'alice-id');
        assert.equal(typeof member?.principalId, 'string');
        assert.notEqual(member!.principalId, 'alice-session');
        return String(member!.principalId);
      },
    });
    let current: ReturnType<typeof startHost> | undefined;
    const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
    const receipts: Record<string, unknown>[] = [];
    let finalRuntime: Record<string, unknown> = {};
    let launchEvidence: Record<string, unknown> = {};
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
      const delivery = {
        ...teamBinding,
        runId: scope.runId,
        memberId: 'alice-id',
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
            savedSettings: {
              cwd: join(root, 'workspace'),
              providerId: 'anthropic',
              model: 'claude-sonnet-4-6',
              prompt: 'TEST old saved prompt must never run',
            },
            members: [{ memberId: 'alice-id', name: 'alice', role: 'lead', delivery }],
            grants: [
              {
                principalId: 'human',
                memberName: 'user',
                permissions: ['read', 'message.write', 'task.write', 'admin'],
              },
              {
                principalId: 'alice-session',
                memberName: 'alice',
                permissions: ['read', 'message.write', 'task.write'],
              },
            ],
          },
        ],
        runtime: {
          members: [
            {
              teamId: scope.teamId,
              memberId: 'alice-id',
              principalId: 'alice-session',
              provider: 'claude',
              sessionId: `TEST-session-${namespace}`,
              generation: 1,
              configRevision: 'TEST-config-1',
              cwd: join(root, 'workspace'),
              model: 'claude-sonnet-4-6',
              accountBinding: 'TEST-dummy-account',
              executable: artifacts.native,
              environment: {
                HOME: join(root, 'home'),
                CLAUDE_CONFIG_DIR: join(root, 'config'),
                TMPDIR: join(root, 'tmp'),
                XDG_CONFIG_HOME: join(root, 'xdg-config'),
                XDG_DATA_HOME: join(root, 'xdg-data'),
                XDG_CACHE_HOME: join(root, 'xdg-cache'),
                PATH: `${dirname(node)}:/usr/bin:/bin`,
                ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY',
                ANTHROPIC_BASE_URL: model.url,
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
              nativeOptions: {
                projectInstructions: {
                  append: `${CONTEXT_MARKER}. You are alice of test-native-team working only in ${join(root, 'workspace')}.`,
                },
              },
              limits: {
                queuedInputs: 2,
                inputBytes: 8192,
                outputBytes: 2_000_000,
                outputEvents: 1500,
                pendingInteractions: 4,
                timeoutMs: 45_000,
              },
            },
          ],
        },
      };
      const sourceMember = profile.runtime!.members[0]!;
      profile.management = [{
        provider: 'claude', sdkRevision: '0.3.305', profileId: 'TEST-capture-metadata',
        configRevision: 'TEST-capture-metadata-config', configNamespace: 'custom-directory',
        accountBinding: sourceMember.accountBinding, cwd: sourceMember.cwd,
        executable: sourceMember.executable, environment: sourceMember.environment,
        settingSources: [], timeoutMs: 30000, modelProbeTimeoutMs: 90000,
      }];
      const profilePath = join(root, 'profile.json');
      const profileBytes = JSON.stringify(profile);
      await writeFile(profilePath, profileBytes, { mode: 0o600 });
      const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
      const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
      const start = () =>
        startHost({ node, entry, root, profile: profilePath, profileHash: hash(profileBytes) });
      current = start();
      const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
      assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
      const before = await current.rpc('team.launch.read', envelope('TEST-launch-read', {}));
      assert.equal(before.ok, true);
      const original = record(before.value);
      // Exercise the real no-tool SDK prompt against this same finite oracle,
      // before any roster/capture mutation can invalidate the source selection.
      const probeSelection = {
        launchId: original.launchId, rosterRevision: original.rosterRevision,
        memberId: 'alice-id', model: 'claude-opus-4-6', effort: 'medium',
        context: 'model-default',
      };
      // Real UI reads the catalog while the selected-model probe is admitted.
      // Both use the same native config, so probe waits for that exact metadata read.
      const metadata = current.rpc('management.claude.metadata', {
        profileId: 'TEST-capture-metadata', configRevision: 'TEST-capture-metadata-config',
      }).then(value => ({ value }), error => ({ error: String(error) }));
      let probe = await current.rpc('team.launch.probe.start', envelope('TEST-capture-model-check', probeSelection));
      const probeDeadline = Date.now() + 100_000;
      while (probe.ok === true && record(probe.value).phase === 'running' && Date.now() < probeDeadline) {
        await tick();
        probe = await current.rpc('team.launch.probe.read', envelope('TEST-capture-model-check', probeSelection));
      }
      assert.equal(probe.ok, true, JSON.stringify(probe));
      assert.equal(record(probe.value).phase, 'completed');
      assert.equal(record(probe.value).ok, true, JSON.stringify(model.failures));
      const observedMetadata = await metadata;
      assert.ok('value' in observedMetadata, JSON.stringify(observedMetadata));
      assert.equal(observedMetadata.value.ok, true, JSON.stringify(observedMetadata));
      assert.equal(record(observedMetadata.value.value).profileId, 'TEST-capture-metadata');
      assert.deepEqual(model.probes, [{ requestedModel: 'claude-opus-4-6', requestedEffort: 'medium' }]);
      receipts.push({ kind: 'source-team-model-probe', ...probe });
      const rosterBefore = await current.rpc(
        'team.roster.read',
        envelope('TEST-roster-before', {})
      );
      assert.equal(rosterBefore.ok, true);
      const rosterPayload = {
        expectedRevision: record(rosterBefore.value).revision,
        members: [],
        savedSettings: {
          cwd: join(root, 'workspace'),
          providerId: 'anthropic',
          model: 'claude-opus-4-6',
          effort: 'medium',
          fastMode: 'off',
          skipPermissions: true,
          limitContext: true,
          prompt: 'NATIVE_TEAM_ONE',
        },
      };
      const saved = await current.rpc(
        'team.roster.replace',
        envelope('TEST-fresh-roster', rosterPayload)
      );
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const capturePayload = { rosterCommandId: 'TEST-fresh-roster' };
      const captured = await current.rpc(
        'team.launch.capture',
        envelope('TEST-fresh-capture', capturePayload)
      );
      assert.equal(captured.ok, true, JSON.stringify(captured));
      const selected = record(captured.value),
        launch = record(selected.launch);
      assert.notEqual(launch.launchId, original.launchId);
      const settings = record(record((selected.members as unknown[])[0]).selected);
      assert.equal(settings.model, 'claude-opus-4-6');
      assert.equal(settings.effort, 'medium');
      assert.equal(settings.fastMode, false);
      assert.equal(settings.permissions, 'bypass');
      assert.equal(settings.context, 'model-default');
      assert.equal(model.observations.length, 0, 'roster/save/capture never performs inference');
      const registeredState = record(
        JSON.parse(
          await readFile(join(root, 'store/teams/test-native-team/.host-owner/state.json'), 'utf8')
        ) as unknown
      );
      const registered = (registeredState.runtimeCaptures as unknown[])
        .map(record)
        .find((item) => item.commandId === 'TEST-fresh-capture')!;
      assert.equal(registered.launchId, launch.launchId);
      assert.deepEqual(registeredState.savedSettings, rosterPayload.savedSettings);
      assert.equal(settings.workspace, join(root, 'workspace'));
      const nativePrincipal = record((registered.members as unknown[])[0]).principalId;
      assert.match(String(nativePrincipal), /^agent:/);
      assert.notEqual(nativePrincipal, 'alice-session');
      const launchPayload = { launchId: launch.launchId, rosterRevision: launch.rosterRevision };
      const started = await current.rpc(
        'team.launch.start',
        envelope('TEST-fresh-launch', launchPayload)
      );
      assert.equal(started.ok, true, JSON.stringify(started));
      let ready = false;
      const readyDeadline = Date.now() + 45_000;
      while (!ready && Date.now() < readyDeadline) {
        const state: Record<string, unknown> = await current.rpc(
          'runtime.read',
          envelope('TEST-launch-readiness', { memberId: 'alice-id' })
        );
        assert.equal(state.ok, true);
        ready = record(state.value).nativeReady === true;
        if (!ready) await tick();
      }
      assert.equal(ready, true, 'actual D native mandatory MCP discovery with prepared options');
      launchEvidence = {
        originalModel: 'claude-sonnet-4-6',
        selectedModel: 'claude-opus-4-6',
        selectedEffort: 'medium',
        roster: saved.value,
        capture: captured.value,
        nativePrincipal,
        launch: started.value,
      };
      receipts.push(saved, captured, started);
      const deadline = Date.now() + 60_000;
      let terminal = false;
      while (Date.now() < deadline) {
        assert.deepEqual(model.failures, []);
        const read: Record<string, unknown> = await current.rpc(
          'runtime.read',
          envelope('TEST-read', { memberId: 'alice-id' })
        );
        assert.equal(read.ok, true);
        finalRuntime = record(read.value);
        const inputs = (finalRuntime.inputs as unknown[]).map(record);
        assert.ok(inputs.length <= 1, 'one saved prompt creates at most one native input');
        if (inputs[0]?.phase === 'terminal') {
          assert.equal(inputs[0].terminal, 'succeeded');
          terminal = true;
          break;
        }
        await tick();
      }
      assert.equal(terminal, true, 'saved prompt reaches durable terminal');
      assert.equal((finalRuntime.inputs as unknown[]).length, 1);
      assert.deepEqual(
        await current.rpc('team.roster.replace', envelope('TEST-fresh-roster', rosterPayload)),
        saved
      );
      const replayCapture = await current.rpc(
        'team.launch.capture',
        envelope('TEST-fresh-capture', capturePayload)
      );
      assert.equal(replayCapture.ok, true, JSON.stringify(replayCapture));
      assert.equal(record(record(replayCapture.value).launch).launchId, launch.launchId);
      assert.equal(
        (await current.rpc('team.launch.start', envelope('TEST-fresh-launch', launchPayload))).ok,
        true
      );
      const listed = await current.rpc('team.tasks.list', envelope('TEST-list', null));
      assert.equal(listed.ok, true);
      const tasks = listed.value as unknown[];
      assert.equal(tasks.length, 1);
      const task = record(tasks[0]);
      assert.equal(task.status, 'completed');
      assert.equal(task.owner, 'alice');
      assert.equal(task.createdBy, 'alice');
      assert.deepEqual(
        (task.historyEvents as unknown[]).map(record).map((item) => item.actor),
        ['alice', 'alice', 'alice', 'alice']
      );
      assert.equal((task.comments as unknown[]).length, 1);
      assert.equal(record((task.comments as unknown[])[0]).author, 'alice');
      const inbox = JSON.parse(
        await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')
      ) as unknown[];
      assert.deepEqual(
        inbox.map(record).map(({ from, text }) => ({ from, text })),
        [{ from: 'alice', text: 'REPLY_NATIVE_ONE' }]
      );
      assert.equal(new Set(inbox.map(record).map((item) => item.messageId)).size, 1);
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
      assert.equal(model.observations.length, 8);
      assert.deepEqual(model.failures, []);
      assert.ok(model.observations.every((item) => item.contextEffective));
      assert.ok(
        model.observations.every((item) => item.requestedModel === 'claude-opus-4-6'),
        'selected model reaches every actual native HTTP request'
      );
      assert.ok(
        model.observations.every((item) => item.requestedEffort === 'medium'),
        'selected effort reaches every actual native HTTP request'
      );
      assert.ok(
        model.observations.some((item) => item.toolResultError),
        'actual native Bash exit seven returns an error tool result before successful conversation completion'
      );
      assert.ok(model.observations.every((item) => item.turn === 'NATIVE_TEAM_ONE'));
      const stopped = await current.rpc(
        'runtime.stop',
        envelope('TEST-stop', { memberId: 'alice-id' })
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
      const replayed = await current.rpc(
        'team.launch.start',
        envelope('TEST-fresh-launch', launchPayload)
      );
      assert.equal(replayed.ok, true, 'original configured launch replays after Host restart');
      assert.deepEqual(
        await current.rpc('team.roster.lookup', envelope('TEST-fresh-roster', {})),
        saved
      );
      assert.deepEqual(
        await current.rpc('team.roster.replace', envelope('TEST-fresh-roster', rosterPayload)),
        saved
      );
      const coldCapture = await current.rpc(
        'team.launch.capture',
        envelope('TEST-fresh-capture', capturePayload)
      );
      assert.equal(coldCapture.ok, true, JSON.stringify(coldCapture));
      assert.equal(record(record(coldCapture.value).launch).launchId, launch.launchId);
      const recovered = await current.rpc(
        'runtime.read',
        envelope('TEST-recovered', { memberId: 'alice-id' })
      );
      assert.equal(recovered.ok, true);
      assert.equal(record(recovered.value).attached, false);
      assert.equal((record(recovered.value).inputs as unknown[]).length, 1);
      assert.equal(
        (
          await current.rpc(
            'runtime.dispatch',
            envelope('TEST-recover-outbox', { memberId: 'alice-id' })
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
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
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
              runtime: finalRuntime,
              launchEvidence,
              modelObservations: model.observations,
              modelProbes: model.probes,
              modelFailures: model.failures,
              scope:
                'Fresh saved roster capture through ordinary Host Team launch/prompt path, public D and actual pinned Claude SDK/CLI; selected native model/effort, actual task/message/Bash, cold original intent replay without allocation',
              excluded: [
                'Desktop UI',
                'mixed providers',
                'whole P4',
                'multi-member team/bootstrap',
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
