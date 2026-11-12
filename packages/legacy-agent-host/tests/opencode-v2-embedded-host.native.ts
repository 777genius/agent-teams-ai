/** TEST-only complete native V2 turn through the original Host/Runtime/MCP composition. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, nativeHostEnvironment, startHost, tick, treeHash } from './fixtures/native-host.ts';
import { CONTEXT_MARKER, startOpenCodeModel } from './fixtures/native-opencode-team/model.ts';
import { assertNativeV1Source, buildNativeV1Host } from './opencode-v1-version-source.ts';

async function endpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return `http://127.0.0.1:${address.port}`;
}

export interface PackagedNativeHostInputs {
  sourceHead: string;
  node: string;
  entry: string;
  hostPackage: string;
  bun: string;
  engine: string;
  manifestSha256: string;
  hostSourceDigest: string;
  providerDigest: string;
  processCustody?: { directory: string; manifestSha256: string };
  evidence: Readonly<Record<string, unknown>>;
  /** Original packaged reader rechecks every selected file, source absence and actual Node. */
  verify(): Promise<void>;
}

/** Same native scenario for source qualification and the separately captured packaged candidate. */
export async function runOpenCodeV2EmbeddedHostNative(packaged?: PackagedNativeHostInputs) {
  assert.ok(process.platform === 'linux' && process.arch === 'x64' ||
    (process.platform === 'darwin' || process.platform === 'win32') &&
      (process.arch === 'arm64' || process.arch === 'x64'));
  assert.equal(process.version, 'v24.21.0');
  await packaged?.verify();
  const bun = packaged ? packaged.bun : await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const engine = packaged ? packaged.engine : await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
  const manifestSha256 = packaged ? packaged.manifestSha256 : process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256!;
  const receiptPath = process.env.OPENCODE_V2_EMBEDDED_HOST_RECEIPT!;
  const approvalMode = process.env.OPENCODE_V2_EMBEDDED_APPROVAL_MODE ?? 'manual';
  assert.ok(approvalMode === 'manual' || approvalMode === 'auto');
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(receiptPath && isAbsolute(receiptPath));
  const repo = resolve(import.meta.dirname, '../../..');
  const pkg = packaged ? packaged.hostPackage : join(repo, 'packages/legacy-agent-host');
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  if (packaged) assert.equal(packaged.sourceHead, sourceHead);
  else await buildNativeV1Host(repo, sourceHead);
  if (packaged && process.platform === 'darwin') assert.ok(packaged.processCustody);
  const { applyLaunchConfiguration } = await import(pathToFileURL(join(pkg, 'dist/composition/launchConfiguration.js')).href) as
    typeof import('../dist/composition/launchConfiguration.js');
  const node = packaged ? packaged.node : await realpath(process.execPath);
  const entry = packaged ? packaged.entry : join(pkg, 'dist/cli.js');
  assert.equal(await realpath(process.execPath), node, 'scenario and Host must use the selected original Node');
  const steps: string[] = [], hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  let host: ReturnType<typeof startHost> | undefined;
  let model: Awaited<ReturnType<typeof startOpenCodeModel>> | undefined;
  let passed = false, cleanup = false;
  let originalFailure: unknown;
  let windowsShellSha256: string | undefined;
  const cleanupErrors: unknown[] = [];
  const digests = {
    bun: await fileHash(bun), manifest: await fileHash(join(engine, 'opencode-v2-engine-manifest.json')),
    node: await fileHash(node), hostSource: packaged ? packaged.hostSourceDigest : await treeHash(join(pkg, 'src'), '.ts'),
    hostDist: await treeHash(join(pkg, 'dist'), '.js'),
    provider: packaged ? packaged.providerDigest : await fileHash(resolve(pkg, JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
      .dependencies['@agent-teams/provider-implementations'].slice(5))),
  };
  assert.equal(digests.manifest, manifestSha256);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-v2-host-')));
  try {
    for (const name of ['home', 'tmp', 'workspace', 'store', 'config', 'data', 'cache'])
      await mkdir(join(root, name), { mode: 0o700 });
    const environment = nativeHostEnvironment(node, root);
    if (process.platform === 'win32') {
      // Native 2.1.4 selects this shell from the isolated PATH. The inference
      // oracle additionally requires its actual advertised tool description.
      const shell = await realpath(join(environment.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'));
      assert.ok((await stat(shell)).isFile(), 'actual Windows PowerShell is required for the native shell turn');
      windowsShellSha256 = await fileHash(shell);
    }
    model = await startOpenCodeModel({ nativeGeneration: 'v2' });
    const namespace = basename(root);
    const owner = {
      ownerId: `TEST-owner-${namespace}`, revision: 'TEST-revision', storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`, protocolVersion: 1 as const, buildId: 'TEST-v2-embedded-host',
      nodeSha256: digests.node, hostEntrySha256: await fileHash(entry),
    };
    const scope = { projectId: `TEST-project-${namespace}`, workspaceId: `TEST-workspace-${namespace}`,
      teamId: 'TEST-team', runId: `TEST-run-${namespace}`, memberId: 'human', generation: '1' };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-team' };
    const profile: TeamHostProfile = {
      schemaVersion: 1, owner, principalId: 'human',
      ...(process.platform === 'darwin' ? { processCustody: packaged ? packaged.processCustody! : {
        directory: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!,
        manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256!,
      } } : {}),
      teams: [{ scope, binding: teamBinding,
        members: [{ memberId: 'carol-id', name: 'carol', role: 'member',
          delivery: { ...teamBinding, runId: scope.runId, memberId: 'carol-id', generation: '1' } }],
        grants: [
          { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'task.write', 'admin'] },
          { principalId: 'carol-session', memberName: 'carol', permissions: ['read', 'message.write', 'task.write'] },
        ],
      }],
      runtime: { members: [{
        teamId: scope.teamId, memberId: 'carol-id', principalId: 'carol-session', provider: 'opencode',
        nativeGeneration: 'v2', protocolRevision: '2.1.4', sessionId: `TEST-session-${namespace}`,
        generation: 1, configRevision: 'TEST-config-1', cwd: join(root, 'workspace'), model: 'TEST-model',
        endpoint: await endpoint(), accountBinding: 'TEST-localhost-account',
        executable: { path: bun, sha256: digests.bun },
        environment: {
          ...environment,
          XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'), NO_COLOR: '1',
        },
        embedded: { directory: engine, manifestSha256, version: '2.1.4',
          platform: process.platform, arch: process.arch as 'arm64' | 'x64',
          externalDirectory: 'deny', providerConfiguration: {
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: { baseURL: `${model.url}/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
            models: { 'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 },
              capabilities: { tools: true, input: ['text'], output: ['text'] } } },
          } },
        nativeOptions: { providerId: 'TEST-local', agent: 'TEST-member', toolApprovalMode: 'manual',
          instructions: `${CONTEXT_MARKER}. You are carol of test-native-team working only in ${join(root, 'workspace')}.` },
        limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 1_000_000,
          outputEvents: 1500, pendingInteractions: 4, timeoutMs: 60_000 },
      }] },
    };
    profile.runtime!.members[0] = applyLaunchConfiguration(profile.runtime!.members[0]!, {
      permissions: approvalMode === 'auto' ? 'bypass' : 'manual',
    });
    const profilePath = join(root, 'profile.json');
    const bytes = JSON.stringify(profile);
    await writeFile(profilePath, bytes, { mode: 0o600 });
    const start = () => startHost({ node, entry, root, profile: profilePath,
      profileHash: createHash('sha256').update(bytes).digest('hex') });
    const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    // Observe the existing 120-second embedded startup plus MCP readiness; never retry the intent.
    const opened = await host.rpc('runtime.open', envelope('TEST-open', { memberId: 'carol-id' }), 180_000);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(record(opened.value).nativeReady, true, JSON.stringify(opened));
    steps.push('original_host_embedded_native_and_mcp_ready');
    const command = envelope('TEST-original-message', {
      operation: 'message.send', payload: { to: 'carol', text: 'OPENCODE_TEAM_ONE' },
    });
    const original = await host.rpc('team.execute', command);
    assert.equal(original.ok, true); assert.equal(record(original.value).phase, 'completed');
    const inputId = record(record(original.value).effects).deliveryId;
    assert.equal(typeof inputId, 'string');
    const replies = new Set<string>();
    let terminal = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      assert.deepEqual(model.failures, []);
      const result: Record<string, unknown> = await host.rpc('runtime.read', envelope('TEST-read', { memberId: 'carol-id' }));
      assert.equal(result.ok, true);
      const state = record(result.value);
      for (const interaction of (state.interactions as unknown[]).map(record).filter(row => row.phase === 'pending')) {
        assert.equal(interaction.kind, 'permission'); assert.equal(interaction.inputId, inputId);
        assert.equal(typeof interaction.interactionRef, 'string');
        const ref = interaction.interactionRef as string;
        assert.ok(!replies.has(ref), 'one native grant, never retry an uncertain POST'); replies.add(ref);
        const granted: Record<string, unknown> = await host.rpc('runtime.interaction', envelope('TEST-once', {
          memberId: 'carol-id', expectedGeneration: '1', inputId, interactionRef: ref,
          reply: { kind: 'permission', decision: 'allow' },
        }));
        assert.equal(granted.ok, true, JSON.stringify(granted));
      }
      const input = (state.inputs as unknown[]).map(record).find(row => row.inputId === inputId);
      if (input?.phase === 'terminal') {
        assert.equal(input.terminal, 'succeeded', JSON.stringify(state)); terminal = true; break;
      }
      await tick();
    }
    assert.equal(terminal, true); assert.equal(replies.size, approvalMode === 'manual' ? 1 : 0);
    assert.deepEqual(model.failures, []); assert.equal(model.observations.length, 8);
    assert.ok(model.observations.every(row => row.contextEffective));
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
    const listed = await host.rpc('team.tasks.list', envelope('TEST-tasks', null));
    assert.equal(listed.ok, true); const tasks = listed.value as unknown[];
    assert.equal(tasks.length, 1); assert.equal(record(tasks[0]).status, 'completed');
    assert.equal(record(tasks[0]).owner, 'carol');
    assert.equal((record(tasks[0]).comments as unknown[]).length, 1);
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(record).map(row => [row.from, row.text]), [['carol', 'REPLY_OPENCODE_ONE']]);
    assert.deepEqual(await host.rpc('team.execute', command), original);
    const activity = await host.rpc('runtime.activity.snapshot', envelope('TEST-activity', { memberId: 'carol-id' }));
    assert.equal(activity.ok, true);
    const failedShellObserved = (record(record(activity.value).latest).tools as unknown[]).map(record).some(row =>
      record(row.data).kind === 'tool-result' && record(row.data).isError === true);
    steps.push('native_model_tool_effect_permission_mcp_task_and_reply_completed_once');
    const checkpoint = await host.rpc('runtime.checkpoint', envelope('TEST-checkpoint', {
      memberId: 'carol-id', checkpointId: 'TEST-before-cold',
    }));
    assert.equal(checkpoint.ok, true); assert.equal(record(checkpoint.value).status, 'published');
    const stopped = await host.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'carol-id' }));
    assert.equal(stopped.ok, true); assert.equal(record(stopped.value).phase, 'closed');
    assert.equal(record(stopped.value).custody, 'released');
    await host.close(); hosts.push(host.facts()); host = undefined;
    steps.push('checkpoint_and_original_host_native_cleanup_confirmed');
    const callsBefore = model.observations.length;
    host = start(); await host.rpc('host.handshake', { protocolVersion: 1 });
    assert.deepEqual(await host.rpc('team.lookup', command), original);
    assert.deepEqual(await host.rpc('team.execute', command), original);
    const recovered = await host.rpc('runtime.read', envelope('TEST-recovered', { memberId: 'carol-id' }));
    assert.equal(recovered.ok, true); assert.equal(record(recovered.value).attached, false);
    const inputs = (record(recovered.value).inputs as unknown[]).map(record);
    assert.equal(inputs.length, 1); assert.equal(inputs[0]?.inputId, inputId);
    assert.equal(inputs[0]?.phase, 'terminal'); assert.equal(inputs[0]?.terminal, 'succeeded');
    const restored = await host.rpc('runtime.restore', envelope('TEST-restore', {
      memberId: 'carol-id', reference: record(checkpoint.value).reference,
      expectedGeneration: record(opened.value).generation,
    }), 180_000);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(record(restored.value).nativeReady, true);
    assert.notEqual(record(restored.value).generation, record(opened.value).generation);
    await new Promise<void>(done => setTimeout(done, 250));
    assert.deepEqual(model.failures, []); assert.equal(model.observations.length, callsBefore);
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
    const resumedStop = await host.rpc('runtime.stop', envelope('TEST-resumed-stop', {
      memberId: 'carol-id', expectedGeneration: record(restored.value).generation,
    }));
    assert.equal(resumedStop.ok, true); assert.equal(record(resumedStop.value).custody, 'released');
    await host.close(); hosts.push(host.facts()); host = undefined;
    steps.push('cold_host_restored_native_history_without_model_or_tool_replay');
    assert.equal(failedShellObserved, true, 'native shell exit 7 is reported as a failed tool');
    if (packaged) await packaged.verify();
    else {
      assert.equal(await treeHash(join(pkg, 'src'), '.ts'), digests.hostSource);
      assertNativeV1Source(repo, sourceHead);
    }
    assert.equal(await treeHash(join(pkg, 'dist'), '.js'), digests.hostDist);
    passed = true;
  } catch (error) { originalFailure = error; }
  finally {
    try {
      if (host) { await host.close(); hosts.push(host.facts()); }
    } catch (error) { cleanupErrors.push(error); }
    try { await model?.close(); } catch (error) { cleanupErrors.push(error); }
    cleanup = cleanupErrors.length === 0;
    try {
      await writeFile(receiptPath, JSON.stringify({
        kind: packaged ? 'TEST_PACKAGED_NATIVE_V2_HOST' : 'TEST_NATIVE_V2_EMBEDDED_HOST',
        status: passed && cleanup ? 'PASS' : 'INCOMPLETE',
        ...(packaged ? { packaged: packaged.evidence } : {}),
        sourceHead, platform: `${process.platform}-${process.arch}`,
        version: '2.1.4', approvalMode, nodeVersion: process.version,
        digests: { ...digests, ...(windowsShellSha256 ? { windowsShell: windowsShellSha256 } : {}) },
        steps, cleanup,
        hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({ exitCode, signalCode, stdoutValid })),
        modelOrigin: 'localhost-scripted', modelRequests: model?.observations.length ?? 0,
        modelFailures: model?.failures ?? [], vendorAuthQualified: false,
        desktopQualified: false, releaseQualified: false,
      }, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (originalFailure !== undefined) throw originalFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST native Host cleanup or receipt failed');
  assert.equal(passed, true);
}

if (process.env.OPENCODE_V2_PACKAGED_GO !== '1')
  test('embedded 2.1.4 performs native tools, MCP, once approval and cold Host Resume without replay', {
    timeout: 300_000, skip: process.env.OPENCODE_V2_EMBEDDED_HOST_GO !== '1',
  }, () => runOpenCodeV2EmbeddedHostNative());
