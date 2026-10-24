import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { CONTEXT_MARKER, record, startNativeTeamModel } from './fixtures/native-claude-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

test('standalone Host applies selected model/effort to actual native requests and recovers original launch receipts', { timeout: 180_000 }, async (t) => {
  assert.equal(process.env.LEGACY_NATIVE_CLAUDE_HOST_GO, '1', 'separate root GO required');
  const repo = resolve(import.meta.dirname, '../../..');
  const pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node'));
  assert.equal(await realpath(process.execPath), node);
  const entry = join(pkg, 'dist/cli.js');
  const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
  assert.ok(artifact);
  const artifacts = {
    node: { path: node, sha256: await fileHash(node) },
    provider: { path: await realpath(resolve(repo, artifact)), sha256: '' },
    host: { entry, entrySha256: await fileHash(entry), sourceSha256: await treeHash(join(pkg, 'src'), '.ts'), distSha256: await treeHash(join(pkg, 'dist'), '.js') },
    native: { path: '', sha256: '' },
  };
  artifacts.provider.sha256 = await fileHash(artifacts.provider.path);
  assert.match(process.env.LEGACY_NATIVE_PROVIDER_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(artifacts.provider.sha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256);
  for (const [actual, expected] of [
    [artifacts.host.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256],
    [artifacts.host.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256],
  ]) { assert.match(expected ?? '', /^[a-f0-9]{64}$/); assert.equal(actual, expected); }
  // Resolve exactly as pinned SDK query does; never select a PATH executable.
  const providerRequire = createRequire(import.meta.resolve('@agent-teams/provider-implementations/claude'));
  const sdk = providerRequire.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkRequire = createRequire(sdk);
  artifacts.native.path = await realpath(sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
  artifacts.native.sha256 = await fileHash(artifacts.native.path);
  assert.match(process.env.LEGACY_NATIVE_CLAUDE_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(artifacts.native.sha256, process.env.LEGACY_NATIVE_CLAUDE_SHA256);

  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-claude-host-')));
  t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
  for (const directory of ['home', 'config', 'tmp', 'workspace', 'store', 'xdg-config', 'xdg-data', 'xdg-cache']) await mkdir(join(root, directory), { mode: 0o700 });
  const model = await startNativeTeamModel({ requireVisibleReply: true });
  let current: ReturnType<typeof startHost> | undefined;
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  const receipts: Record<string, unknown>[] = [];
  let finalRuntime: Record<string, unknown> = {};
  let launchEvidence: Record<string, unknown> = {};
  let passed = false;
  try {
    const namespace = basename(root);
    const owner = {
      ownerId: `TEST-owner-${namespace}`, revision: 'TEST-revision', storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`, protocolVersion: 1 as const, buildId: 'TEST-native-host',
      nodeSha256: artifacts.node.sha256, hostEntrySha256: artifacts.host.entrySha256,
    };
    const scope = { projectId: `TEST-project-${namespace}`, workspaceId: `TEST-workspace-${namespace}`, teamId: 'TEST-team', runId: `TEST-run-${namespace}`, memberId: 'human', generation: '1' };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-team' };
    const delivery = { ...teamBinding, runId: scope.runId, memberId: 'alice-id', generation: '1' };
    const profile: TeamHostProfile = {
      schemaVersion: 1, owner, principalId: 'human',
      teams: [{ scope, binding: teamBinding,
        members: [{ memberId: 'alice-id', name: 'alice', role: 'member', delivery }],
        grants: [
          { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'task.write', 'admin'] },
          { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'message.write', 'task.write'] },
        ],
      }],
      runtime: { members: [{
        teamId: scope.teamId, memberId: 'alice-id', principalId: 'alice-session', provider: 'claude',
        sessionId: `TEST-session-${namespace}`, generation: 1, configRevision: 'TEST-config-1',
        cwd: join(root, 'workspace'), model: 'claude-sonnet-4-6', accountBinding: 'TEST-dummy-account',
        executable: artifacts.native,
        environment: {
          HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'),
          XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CACHE_HOME: join(root, 'xdg-cache'),
          PATH: `${dirname(node)}:/usr/bin:/bin`, ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: model.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', NO_COLOR: '1', TERM: 'dumb',
        },
        nativeTools: ['Bash'], autoAllowedTools: ['Bash'],
        nativeOptions: { projectInstructions: { append: `${CONTEXT_MARKER}. You are alice of test-native-team working only in ${join(root, 'workspace')}.` } },
        limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 2_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 45_000 },
      }] },
    };
    const profilePath = join(root, 'profile.json');
    const profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    const start = () => startHost({ node, entry, root, profile: profilePath, profileHash: hash(profileBytes) });
    const command = (label: string) => {
      const commandId = `human-native-${label.toLowerCase()}`;
      return envelope(commandId, { operation: 'message.send', payload: {
        to: 'alice', text: `NATIVE_TEAM_${label}`, messageId: commandId,
        summary: `TEST prepared human message ${label}`, actionMode: 'do',
      } });
    };
    current = start();
    const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
    assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
    const before = await current.rpc('team.launch.read', envelope('TEST-launch-read', {}));
    assert.equal(before.ok, true);
    const original = record(before.value);
    const launchPayload = {
      launchId: original.launchId, rosterRevision: original.rosterRevision,
      configuration: { members: [{ memberId: 'alice-id', model: 'claude-opus-4-6', effort: 'medium', fastMode: false, permissions: 'bypass', context: 'model-default' }] },
    };
    const started = await current.rpc('team.launch.start', envelope('TEST-selected-launch-options', launchPayload));
    assert.equal(started.ok, true, JSON.stringify(started));
    let ready = false;
    const readyDeadline = Date.now() + 45_000;
    while (!ready && Date.now() < readyDeadline) {
      const state: Record<string, unknown> = await current.rpc('runtime.read', envelope('TEST-launch-readiness', { memberId: 'alice-id' }));
      assert.equal(state.ok, true);
      ready = record(state.value).nativeReady === true;
      if (!ready) await tick();
    }
    assert.equal(ready, true, 'actual D native mandatory MCP discovery with prepared options');
    launchEvidence = { originalModel: 'claude-sonnet-4-6', selectedModel: 'claude-opus-4-6', selectedEffort: 'medium', startCommandId: 'TEST-selected-launch-options', launch: started.value };
    for (const label of ['ONE', 'TWO']) {
      const receipt = await current.rpc('team.execute', command(label));
      assert.equal(receipt.ok, true); assert.equal(record(receipt.value).phase, 'completed');
      receipts.push(receipt);
      const inputId = record(record(receipt.value).effects).deliveryId;
      assert.equal(typeof inputId, 'string');
      const deadline = Date.now() + 60_000;
      let terminal = false;
      while (Date.now() < deadline) {
        assert.deepEqual(model.failures, []);
        const read: Record<string, unknown> = await current.rpc('runtime.read', envelope('TEST-read', { memberId: 'alice-id' }));
        assert.equal(read.ok, true);
        finalRuntime = record(read.value);
        const input = (finalRuntime.inputs as unknown[]).map(record).find((item) => item.inputId === inputId);
        if (input?.phase === 'terminal') { assert.equal(input.terminal, 'succeeded'); terminal = true; break; }
        await tick();
      }
      assert.equal(terminal, true, 'bounded native input reaches durable terminal');
      assert.deepEqual(await current.rpc('team.execute', command(label)), receipt);
      assert.equal((await current.rpc('runtime.dispatch', envelope('TEST-resume', { memberId: 'alice-id' }))).ok, true);
    }
    const listed = await current.rpc('team.tasks.list', envelope('TEST-list', null));
    assert.equal(listed.ok, true);
    const tasks = listed.value as unknown[];
    assert.equal(tasks.length, 1);
    const task = record(tasks[0]);
    assert.equal(task.status, 'completed'); assert.equal(task.owner, 'alice');
    assert.equal(task.createdBy, 'alice');
    assert.deepEqual((task.historyEvents as unknown[]).map(record).map((item) => item.actor), ['alice', 'alice', 'alice', 'alice']);
    assert.equal((task.comments as unknown[]).length, 1);
    assert.equal(record((task.comments as unknown[])[0]).author, 'alice');
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(record).map(({ from, text }) => ({ from, text })), [{ from: 'alice', text: 'REPLY_NATIVE_ONE' }, { from: 'alice', text: 'REPLY_NATIVE_TWO' }]);
    assert.equal(new Set(inbox.map(record).map((item) => item.messageId)).size, 2);
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
    assert.equal(model.observations.length, 11); assert.deepEqual(model.failures, []);
    assert.ok(model.observations.every((item) => item.contextEffective));
    assert.ok(model.observations.every((item) => item.visibleReplyContract));
    assert.ok(model.observations.every((item) => item.requestedModel === 'claude-opus-4-6'), 'selected model reaches every actual native HTTP request');
    assert.ok(model.observations.every((item) => item.requestedEffort === 'medium'), 'selected effort reaches every actual native HTTP request');
    assert.ok(model.observations.some((item) => item.toolResultError), 'actual native Bash exit seven returns an error tool result before successful conversation completion');
    assert.ok(model.observations.filter((item) => item.turn === 'NATIVE_TEAM_TWO').every((item) => item.priorTurn));
    const stopped = await current.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'alice-id' }));
    assert.equal(stopped.ok, true); finalRuntime = record(stopped.value);
    assert.equal(finalRuntime.phase, 'closed'); assert.equal(finalRuntime.custody, 'released');
    await current.close(); hosts.push(current.facts()); current = undefined;
    const requestsBeforeRestart = model.observations.length;
    current = start();
    await current.rpc('host.handshake', { protocolVersion: 1 });
    const replayed = await current.rpc('team.launch.start', envelope('TEST-selected-launch-options', launchPayload));
    assert.equal(replayed.ok, true, 'original configured launch replays after Host restart');
    for (const [index, label] of ['ONE', 'TWO'].entries()) {
      assert.deepEqual(await current.rpc('team.lookup', command(label)), receipts[index]);
      assert.deepEqual(await current.rpc('team.execute', command(label)), receipts[index]);
    }
    const recovered = await current.rpc('runtime.read', envelope('TEST-recovered', { memberId: 'alice-id' }));
    assert.equal(recovered.ok, true); assert.equal(record(recovered.value).attached, false);
    assert.equal((record(recovered.value).inputs as unknown[]).length, 2);
    assert.equal((await current.rpc('runtime.dispatch', envelope('TEST-recover-outbox', { memberId: 'alice-id' }))).ok, true);
    await current.close(); hosts.push(current.facts()); current = undefined;
    assert.equal(model.observations.length, requestsBeforeRestart, 'recovered receipts/outbox never launch or resubmit native inputs');
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
    passed = true;
  } finally {
    let cleanupConfirmed = current === undefined;
    try { if (current) { await current.close(); cleanupConfirmed = true; hosts.push(current.facts()); } }
    finally {
      await model.close();
      await writeFile(join(root, 'receipt.json'), JSON.stringify({
        status: passed ? 'PASS' : 'INCOMPLETE', root, artifacts, hosts,
        cleanupConfirmed, businessReceipts: receipts, runtime: finalRuntime, launchEvidence,
        modelObservations: model.observations, modelFailures: model.failures,
        scope: 'Explicit model/effort launch configuration through standalone Host stdio + RuntimeTeamCoordinator + public D + actual Claude native HTTP/MCP, two rich inputs and canonical replies, restart/replay without new allocation',
        excluded: ['Desktop UI', 'mixed providers', 'whole P4', 'multi-member team/bootstrap', 'real authentication'],
      }, null, 2), { mode: 0o600 });
    }
  }
});
