import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { CONTEXT_MARKER, record, startNativeTeamModel } from './fixtures/native-claude-team/model.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fileHash = async (path: string) => hash(await readFile(path));
const tick = () => new Promise<void>((done) => setTimeout(done, 25));

// Pins the complete compiled/source host, including transitive composition changes.
// Sorted relative path + NUL + exact file bytes + NUL, recursively for .js/.ts.
async function treeHash(root: string, suffix: string): Promise<string> {
  async function paths(directory: string, prefix = ''): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) result.push(...await paths(join(directory, entry.name), relative + '/'));
      else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(relative);
    }
    return result;
  }
  const digest = createHash('sha256');
  for (const path of (await paths(root)).sort()) digest.update(path).update('\0').update(await readFile(join(root, path))).update('\0');
  return digest.digest('hex');
}

function startHost(options: { node: string; entry: string; root: string; profile: string; profileHash: string }) {
  const child = spawn(options.node, [options.entry], {
    cwd: options.root,
    env: {
      HOME: join(options.root, 'home'), TMPDIR: join(options.root, 'tmp'),
      PATH: `${dirname(options.node)}:/usr/bin:/bin`,
      LEGACY_AGENT_HOST_PROFILE_PATH: options.profile,
      LEGACY_AGENT_HOST_PROFILE_SHA256: options.profileHash,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const frameFacts: { id: number; method: string; ok: boolean }[] = [];
  let nextId = 0;
  let stdoutValid = true;
  let diagnosticBytes = 0;
  let exited = false;
  const exit = new Promise<void>((done) => {
    child.once('exit', () => { exited = true; done(); });
    child.once('error', () => { exited = true; done(); });
  });
  child.stderr.on('data', (chunk: Buffer) => { diagnosticBytes += chunk.length; });
  lines.on('line', (line) => {
    try {
      assert.ok(Buffer.byteLength(line) < 256 * 1024);
      const frame = record(JSON.parse(line) as unknown);
      assert.equal(frame.jsonrpc, '2.0');
      if (frame.id === undefined && typeof frame.method === 'string') return;
      assert.equal(typeof frame.id, 'number');
      const waiter = pending.get(Number(frame.id));
      assert.ok(waiter, 'one answer for a test-owned RPC request');
      pending.delete(Number(frame.id)); clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error('Host returned RPC protocol error'));
      else waiter.resolve(frame.result);
    } catch {
      stdoutValid = false;
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Host stdout protocol violation')); }
      pending.clear();
    }
  });
  async function waitExit(timeout: number) {
    const end = Date.now() + timeout;
    while (!exited && Date.now() < end) await tick();
    return exited;
  }
  return {
    child,
    async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
      assert.ok(!exited && stdoutValid);
      const id = ++nextId;
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host RPC ${method} exceeded 60 seconds; intent retained`)); }, 60_000);
        pending.set(id, { resolve, reject, timer });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const result = record(await response);
      if (method.startsWith('runtime.') && result.ok === true) {
        const safe = record(result.value);
        assert.ok(Object.keys(safe).every((key) => ['memberId', 'phase', 'sealed', 'custody', 'nativeReady', 'attached', 'inputs', 'interactions', 'diagnostic'].includes(key)), 'runtime RPC exposes only its explicit safe projection');
        assert.ok((safe.inputs as unknown[]).map(record).every((input) => Object.keys(input).every((key) => ['inputId', 'phase', 'terminal'].includes(key))));
        assert.equal(JSON.stringify(safe).includes('Bearer '), false);
      }
      frameFacts.push({ id, method, ok: result.ok !== false });
      return result;
    },
    async close() {
      child.stdin.end();
      if (!await waitExit(12_000)) { child.kill('SIGTERM'); assert.ok(await waitExit(12_000), 'captured Host must confirm provider cleanup before exiting'); }
      await exit;
      lines.close();
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Host closed')); }
      pending.clear();
      assert.equal(child.exitCode, 0, 'Host exit zero confirms Runtime/provider cleanup completed');
      assert.equal(child.signalCode, null);
      assert.equal(stdoutValid, true);
    },
    facts: () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stdoutValid, diagnosticBytes, frames: frameFacts }),
  };
}

test('standalone Host stdio routes two business messages through actual Claude Runtime and recovers receipts', { timeout: 180_000 }, async (t) => {
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
  const model = await startNativeTeamModel();
  let current: ReturnType<typeof startHost> | undefined;
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  const receipts: Record<string, unknown>[] = [];
  let finalRuntime: Record<string, unknown> = {};
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
    const command = (label: string) => envelope(`human-native-${label.toLowerCase()}`, { operation: 'message.send', payload: { to: 'alice', text: `NATIVE_TEAM_${label}` } });
    current = start();
    const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
    assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
    const opened = await current.rpc('runtime.open', envelope('TEST-open', { memberId: 'alice-id' }));
    assert.equal(opened.ok, true);
    assert.equal(record(opened.value).nativeReady, true, 'actual D native mandatory MCP discovery');
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
    assert.ok(model.observations.some((item) => item.toolResultError), 'actual native Bash exit seven returns an error tool result before successful conversation completion');
    assert.ok(model.observations.filter((item) => item.turn === 'NATIVE_TEAM_TWO').every((item) => item.priorTurn));
    const stopped = await current.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'alice-id' }));
    assert.equal(stopped.ok, true); finalRuntime = record(stopped.value);
    assert.equal(finalRuntime.phase, 'closed'); assert.equal(finalRuntime.custody, 'released');
    await current.close(); hosts.push(current.facts()); current = undefined;
    const requestsBeforeRestart = model.observations.length;
    current = start();
    await current.rpc('host.handshake', { protocolVersion: 1 });
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
        cleanupConfirmed, businessReceipts: receipts, runtime: finalRuntime,
        modelObservations: model.observations, modelFailures: model.failures,
        scope: 'Standalone Host stdio + RuntimeTeamCoordinator + public D + actual Claude native/MCP, single member',
        excluded: ['Desktop UI', 'mixed providers', 'whole P4', 'aggregate team bootstrap', 'real authentication'],
      }, null, 2), { mode: 0o600 });
    }
  }
});
