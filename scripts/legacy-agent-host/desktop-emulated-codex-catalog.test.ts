import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { codexMcpPolicyArgs } from '../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/codex.js';
import type { TestContext } from 'node:test';

const catalog = { digest: createHash('sha256').update('[]').digest('hex'), servers: [] };

async function fixture(t: TestContext, role: 'runtime' | 'management' = 'runtime') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  let close: (() => Promise<void>) | undefined;
  t.after(async () => { await close?.(); await rm(root, { recursive: true, force: true }); });
  const scope = join(root, 'TEST-peer-codex-scope'), workspace = join(root, 'workspace');
  for (const path of [scope, workspace]) await mkdir(path, { mode: 0o700 });
  for (const child of ['home', 'tmp', 'config', 'data', 'cache']) await mkdir(join(scope, child), { mode: 0o700 });
  const node = await realpath(process.execPath), source = await realpath(join(import.meta.dirname,
    '../../tools/owned-process-broker/fixtures/providerDesktopPeer.mjs'));
  const environment = { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: join(scope, 'home'), TMPDIR: join(scope, 'tmp'),
    XDG_CONFIG_HOME: join(scope, 'config'), XDG_DATA_HOME: join(scope, 'data'), XDG_CACHE_HOME: join(scope, 'cache'),
    CODEX_HOME: join(scope, 'config'), TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1',
    TEST_PEER_PROVIDER: 'codex', TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: scope,
    TEST_DESKTOP_PEER_WORKSPACE: workspace, TEST_PEER_EFFECTS: join(scope, 'effects.ndjson') };
  const invoke = (args = ['mcp', 'list', '--json'], extra: Record<string, string> = {}) => spawnSync(node,
    [source, ...args], { cwd: workspace, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  const effects = async (): Promise<Record<string, unknown>[]> => {
    let bytes: string;
    try { bytes = await readFile(environment.TEST_PEER_EFFECTS, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    assert.ok(Buffer.byteLength(bytes) <= 65536); return bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  return { scope, workspace, node, source, environment, invoke, effects,
    cleanupWith: (callback: () => Promise<void>) => { assert.equal(close, undefined); close = callback; } };
}

test('finite Codex exact native MCP catalog exits with empty inventory without allocating a Runtime', async t => {
  for (const role of ['runtime', 'management'] as const) {
    const f = await fixture(t, role), result = f.invoke();
    assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.error, undefined);
    assert.equal(result.stderr, ''); assert.equal(result.stdout, '[]\n');
    const effects = await f.effects(); assert.deepEqual(effects.map(row => row.event), ['launch', 'mcp-catalog']);
    assert.ok(effects.every(row => row.provider === 'codex' && row.role === role && row.pid === result.pid));
    assert.equal(effects[0]!.parentPid, process.pid); assert.equal(effects[0]!.argc, 3);
    assert.equal(effects[1]!.configuredServers, 0);
  }
});

test('finite Codex catalog refuses changed argv, Runtime authority and nonempty selected configuration', async t => {
  const f = await fixture(t);
  for (const args of [['mcp', 'list'], ['mcp', 'list', '--json', '--unselected'], ['mcp', 'add', 'TEST-unselected']]) {
    const result = f.invoke(args); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.error, undefined); assert.deepEqual(await f.effects(), []);
  }
  const authorized = f.invoke(undefined, { LEGACY_AGENT_HOST_TEAM_MCP_TOKEN: 'TEST-no-runtime-authority' });
  assert.equal(authorized.status, 1); assert.equal(authorized.stdout, ''); assert.deepEqual(await f.effects(), []);
  const path = join(f.scope, 'config/config.toml'), bytes = '[mcp_servers.TEST-unselected]\nurl="http://127.0.0.1:9/TEST-never-connect"\n';
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  const configured = f.invoke(); assert.equal(configured.status, 1); assert.equal(configured.stdout, '');
  assert.deepEqual(await f.effects(), []); assert.equal(await readFile(path, 'utf8'), bytes);
});

test('finite Codex answers the original D managed config before connecting its selected Team on thread start', async t => {
  const f = await fixture(t), methods: string[] = [], frames: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/TEST-team'); assert.equal(request.headers.authorization, 'Bearer TEST-metadata-only');
      if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
      assert.equal(request.method, 'POST'); let bytes = '';
      for await (const chunk of request) { bytes += chunk; assert.ok(Buffer.byteLength(bytes) <= 65536); }
      const message = JSON.parse(bytes); methods.push(message.method);
      if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
      assert.ok(message.method === 'initialize' || message.method === 'tools/list');
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'TEST-no-tools', version: '1' } } : { tools: [] };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { response.writeHead(500); response.end('TEST refused unexpected request'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const team = { url: `http://127.0.0.1:${address.port}/TEST-team`, bearer_token_env_var: 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN',
    enabled_tools: [], tools: {}, startup_timeout_sec: 5 };
  const args: string[] = ['app-server', '--listen', 'stdio://', ...codexMcpPolicyArgs({ catalog, selected: { team } })];
  const child = spawn(f.node, [f.source, ...args], { cwd: f.workspace,
    env: { ...f.environment, LEGACY_AGENT_HOST_TEAM_MCP_TOKEN: 'TEST-metadata-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; assert.ok(Buffer.byteLength(stderr) <= 65536); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { assert.ok(frames.length < 64); frames.push(JSON.parse(line)); });
  f.cleanupWith(async () => {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5000); timeout.unref();
    try { assert.deepEqual(await exited, [0, null], stderr); } finally { clearTimeout(timeout); lines.close(); }
  });
  const rpc = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); const deadline = performance.now() + 5000;
    for (;;) {
      assert.ok(performance.now() < deadline, 'original finite protocol deadline');
      assert.equal(child.exitCode, null, stderr); const found = frames.find(row => row.id === id);
      if (found) { assert.equal(found.error, undefined); return found.result as Record<string, unknown>; }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  await rpc(1, 'initialize'); assert.deepEqual(methods, []);
  const config = await rpc(2, 'config/read');
  assert.deepEqual(config, { config: { model: 'TEST-model', model_provider: 'TEST-fixture', features: { apps: false },
    mcp_servers: { team: { ...team, enabled: true, environment_id: 'local', tool_timeout_sec: null } } } });
  assert.deepEqual(methods, [], 'configuration check precedes any MCP initialization or tool discovery');
  assert.deepEqual((await f.effects()).map(row => row.event), ['launch', 'managed-configuration-read']);
  await rpc(3, 'thread/start', { cwd: f.workspace, model: 'TEST-model' });
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
  assert.deepEqual((await f.effects()).map(row => row.event), ['launch', 'managed-configuration-read', 'connected']);
});

test('finite managed Codex policy refuses alternate syntax, extra servers and enabled apps before connection', async t => {
  const f = await fixture(t), team = { url: 'http://127.0.0.1:9/TEST-never-connect',
    bearer_token_env_var: 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN', enabled_tools: [], tools: {} };
  const policy = [...codexMcpPolicyArgs({ catalog, selected: { team } })];
  const variants = [policy.map(row => row === 'features.apps=false' ? 'features.apps=true' : row),
    policy.map(row => row.startsWith('mcp_servers=') ? row.replace('"team"=', '"team":') : row),
    codexMcpPolicyArgs({ catalog, selected: { team, foreign: { url: team.url } } })];
  for (const args of variants) {
    const result = f.invoke(['app-server', '--listen', 'stdio://', ...args], { LEGACY_AGENT_HOST_TEAM_MCP_TOKEN: 'TEST-no-runtime-authority' });
    assert.equal(result.status, 1); assert.equal(result.error, undefined); assert.equal(result.stdout, '');
    assert.deepEqual(await f.effects(), []);
  }
});
