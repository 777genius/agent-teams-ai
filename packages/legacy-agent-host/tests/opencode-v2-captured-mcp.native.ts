/** TEST-only selected external MCP and app-only policy through the original native V2 Host. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { OpenCodeMemberProfile } from '../dist/composition/runtimeProfile.js';
import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, nativeHostEnvironment, startHost, tick } from './fixtures/native-host.ts';
import { mcpTurnText, startCapturedMcpModel } from './fixtures/native-opencode-v2-mcp/model.ts';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';

async function endpoint(): Promise<string> {
  const listener = createServer();
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
  return 'http://127.0.0.1:' + address.port;
}
const value = (result: Record<string, unknown>) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return record(result.value);
};
async function events(path: string): Promise<Record<string, unknown>[]> {
  const bytes = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  assert.ok(Buffer.byteLength(bytes) <= 128 * 1024);
  const rows = bytes.trim().split('\n').filter(Boolean);
  assert.ok(rows.length <= 128);
  return rows.map(line => record(JSON.parse(line)));
}
/** Read-only observation of the process captured from the actor's original native start. */
async function originalActorPresent(start: Record<string, unknown>): Promise<boolean> {
  assert.ok(Number.isSafeInteger(start.pid) && Number(start.pid) > 0);
  assert.match(String(start.startTicks), /^\d+$/);
  const stat = await readFile('/proc/' + start.pid + '/stat', 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return stat !== undefined &&
    stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] === start.startTicks;
}

test('native V2 captured allowlist and app-only preserve Team tools, original receipts and MCP cleanup', {
  timeout: 420_000, skip: process.env.OPENCODE_V2_CAPTURED_MCP_GO !== '1',
}, async (t) => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  const repo = resolve(import.meta.dirname, '../../..');
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  const build = await buildNativeV1Host(repo, sourceHead);
  const { captureRuntimeMcp } = await import('../dist/composition/captureRuntimeMcp.js');
  const node = await realpath(process.execPath);
  const entry = join(repo, 'packages/legacy-agent-host/dist/cli.js');
  const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const engine = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
  const manifest = process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256!;
  const receiptPath = process.env.OPENCODE_V2_CAPTURED_MCP_RECEIPT!;
  assert.ok(receiptPath && isAbsolute(receiptPath));
  assert.equal(await fileHash(join(engine, 'opencode-v2-engine-manifest.json')), manifest);
  const actor = await realpath(join(import.meta.dirname, 'fixtures/native-opencode-v2-mcp/server.mjs'));
  const digests = { node: await fileHash(node), bun: await fileHash(bun), manifest,
    source: build.hostSourceDigest, dist: build.hostDistDigest, provider: build.providerDigest,
    actor: await fileHash(actor) };
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-v2-captured-mcp-')));
  const actorLog = join(root, 'selected.jsonl'), effectPath = join(root, 'selected-effect.json');
  const excludedLog = join(root, 'excluded.jsonl'), excludedEffect = join(root, 'excluded-effect.json');
  const nonce = randomUUID();
  const steps: string[] = [], hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  let host: ReturnType<typeof startHost> | undefined;
  let model: Awaited<ReturnType<typeof startCapturedMcpModel>> | undefined;
  let originalStart: Record<string, unknown> | undefined;
  let lifecycle: Record<string, unknown>[] = [], excludedLifecycle: Record<string, unknown>[] = [];
  let manualPermissionBeforeEffect = false;
  let originalFailure: unknown, passed = false, cleanup = false;
  const cleanupErrors: unknown[] = [];
  const cancelOriginalHost = () => host?.child.stdin.end();
  t.signal.addEventListener('abort', cancelOriginalHost, { once: true });
  try {
    for (const name of ['home', 'tmp', 'config', 'data', 'cache', 'store', 'lead', 'allow', 'app-only'])
      await mkdir(join(root, name), { mode: 0o700 });
    model = await startCapturedMcpModel({
      nonce, originalInstance: () => String(originalStart?.instanceId ?? ''),
    });
    const catalogPath = join(root, 'home/claude-catalog.json');
    const selectedServer = (server: 'selected' | 'excluded') => ({
      type: 'stdio', command: node,
      args: [actor, server === 'selected' ? actorLog : excludedLog,
        server === 'selected' ? effectPath : excludedEffect, nonce, server],
      env: { TEST_MCP_NONCE: nonce },
    });
    await writeFile(catalogPath, JSON.stringify({ mcpServers: {
      'TEST.selected': selectedServer('selected'), 'TEST.excluded': selectedServer('excluded'),
    } }), { mode: 0o600 });
    const catalogDigest = await fileHash(catalogPath);
    const owner = {
      ownerId: 'TEST-captured-mcp-owner', revision: 'TEST-owner-v1',
      profileId: 'TEST-profile', storageRoot: join(root, 'store'),
      protocolVersion: 1 as const, buildId: 'TEST-native-captured-mcp',
      nodeSha256: digests.node, hostEntrySha256: await fileHash(entry),
    };
    const scope = { projectId: 'TEST-project', workspaceId: 'TEST-workspace',
      teamId: 'TEST-team', runId: 'TEST-run', memberId: 'human', generation: '1' };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-mcp' };
    const recipes: OpenCodeMemberProfile[] = [];
    for (const name of ['lead', 'allow', 'app-only']) recipes.push({
      provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
      teamId: scope.teamId, memberId: name, principalId: name + '-session',
      sessionId: 'TEST-native-' + name, generation: 1, configRevision: 'TEST-config',
      cwd: join(root, name), model: 'TEST-model', endpoint: await endpoint(),
      accountBinding: 'TEST-localhost-account', executable: { path: bun, sha256: digests.bun },
      environment: { ...nativeHostEnvironment(node, root), XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), NO_COLOR: '1' },
      embedded: { version: '2.1.4', platform: 'linux', arch: 'x64', directory: engine,
        manifestSha256: manifest, externalDirectory: 'deny',
        providerConfiguration: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { baseURL: model.url + '/v1', apiKey: 'TEST-LOCALHOST-ONLY' },
          models: { 'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 1000 },
            capabilities: { tools: true, input: ['text'], output: ['text'] } } },
        },
      },
      ...(name === 'lead' ? {} : { mcpCatalogSource: { claudeConfigPath: catalogPath } }),
      nativeOptions: { providerId: 'TEST-local', agent: 'TEST-member', toolApprovalMode: 'manual',
        instructions: 'TEST captured external MCP policy for ' + name },
      limits: { queuedInputs: 1, inputBytes: 8192, outputBytes: 500000,
        outputEvents: 1000, pendingInteractions: 2, timeoutMs: 120000 },
    });
    const members = captureRuntimeMcp({
      recipes, savedCwd: join(root, 'lead'),
      members: [
        { role: 'lead', settings: {} },
        { role: 'member', settings: { cwd: join(root, 'allow'), mcpPolicy: { mode: 'strictAllowlist',
          serverNames: ['TEST.selected'], scopes: { user: true, project: false, local: false } } } },
        { role: 'member', settings: { cwd: join(root, 'app-only'), mcpPolicy: { mode: 'appOnly' } } },
      ],
    });
    assert.deepEqual(Object.keys(members[1]!.capturedMcpServers ?? {}), ['TEST.selected']);
    assert.deepEqual(members[2]!.capturedMcpServers, {});
    assert.ok(members[1]!.capturedMcpSource);
    assert.equal(members[2]!.capturedMcpSource, undefined);
    assert.ok(members.every(member => member.provider === 'opencode' && member.mcpPolicyPlugin === undefined));
    const profile: TeamHostProfile = {
      schemaVersion: 1, owner, principalId: 'human',
      teams: [{ scope, binding: teamBinding,
        members: members.map(member => ({ memberId: member.memberId, name: member.memberId,
          role: member.memberId === 'lead' ? 'lead' as const : 'member' as const,
          delivery: { ...teamBinding, runId: scope.runId, memberId: member.memberId, generation: '1' } })),
        grants: [
          { principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'message.write', 'task.write'] },
          ...members.map(member => ({ principalId: member.principalId, memberName: member.memberId,
            permissions: ['read', 'message.write', 'task.write'] as ('read' | 'message.write' | 'task.write')[] })),
        ],
      }], runtime: { members },
    };
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    const profileHash = await fileHash(profilePath);
    const start = () => { t.signal.throwIfAborted(); return startHost({ node, entry, root, profile: profilePath, profileHash }); };
    const binding = { schemaVersion: 1, handleId: 'TEST-captured-mcp-handle', owner, scope };
    let controls = 0;
    const envelope = (payload: unknown, commandId = 'TEST-mcp-control-' + ++controls) => ({ commandId, binding, payload });
    const originals: { command: ReturnType<typeof envelope>; receipt: Record<string, unknown>;
      memberId: string; inputId: string }[] = [];
    const grants = new Set<string>();
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    for (const [memberId, turn] of [['allow', 'ALLOW'], ['app-only', 'APP_ONLY']] as const) {
      const opened = value(await host.rpc('runtime.open', envelope({ memberId }), 180_000));
      assert.equal(opened.nativeReady, true);
      if (memberId === 'allow') {
        lifecycle = await events(actorLog);
        const starts = lifecycle.filter(row => row.event === 'started');
        assert.equal(starts.length, 1);
        originalStart = starts[0]!;
        assert.equal(originalStart.server, 'selected');
        assert.match(String(originalStart.instanceId), /^[a-f0-9-]{36}$/);
        assert.equal(await originalActorPresent(originalStart), true);
        assert.equal(await fileHash('/proc/' + originalStart.pid + '/exe'), digests.node);
      } else {
        assert.equal((await events(actorLog)).filter(row => row.event === 'started').length, 1,
          'app-only cannot start another external MCP process');
      }
      assert.deepEqual(await events(excludedLog), []);
      const command = envelope({ operation: 'message.send',
        payload: { to: memberId, text: mcpTurnText(turn) } }, 'TEST-original-mcp-' + turn);
      const receipt: Record<string, unknown> = await host.rpc('team.execute', command);
      const accepted = value(receipt);
      assert.equal(accepted.phase, 'completed');
      const inputId = record(accepted.effects).deliveryId;
      assert.equal(typeof inputId, 'string');
      originals.push({ command, receipt, memberId, inputId: inputId as string });
      let terminal = false;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        t.signal.throwIfAborted();
        assert.deepEqual(model.failures, []);
        const state = value(await host.rpc('runtime.read', envelope({ memberId })));
        for (const interaction of (state.interactions as unknown[]).map(record).filter(row => row.phase === 'pending')) {
          assert.equal(memberId, 'allow', 'app-only Team tools require no external permission');
          assert.equal(interaction.kind, 'permission');
          assert.equal(interaction.inputId, inputId);
          assert.equal(typeof interaction.interactionRef, 'string');
          const ref = interaction.interactionRef as string;
          assert.equal(grants.has(ref), false, 'one original once reply, no uncertain retry');
          assert.deepEqual(model.requests, [{ turn: 'ALLOW', step: 0, tool: 'TEST_selected_write_marker' }],
            'manual approval must precede the external effect, not a later Team action');
          assert.equal((await events(actorLog)).filter(row => row.event === 'called').length, 0);
          await assert.rejects(readFile(effectPath), { code: 'ENOENT' });
          manualPermissionBeforeEffect = true;
          grants.add(ref);
          value(await host.rpc('runtime.interaction', envelope({
            memberId, expectedGeneration: '1', inputId, interactionRef: ref,
            reply: { kind: 'permission', decision: 'allow' },
          })));
        }
        const input = (state.inputs as unknown[]).map(record).find(row => row.inputId === inputId);
        if (input?.phase === 'terminal') {
          assert.equal(input.terminal, 'succeeded'); terminal = true; break;
        }
        await tick();
      }
      assert.equal(terminal, true);
      assert.deepEqual(await host.rpc('team.execute', command), receipt);
      const stopped = value(await host.rpc('runtime.stop', envelope({ memberId })));
      assert.equal(stopped.phase, 'closed');
      assert.equal(stopped.custody, 'released');
      if (memberId === 'allow') {
        const deadline = Date.now() + 10_000;
        while (await originalActorPresent(originalStart!)) {
          assert.ok(Date.now() < deadline, 'original MCP child physically exits after native Stop');
          await tick();
        }
        const effect = record(JSON.parse(await readFile(effectPath, 'utf8')));
        assert.deepEqual(effect, { server: 'selected', instanceId: originalStart!.instanceId,
          pid: originalStart!.pid, startTicks: originalStart!.startTicks, nonce });
        lifecycle = await events(actorLog);
        assert.equal(lifecycle.filter(row => row.event === 'called').length, 1);
        assert.equal(lifecycle.filter(row => row.event === 'closed').length, 1);
        assert.ok(lifecycle.every(row => row.instanceId === originalStart!.instanceId));
        steps.push('captured_allowlist_actual_tool_once_permission_original_result_and_cleanup');
      } else {
        steps.push('app_only_has_no_external_tool_or_process_and_preserves_team_reply');
      }
    }
    assert.equal(grants.size, 1);
    assert.equal(model.requests.length, 5);
    assert.deepEqual(model.failures, []);
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-native-mcp/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(record).map(row => [row.from, row.text]),
      [['allow', 'REPLY_NATIVE_MCP_ALLOW'], ['app-only', 'REPLY_NATIVE_MCP_APP_ONLY']]);
    await host.close(); hosts.push(host.facts()); host = undefined;
    const callsBefore = JSON.stringify(model.requests), lifecycleBefore = JSON.stringify(await events(actorLog));
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    for (const original of originals) {
      assert.deepEqual(await host.rpc('team.lookup', original.command), original.receipt);
      assert.deepEqual(await host.rpc('team.execute', original.command), original.receipt);
      const state = value(await host.rpc('runtime.read', envelope({ memberId: original.memberId })));
      assert.equal(state.attached, false);
      assert.deepEqual(state.inputs, [{ inputId: original.inputId, phase: 'terminal', terminal: 'succeeded' }]);
    }
    await host.close(); hosts.push(host.facts()); host = undefined;
    assert.equal(JSON.stringify(model.requests), callsBefore);
    assert.equal(JSON.stringify(await events(actorLog)), lifecycleBefore);
    assert.deepEqual(await events(excludedLog), []);
    await assert.rejects(readFile(excludedEffect), { code: 'ENOENT' });
    steps.push('cold_original_receipts_and_readback_do_not_replay_native_or_external_tools');
    assert.equal(await fileHash(catalogPath), catalogDigest);
    assert.equal(await fileHash(actor), digests.actor);
    assert.equal(await fileHash(node), digests.node);
    assert.equal(await fileHash(bun), digests.bun);
    assert.equal(await fileHash(join(engine, 'opencode-v2-engine-manifest.json')), digests.manifest);
    await assertNativeV1Build(repo, sourceHead, build);
    passed = true;
  } catch (error) { originalFailure = error; }
  finally {
    t.signal.removeEventListener('abort', cancelOriginalHost);
    if (host) try { await host.close(); hosts.push(host.facts()); host = undefined; }
    catch (error) { cleanupErrors.push(error); }
    try { await model?.close(); } catch (error) { cleanupErrors.push(error); }
    try {
      lifecycle = await events(actorLog);
      excludedLifecycle = await events(excludedLog);
      for (const started of [...lifecycle, ...excludedLifecycle].filter(row => row.event === 'started'))
        assert.equal(await originalActorPresent(started), false, 'captured original MCP child absent');
      assert.deepEqual(excludedLifecycle, [], 'unselected MCP never started, including during cleanup');
    } catch (error) { cleanupErrors.push(error); }
    cleanup = cleanupErrors.length === 0;
    if (cleanup) try { await rm(root, { recursive: true, force: true }); }
    catch (error) { cleanup = false; cleanupErrors.push(error); }
    try {
      await writeFile(receiptPath, JSON.stringify({
        kind: 'TEST_NATIVE_V2_CAPTURED_MCP', sourceHead, platform: 'linux-x64',
        nodeVersion: process.version, version: '2.1.4',
        status: passed && cleanup && !t.signal.aborted && originalFailure === undefined ? 'PASS' : 'INCOMPLETE',
        digests, cleanup, steps, modelRequests: model?.requests ?? [], modelFailures: model?.failures ?? [],
        manualPermissionBeforeEffect,
        excludedProcessStarts: excludedLifecycle.filter(row => row.event === 'started').length,
        externalProcessStarts: lifecycle.filter(row => row.event === 'started').length,
        externalToolCalls: lifecycle.filter(row => row.event === 'called').length,
        externalProcessCloses: lifecycle.filter(row => row.event === 'closed').length,
        hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({ exitCode, signalCode, stdoutValid })),
        vendorAuthQualified: false, desktopQualified: false, releaseQualified: false,
      }, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (originalFailure !== undefined || cleanupErrors.length)
    throw new AggregateError([...(originalFailure === undefined ? [] : [originalFailure]), ...cleanupErrors],
      'TEST native captured MCP proof or original cleanup failed');
});
