/** TEST-only Linux compatibility: selected V1 CLI against the existing V1 wire contract. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, startHost, tick, treeHash } from './fixtures/native-host.ts';
import { CONTEXT_MARKER, startOpenCodeModel } from './fixtures/native-opencode-team/model.ts';

const enabled = process.env.OPENCODE_V1_VERSION_HOST_GO === '1';

test('selected stable V1 executes native tools through Host and retains cold receipts', {
  timeout: 180_000, skip: !enabled,
}, async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0', 'use the pinned TEST Node, not ambient developer Node');
  const sourceHead = process.env.OPENCODE_V1_TEST_SOURCE_HEAD ?? '';
  const version = process.env.OPENCODE_V1_TEST_EXPECTED_VERSION ?? '';
  assert.match(sourceHead, /^[a-f0-9]{40}$/);
  assert.match(version, /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.ok(Number.isSafeInteger(Number(version.split('.')[1])) && Number(version.split('.')[1]) >= 16);
  const requestedPrefix = process.env.OPENCODE_V1_TEST_PACKAGE_PREFIX;
  assert.ok(requestedPrefix && requestedPrefix.startsWith('/'));
  assert.match(basename(requestedPrefix), /^TEST-native-opencode-v1-[A-Za-z0-9_-]+$/);
  const prefix = await realpath(requestedPrefix);
  const receiptPath = process.env.OPENCODE_V1_TEST_RECEIPT;
  assert.ok(receiptPath && receiptPath.startsWith('/'));
  const repo = resolve(import.meta.dirname, '../../..');
  const pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(process.execPath);
  const entry = join(pkg, 'dist/cli.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-v1-version-host-')));
  for (const name of ['home', 'tmp', 'workspace', 'store', 'xdg-config', 'xdg-data', 'xdg-cache'])
    await mkdir(join(root, name), { mode: 0o700 });
  const environment = {
    HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), PATH: `${dirname(node)}:/usr/bin:/bin`,
    SHELL: '/bin/sh', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1', NO_COLOR: '1',
  };
  const steps: string[] = [];
  let host: ReturnType<typeof startHost> | undefined;
  let model: Awaited<ReturnType<typeof startOpenCodeModel>> | undefined;
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  let passed = false;
  let cleanup = false;
  let nativeVersion: string | undefined;
  let nativeDigest: string | undefined;
  let nativeIntegrity: string | undefined;
  let nodeDigest: string | undefined;
  let providerDigest: string | undefined;
  let hostSourceDigest: string | undefined;
  let hostDistDigest: string | undefined;
  let failure = false;
  try {
    const rootManifest = JSON.parse(await readFile(join(prefix, 'node_modules/opencode-ai/package.json'), 'utf8'));
    assert.equal(rootManifest.name, 'opencode-ai');
    assert.equal(rootManifest.version, version);
    const avx2 = /(^|\s)avx2(\s|$)/.test(await readFile('/proc/cpuinfo', 'utf8'));
    const nativePackage = avx2 ? 'opencode-linux-x64' : 'opencode-linux-x64-baseline';
    assert.equal(String(rootManifest.optionalDependencies[nativePackage]).replace(/^[~^]/, ''), version);
    const nativeRoot = await realpath(join(prefix, 'node_modules', nativePackage));
    assert.ok(nativeRoot.startsWith(prefix + sep), 'native package remains inside verified npm prefix');
    const nativeManifest = JSON.parse(await readFile(join(nativeRoot, 'package.json'), 'utf8'));
    assert.equal(nativeManifest.name, nativePackage);
    assert.equal(nativeManifest.version, version);
    const lockBytes = await readFile(join(prefix, 'package-lock.json'));
    const lock = JSON.parse(lockBytes.toString());
    const locked = lock.packages[relative(prefix, nativeRoot).split(sep).join('/')];
    assert.equal(locked.version, version);
    assert.match(locked.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    nativeIntegrity = locked.integrity;
    const binary = await realpath(join(nativeRoot, 'bin/opencode'));
    assert.ok(binary.startsWith(nativeRoot + sep));
    const nativeStat = await stat(binary);
    assert.ok(nativeStat.isFile() && nativeStat.size > 0 && nativeStat.size <= 512 * 1024 * 1024,
      'native input must be a bounded regular file');
    const bytes = await readFile(binary);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
    nativeDigest = createHash('sha256').update(bytes).digest('hex');
    nativeVersion = execFileSync(binary, ['--version'], {
      cwd: join(root, 'workspace'), env: environment, timeout: 15_000,
      maxBuffer: 1024, encoding: 'utf8',
    }).trim();
    assert.equal(nativeVersion, version, 'actual native executable reports the selected stable release');
    nodeDigest = await fileHash(node);
    hostSourceDigest = await treeHash(join(pkg, 'src'), '.ts');
    hostDistDigest = await treeHash(join(pkg, 'dist'), '.js');
    const hostManifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
    const providerReference: unknown = hostManifest.dependencies['@agent-teams/provider-implementations'];
    assert.equal(typeof providerReference, 'string');
    assert.ok((providerReference as string).startsWith('file:../../vendor/provider-migration/'));
    providerDigest = await fileHash(resolve(pkg, (providerReference as string).slice(5)));
    steps.push('native_version_package_integrity_and_source_measured');

    model = await startOpenCodeModel();
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
    const namespace = basename(root);
    const owner = {
      ownerId: `TEST-owner-${namespace}`, revision: 'TEST-revision', storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`, protocolVersion: 1 as const, buildId: 'TEST-v1-version-host',
      nodeSha256: nodeDigest, hostEntrySha256: await fileHash(entry),
    };
    const scope = {
      projectId: `TEST-project-${namespace}`, workspaceId: `TEST-workspace-${namespace}`,
      teamId: 'TEST-team', runId: `TEST-run-${namespace}`, memberId: 'human', generation: '1',
    };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-team' };
    const profile: TeamHostProfile = {
      schemaVersion: 1, owner, principalId: 'human',
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
        // A wire revision is distinct from the installed executable version measured above.
        protocolRevision: '1.19.4', sessionId: `TEST-session-${namespace}`, generation: 1,
        configRevision: 'TEST-config-1', cwd: join(root, 'workspace'), model: 'TEST-model', endpoint,
        accountBinding: 'TEST-localhost-account', executable: { path: binary, sha256: nativeDigest },
        environment: { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify({
          autoupdate: false, share: 'disabled', enabled_providers: ['TEST-local'],
          model: 'TEST-local/TEST-model', small_model: 'TEST-local/TEST-model',
          permission: { '*': 'deny', bash: 'ask' }, compaction: { auto: false },
          agent: { title: { disable: true }, summary: { disable: true }, 'TEST-member': { mode: 'primary' } },
          provider: { 'TEST-local': { npm: '@ai-sdk/openai-compatible', name: 'TEST local',
            options: { baseURL: `${model.url}/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
            models: { 'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } } },
          } },
        }) },
        nativeOptions: { providerId: 'TEST-local', agent: 'TEST-member',
          instructions: `${CONTEXT_MARKER}. You are carol of test-native-team working only in ${join(root, 'workspace')}.` },
        limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 1_000_000,
          outputEvents: 1500, pendingInteractions: 4, timeoutMs: 45_000 },
      }] },
    };
    const profilePath = join(root, 'profile.json');
    const profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    const profileHash = createHash('sha256').update(profileBytes).digest('hex');
    const start = () => startHost({ node, entry, root, profile: profilePath, profileHash });
    const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    const opened = await host.rpc('runtime.open', envelope('TEST-open', { memberId: 'carol-id' }));
    assert.equal(opened.ok, true);
    assert.equal(record(opened.value).nativeReady, true);
    steps.push('original_host_native_runtime_and_mcp_ready');
    const command = envelope('TEST-original-message', {
      operation: 'message.send', payload: { to: 'carol', text: 'OPENCODE_TEAM_ONE' },
    });
    const original = await host.rpc('team.execute', command);
    assert.equal(original.ok, true);
    assert.equal(record(original.value).phase, 'completed');
    const inputId = record(record(original.value).effects).deliveryId;
    assert.equal(typeof inputId, 'string');
    const replies = new Set<string>();
    let terminal = false;
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      assert.deepEqual(model.failures, []);
      const result: Record<string, unknown> = await host.rpc('runtime.read', envelope('TEST-read', { memberId: 'carol-id' }));
      assert.equal(result.ok, true);
      const state = record(result.value);
      const pending = (state.interactions as unknown[]).map(record).filter(row => row.phase === 'pending');
      assert.ok(pending.length <= 1);
      for (const interaction of pending) {
        assert.equal(interaction.kind, 'permission');
        assert.equal(interaction.inputId, inputId);
        assert.equal(typeof interaction.interactionRef, 'string');
        const ref = interaction.interactionRef as string;
        assert.ok(!replies.has(ref), 'never retry an uncertain permission reply');
        replies.add(ref);
        const granted = await host.rpc('runtime.interaction', envelope('TEST-once', {
          memberId: 'carol-id', expectedGeneration: '1', inputId, interactionRef: ref,
          reply: { kind: 'permission', decision: 'allow' },
        }));
        assert.equal(granted.ok, true);
      }
      const input = (state.inputs as unknown[]).map(record).find(row => row.inputId === inputId);
      if (input?.phase === 'terminal') {
        assert.equal(input.terminal, 'succeeded'); terminal = true; break;
      }
      await tick();
    }
    assert.equal(terminal, true);
    assert.equal(replies.size, 1);
    assert.deepEqual(model.failures, []);
    assert.equal(model.observations.length, 8, 'seven actual tools followed by one terminal model response');
    assert.ok(model.observations.every(row => row.contextEffective));
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
    const listed = await host.rpc('team.tasks.list', envelope('TEST-tasks', null));
    assert.equal(listed.ok, true);
    const tasks = listed.value as unknown[];
    assert.equal(tasks.length, 1);
    assert.equal(record(tasks[0]).status, 'completed');
    assert.equal(record(tasks[0]).owner, 'carol');
    assert.equal((record(tasks[0]).comments as unknown[]).length, 1);
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(record).map(row => [row.from, row.text]), [['carol', 'REPLY_OPENCODE_ONE']]);
    const activity = await host.rpc('runtime.activity.snapshot', envelope('TEST-activity', { memberId: 'carol-id' }));
    assert.equal(activity.ok, true);
    assert.ok((record(record(activity.value).latest).tools as unknown[]).map(record).some(row =>
      record(row.data).kind === 'tool-result' && record(row.data).isError === true),
    'failed shell tool must not be relabelled as successful');
    assert.deepEqual(await host.rpc('team.execute', command), original);
    steps.push('native_model_tools_permission_task_and_reply_completed_once');
    const stopped = await host.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'carol-id' }));
    assert.equal(stopped.ok, true);
    assert.equal(record(stopped.value).phase, 'closed');
    assert.equal(record(stopped.value).custody, 'released');
    await host.close(); hosts.push(host.facts()); host = undefined;
    steps.push('original_host_runtime_stop_and_cleanup_confirmed');
    const callsBefore = model.observations.length;
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    assert.deepEqual(await host.rpc('team.lookup', command), original);
    assert.deepEqual(await host.rpc('team.execute', command), original);
    const recovered = await host.rpc('runtime.read', envelope('TEST-recovered', { memberId: 'carol-id' }));
    assert.equal(recovered.ok, true);
    assert.equal(record(recovered.value).attached, false);
    assert.equal((record(recovered.value).inputs as unknown[]).length, 1);
    await host.close(); hosts.push(host.facts()); host = undefined;
    assert.equal(model.observations.length, callsBefore);
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
    assert.equal(await fileHash(binary), nativeDigest);
    assert.equal(await treeHash(join(pkg, 'src'), '.ts'), hostSourceDigest);
    assert.equal(await treeHash(join(pkg, 'dist'), '.js'), hostDistDigest);
    steps.push('cold_receipt_readback_without_native_replay_or_source_mutation');
    passed = true;
  } catch (error) { failure = true; throw error; }
  finally {
    try {
      if (host) { await host.close(); hosts.push(host.facts()); host = undefined; }
      cleanup = true;
    } finally {
      await model?.close();
      await writeFile(receiptPath, JSON.stringify({
        kind: 'TEST_NATIVE_V1_VERSION_HOST', sourceHead, platform: `${process.platform}-${process.arch}`,
        status: passed && cleanup && !failure ? 'PASS' : 'INCOMPLETE', cleanup,
        selectedCliVersion: version, nativeVersion, nativeDigest, nativeIntegrity,
        wireProtocolRevision: '1.19.4', nodeVersion: process.version, nodeDigest,
        providerDigest, hostSourceDigest, hostDistDigest, steps,
        hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({ exitCode, signalCode, stdoutValid })),
        modelOrigin: 'localhost-scripted', modelRequests: model?.observations.length ?? 0,
        vendorAuthQualified: false, desktopQualified: false, releaseQualified: false,
      }, null, 2) + '\n', { mode: 0o600 });
    }
  }
});
