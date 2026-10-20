#!/usr/bin/env node
// pnpm exec node scripts/e2e/gateway-provider-live-desktop.mts --scenario all
// Requires an already verified LOCAL sub2api stand and its test-only admin env file.
// GATEWAY_E2E_STAND_ENV=/path/to/stand/.env; never use a production gateway.
// Owns dev:mcp, isolated HOME/config, a marked sandbox, keys/groups/accounts and proxies.
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockUpstream } from './gateway-provider/mockUpstream.ts';
import { verifyGatewayUi, type GatewayUiPage } from './gateway-provider-ui-desktop.mts';
import type { ElectronAPI } from '../../src/shared/types/api.ts';
import type { TokenUsageAnalyticsSnapshotDto } from '../../src/features/token-usage/contracts/dto.ts';

interface InputPage {
  url(): string;
  evaluate<T, A = undefined>(fn: ((arg: A) => T | Promise<T>) | string, arg?: A): Promise<T>;
  screenshot(options: { path: string; scale?: 'css' }): Promise<Buffer>;
}
interface InputBrowser {
  contexts(): { pages(): InputPage[] }[];
  close(): Promise<void>;
}
interface Playwright {
  chromium: { connectOverCDP(url: string): Promise<InputBrowser> };
}
const require = createRequire(import.meta.url);
function playwright(): Playwright {
  try {
    return require('playwright') as Playwright;
  } catch {
    return require(
      path.join(
        os.homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
      )
    ) as Playwright;
  }
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stand = new URL(process.env.SUB2API_BASE ?? 'http://127.0.0.1:8080');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(stand.hostname), 'E2E stand must be loopback');
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'all';
const names = ['claude-two', 'codex-two', 'opencode-one', 'mixed', 'binding-switch'] as const;
assert(
  scenario === 'all' || names.includes(scenario as (typeof names)[number]),
  'Unknown scenario'
);
const selected = scenario === 'all' ? [...names] : [scenario];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secrets = new Set<string>();
function redact(value: string): string {
  for (const secret of secrets) value = value.replaceAll(secret, '[TEST_CREDENTIAL]');
  return value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[\w-]{12,}/g, '[REDACTED]');
}
async function poll<T>(
  label: string,
  read: () => Promise<T | null | false>,
  timeout = 180_000
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(1000);
  }
  throw new Error(`Timed out: ${label}`);
}
async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, redact(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 });
}
interface Entity {
  id: number;
  name?: string;
  key?: string;
  platform?: string;
}
interface Usage {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  actual_cost: number;
  cost: number;
}
interface Member {
  name: string;
  providerId: 'anthropic' | 'codex' | 'opencode';
  model: string;
  key: string;
  keyId: number;
  profile: string;
  ref: string;
}
interface RouteCall {
  at: string;
  route: number;
  path: string;
  credentialHash: string;
  status: number;
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}
// macOS per-user TMPDIR can exceed the Unix socket limit used by tsx.
const fixtureTmp = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
const root = await realpath(await mkdtemp(path.join(fixtureTmp, 'gateway-desktop-e2e-')));
await chmod(root, 0o700);
const directoryNames = [
  'home',
  'claude',
  'user-data',
  'config',
  'data',
  'cache',
  'state',
  'runtime',
  'tmp',
  'sandbox',
  'evidence',
] as const;
const dirs = Object.fromEntries(
  directoryNames.map((name) => [name, path.join(root, name)])
) as Record<(typeof directoryNames)[number], string>;
await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
await writeFile(path.join(dirs.sandbox, '.gateway-e2e-test-only'), root);
assert.equal(await readFile(path.join(dirs.sandbox, '.gateway-e2e-test-only'), 'utf8'), root);
await writeFile(path.join(dirs.sandbox, 'README.md'), '# Disposable gateway desktop E2E\n');
execFileSync('git', ['init', '-q', dirs.sandbox]);
const logs: string[] = [];
const routes: RouteCall[] = [];
const proxies: Server[] = [];
const groups: number[] = [];
const accounts: number[] = [];
const keys: number[] = [];
const teams: string[] = [];
const profileIds: string[] = [];
const results: unknown[] = [];
let uiVerified = false;
let adminToken = '';
let app: ChildProcess | undefined;
let browser: InputBrowser | undefined;
let page: InputPage | undefined;
let mock: Awaited<ReturnType<typeof startMockUpstream>> | undefined;
const leadKey = `gateway-e2e-lead-${randomUUID()}`;
secrets.add(leadKey);
async function api<T>(method: string, route: string, body?: unknown, key?: string): Promise<T> {
  const res = await fetch(new URL(route, stand), {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key ?? adminToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = (await res.json()) as { data?: T; message?: string } & T;
  assert(res.ok, `Stand ${method} ${route}: ${res.status} ${redact(value.message ?? '')}`);
  return value.data ?? value;
}
async function invoke<T>(
  section: keyof ElectronAPI,
  method: string,
  ...args: unknown[]
): Promise<T> {
  assert(page);
  return page.evaluate<T, { section: string; method: string; args: unknown[] }>(
    async (input) => {
      const api = (
        window as unknown as {
          electronAPI: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
        }
      ).electronAPI;
      return (await api[input.section][input.method](...input.args)) as T;
    },
    { section, method, args }
  );
}
async function usage(member: Pick<Member, 'key' | 'model'>): Promise<Usage> {
  const day = new Date().toISOString().slice(0, 10);
  const value = await api<{ model_stats: Usage[] }>(
    'GET',
    `/v1/usage?start_date=${day}&end_date=${day}`,
    undefined,
    member.key
  );
  assert(Array.isArray(value.model_stats), 'Usage must explicitly contain model_stats');
  return (
    value.model_stats.find((row) => row.model === member.model) ?? {
      model: member.model,
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      actual_cost: 0,
      cost: 0,
    }
  );
}
async function freshKey(name: string, groupId: number): Promise<Entity & { key: string }> {
  const key = await api<Entity>('POST', '/api/v1/keys', { name, group_id: groupId });
  assert(key.key, 'Stand must return newly created test key');
  secrets.add(key.key);
  keys.push(key.id);
  return key as Entity & { key: string };
}
async function waitReady(team: string, runId: string): Promise<void> {
  await poll(
    'team bootstrap readiness',
    async () => {
      const progress = await invoke<{ state: string; error?: string; message?: string }>(
        'teams',
        'getProvisioningStatus',
        runId
      );
      await json(path.join(dirs.evidence, `${team}-progress.json`), progress);
      assert(
        !['failed', 'cancelled', 'disconnected'].includes(progress.state),
        `Provisioning ${progress.state}: ${redact(progress.error ?? progress.message ?? '')}`
      );
      return progress.state === 'ready';
    },
    8 * 60_000
  );
}
async function assertSnapshot(
  team: string,
  members: Member[]
): Promise<TokenUsageAnalyticsSnapshotDto> {
  return poll('gateway amounts in app snapshot', async () => {
    const snapshot = await invoke<TokenUsageAnalyticsSnapshotDto>('tokenUsage', 'refreshSnapshot', {
      teamName: team,
    });
    let expectedCost = 0;
    for (const member of members) {
      const meter = await usage(member);
      const entry = snapshot.byAgent.find(
        (row) => row.agentName === member.name && row.teamName === team
      );
      if (
        !entry ||
        entry.summary.requestCount !== meter.requests ||
        Math.abs(entry.summary.billableCostUsd - meter.actual_cost) > 1e-8
      )
        return false;
      assert.equal(entry.summary.inputTokens, meter.input_tokens);
      assert.equal(entry.summary.outputTokens, meter.output_tokens);
      expectedCost += meter.actual_cost;
    }
    const leadCost = snapshot.byAgent
      .filter((row) => !members.some((member) => row.agentName === member.name))
      .reduce((sum, row) => sum + row.summary.billableCostUsd, 0);
    assert(
      Math.abs(snapshot.summary.billableCostUsd - expectedCost - leadCost) < 1e-8,
      'Team total contains gateway members and the independent lead once'
    );
    assert(snapshot.sourceCounts.gateway_exact >= members.length);
    await json(path.join(dirs.evidence, `${team}-snapshot.json`), snapshot);
    return snapshot;
  });
}
try {
  const envFile = process.env.GATEWAY_E2E_STAND_ENV;
  assert(envFile, 'Set GATEWAY_E2E_STAND_ENV to the disposable stand admin env file');
  const standEnv = Object.fromEntries(
    (await readFile(envFile, 'utf8'))
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, ''),
      ])
  );
  assert(/local\.test$/.test(standEnv.ADMIN_EMAIL ?? ''), 'Only the local test admin is accepted');
  secrets.add(standEnv.ADMIN_PASSWORD);
  const login = await api<{ access_token: string }>('POST', '/api/v1/auth/login', {
    email: standEnv.ADMIN_EMAIL,
    password: standEnv.ADMIN_PASSWORD,
  });
  adminToken = login.access_token;
  secrets.add(adminToken);
  mock = await startMockUpstream({
    sharedStandNetwork: process.argv.includes('--shared-stand-network'),
  });
  const permitted = new Set<string>();
  const endpoints: string[] = [];
  for (let index = 0; index < 2; index++) {
    const proxy = createServer(async (req, res) => {
      const auth = (req.headers['x-api-key'] ?? req.headers.authorization ?? '')
        .toString()
        .replace(/^Bearer\s+/i, '');
      const call: RouteCall = {
        at: new Date().toISOString(),
        route: index,
        path: req.url ?? '/',
        credentialHash: hash(auth),
        status: 0,
      };
      routes.push(call);
      // Runtime reachability probes use the public root without credentials.
      if (!auth && req.url === '/' && ['GET', 'HEAD'].includes(req.method ?? '')) {
        call.status = 200;
        res.writeHead(200);
        res.end('Gateway E2E fixture');
        return;
      }
      if (!permitted.has(auth)) {
        call.status = 403;
        res.writeHead(403);
        res.end('Test route rejects inherited/default credentials');
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(
            ([name, value]) =>
              !['host', 'connection', 'content-length'].includes(name) && typeof value === 'string'
          )
        ) as Record<string, string>;
        const requestUrl = new URL(req.url ?? '/', 'http://gateway-e2e.invalid');
        const targetUrl = new URL(stand);
        targetUrl.pathname = requestUrl.pathname;
        targetUrl.search = requestUrl.search;
        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          ...(body.length ? { body } : {}),
        });
        call.status = upstream.status;
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch {
        call.status = 502;
        res.writeHead(502);
        res.end('Local test stand transport failed');
      }
    });
    proxies.push(proxy);
    endpoints.push(`http://127.0.0.1:${await listen(proxy)}`);
  }
  const runtimeCli = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
  assert(
    runtimeCli && path.isAbsolute(runtimeCli),
    'Set explicit compatible source/built orchestrator launcher'
  );
  await writeFile(
    path.join(dirs.claude, 'agent-teams-config.json'),
    JSON.stringify({
      general: {
        appLocale: 'en',
        agentLanguage: 'en',
        theme: 'dark',
        defaultTab: 'teams',
        multimodelEnabled: true,
        telemetryEnabled: false,
      },
      providerConnections: {
        anthropic: {
          authMode: 'api_key',
          compatibleEndpoint: { enabled: true, baseUrl: mock.baseUrl },
        },
        codex: { preferredAuthMode: 'api_key' },
      },
    })
  );
  await writeFile(
    path.join(dirs.claude, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: mock.baseUrl,
        ANTHROPIC_AUTH_TOKEN: leadKey,
        ANTHROPIC_API_KEY: '',
      },
    }),
    { mode: 0o600 }
  );
  const env: NodeJS.ProcessEnv = {};
  // Inherit tool discovery/display only; runtime config and credentials belong to this fixture.
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'SystemRoot',
    'ComSpec',
    'WINDIR',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.claude,
    CODEX_HOME: path.join(dirs.home, '.codex'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: dirs.claude,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: dirs['user-data'],
    CLAUDE_MULTIMODEL_DATA_HOME: dirs.data,
    CLAUDE_MULTIMODEL_CACHE_HOME: dirs.cache,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
    TMPDIR: dirs.tmp,
    SHELL: '/bin/sh',
    NODE_BINARY: process.execPath,
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: runtimeCli,
    ANTHROPIC_BASE_URL: mock.baseUrl,
    ANTHROPIC_AUTH_TOKEN: leadKey,
    ANTHROPIC_API_KEY: '',
    CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '120000',
    CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '120000',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    pnpm_config_verify_deps_before_run: 'false',
  });
  const devArgs = ['dev:mcp', ...(process.platform === 'linux' ? ['--noSandbox'] : [])];
  app = spawn('pnpm', devArgs, {
    cwd: repo,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString());
      void writeFile(path.join(dirs.evidence, 'app.log'), redact(logs.join('')), { mode: 0o600 });
    });
  app.on('error', (error) => logs.push(String(error)));
  const port = await poll('owned dev:mcp endpoint', async () => {
    assert(app?.exitCode === null, `Owned desktop exited ${app?.exitCode}`);
    return (
      Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(logs.join(''))?.[1]) || null
    );
  });
  browser = await playwright().chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await poll(
    'owned renderer',
    async () =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('http://localhost:')) ?? null
  );
  await poll(
    'preload ready',
    async () =>
      page?.evaluate<boolean>(
        'Boolean(window.electronAPI?.gatewayProvider && window.__agentTeamsDevStore)'
      ) ?? false
  );
  await json(path.join(root, 'fixture.json'), {
    root,
    dirs,
    port,
    runtimeCli,
    endpoints,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
  });
  console.log(`Owned desktop and sandbox: ${root}`);
  // Install actual provider CLIs into this disposable app profile. A source
  // launcher alone does not supply Codex/OpenCode native executables.
  if (selected.some((name) => name === 'codex-two' || name === 'mixed')) {
    const status = await page.evaluate(async () =>
      (window as unknown as { electronAPI: ElectronAPI }).electronAPI.codexRuntime.install()
    );
    assert(status.installed && status.binaryPath, 'Test profile Codex CLI install failed');
    await json(path.join(dirs.evidence, 'codex-runtime.json'), status);
    console.log('Installed isolated native Codex CLI');
  }
  if (selected.some((name) => name === 'opencode-one' || name === 'mixed')) {
    const status = await page.evaluate(async () =>
      (window as unknown as { electronAPI: ElectronAPI }).electronAPI.openCodeRuntime.install()
    );
    assert(status.installed && status.binaryPath, 'Test profile OpenCode CLI install failed');
    await json(path.join(dirs.evidence, 'opencode-runtime.json'), status);
    console.log('Installed isolated OpenCode CLI');
  }
  for (const name of selected) {
    const team = `gw-e2e-${name}-${Date.now().toString(36)}`;
    teams.push(team);
    const groupByPlatform = new Map<string, number>();
    for (const platform of ['anthropic', 'openai']) {
      const group = await api<Entity>('POST', '/api/v1/admin/groups', {
        name: `${team}-${platform}`,
        platform,
        rate_multiplier: 1,
        subscription_type: 'standard',
      });
      groups.push(group.id);
      groupByPlatform.set(platform, group.id);
      const upstreamKey = `gateway-upstream-${randomUUID()}`;
      secrets.add(upstreamKey);
      const account = await api<Entity>('POST', '/api/v1/admin/accounts', {
        name: `${team}-${platform}`,
        platform,
        type: 'apikey',
        credentials: { api_key: upstreamKey, base_url: mock.dockerBaseUrl },
        group_ids: [group.id],
        concurrency: 10,
        priority: 1,
      });
      accounts.push(account.id);
    }
    const providers: Member['providerId'][] =
      name === 'codex-two'
        ? ['codex', 'codex']
        : name === 'opencode-one'
          ? ['opencode']
          : name === 'mixed'
            ? ['anthropic', 'codex', 'opencode']
            : ['anthropic', 'anthropic'];
    const members: Member[] = [];
    for (const [index, providerId] of providers.entries()) {
      const memberName = ['builder', 'reviewer', 'tester'][index];
      const platform = providerId === 'anthropic' ? 'anthropic' : 'openai';
      const key = await freshKey(`${team}-${memberName}`, groupByPlatform.get(platform)!);
      permitted.add(key.key);
      const profile = await invoke<{ id: string }>('gatewayProvider', 'saveGatewayProfile', {
        displayName: `${team}-${memberName}`,
        baseUrl: endpoints[name === 'codex-two' ? index : 0],
      });
      profileIds.push(profile.id);
      const binding = await invoke<{ gatewayUsageRef: string }>(
        'gatewayProvider',
        'bindGatewayMember',
        { teamName: team, memberName, profileId: profile.id, apiKey: key.key }
      );
      members.push({
        name: memberName,
        providerId,
        model: platform === 'openai' ? 'gpt-5-codex' : 'claude-sonnet-4-5',
        key: key.key,
        keyId: key.id,
        profile: profile.id,
        ref: binding.gatewayUsageRef,
      });
      assert.equal(
        (await usage(members.at(-1)!)).requests,
        0,
        'Fresh scenario key has no previous traffic'
      );
    }
    const request = {
      teamName: team,
      cwd: dirs.sandbox,
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      syncModelsWithLead: false,
      prompt: 'Wait silently for instructions. This is a disposable gateway E2E.',
      members: members.map(({ name, providerId, model }) => ({
        name,
        providerId,
        model,
        role: 'test member',
      })),
    };
    const created = await invoke<{ runId: string }>('teams', 'createTeam', request);
    await waitReady(team, created.runId);
    for (const [index, member] of members.entries()) {
      // Native private startup context can be acknowledged without an API turn.
      // Exercise a real user turn before checking fresh billed gateway traffic.
      await invoke('teams', 'sendMessage', team, {
        member: member.name,
        text: 'Reply GATEWAY_E2E_OK.',
        from: 'user',
      });
      await poll(
        `new billed ${member.name} request`,
        async () => (await usage(member)).requests > 0
      );
      const route = routes.find(
        (call) =>
          call.credentialHash === hash(member.key) &&
          new URL(call.path, 'http://gateway-e2e.invalid').pathname ===
            (member.providerId === 'anthropic'
              ? '/v1/messages'
              : member.providerId === 'codex'
                ? '/v1/responses'
                : '/v1/chat/completions') &&
          call.status === 200 &&
          call.route === (name === 'codex-two' ? index : 0)
      );
      assert(route, `${member.name} must use own actual endpoint/protocol/credential`);
    }
    const firstSnapshot = await assertSnapshot(team, members);
    if (!uiVerified) {
      const uiKey = await freshKey(`${team}-ui`, groupByPlatform.get('anthropic')!);
      permitted.add(uiKey.key);
      await verifyGatewayUi(
        page as unknown as GatewayUiPage,
        { root, dirs, port, endpoints },
        { apiKey: uiKey.key }
      );
      uiVerified = true;
    }
    if (name === 'claude-two' || name === 'codex-two') {
      const before = await usage(members[0]);
      await invoke('teams', 'restartMember', team, members[0].name);
      await invoke('teams', 'sendMessage', team, {
        member: members[0].name,
        text: 'Reply GATEWAY_E2E_OK.',
        from: 'user',
      });
      await poll(
        'direct restart has new billed request',
        async () => (await usage(members[0])).requests > before.requests
      );
      if (name === 'claude-two') {
        const key = await freshKey(`${team}-added`, groupByPlatform.get('anthropic')!);
        permitted.add(key.key);
        const binding = await invoke<{ gatewayUsageRef: string }>(
          'gatewayProvider',
          'bindGatewayMember',
          { teamName: team, memberName: 'added', profileId: members[0].profile, apiKey: key.key }
        );
        const added: Member = {
          ...members[0],
          name: 'added',
          key: key.key,
          keyId: key.id,
          ref: binding.gatewayUsageRef,
        };
        members.push(added);
        await invoke('teams', 'addMember', team, {
          name: 'added',
          providerId: 'anthropic',
          model: added.model,
        });
        await invoke('teams', 'sendMessage', team, {
          member: 'added',
          text: 'Reply GATEWAY_E2E_OK.',
          from: 'user',
        });
        await poll(
          'added member has own billed request',
          async () => (await usage(added)).requests > 0
        );
      }
      await assertSnapshot(team, members);
    }
    if (name === 'binding-switch') {
      const original = { ...members[0] };
      const replacement = await freshKey(`${team}-replacement`, groupByPlatform.get('anthropic')!);
      permitted.add(replacement.key);
      const bound = await invoke<{ gatewayUsageRef: string }>(
        'gatewayProvider',
        'bindGatewayMember',
        {
          teamName: team,
          memberName: original.name,
          profileId: original.profile,
          apiKey: replacement.key,
        }
      );
      assert.notEqual(bound.gatewayUsageRef, original.ref);
      const before = await usage(original);
      await invoke('teams', 'sendMessage', team, {
        member: original.name,
        text: 'Still running: reply GATEWAY_E2E_OK.',
        from: 'user',
      });
      await poll(
        'live run retains original key',
        async () => (await usage(original)).requests > before.requests
      );
      assert.equal((await usage({ key: replacement.key, model: original.model })).requests, 0);
      await invoke('teams', 'restartMember', team, original.name);
      members[0] = {
        ...original,
        key: replacement.key,
        keyId: replacement.id,
        ref: bound.gatewayUsageRef,
      };
      await invoke('teams', 'sendMessage', team, {
        member: original.name,
        text: 'Next run: reply GATEWAY_E2E_OK.',
        from: 'user',
      });
      await poll('next run uses new key', async () => (await usage(members[0])).requests > 0);
      await invoke('gatewayProvider', 'unbindGatewayMember', {
        teamName: team,
        memberName: original.name,
      });
      let rejected = false;
      try {
        await invoke('gatewayProvider', 'bindGatewayMember', {
          teamName: `${team}-renamed`,
          memberName: 'intruder',
          profileId: original.profile,
          apiKey: original.key,
        });
      } catch {
        rejected = true;
      }
      assert(rejected, 'Historical key owner cannot be stolen after unbind/rename');
      const snapshot = await invoke<TokenUsageAnalyticsSnapshotDto>(
        'tokenUsage',
        'refreshSnapshot',
        { teamName: team }
      );
      const total = (await usage(original)).actual_cost + (await usage(members[0])).actual_cost;
      const row = snapshot.byAgent.find((item) => item.agentName === original.name);
      assert(
        row && Math.abs(row.summary.billableCostUsd - total) < 1e-8,
        'Re-import preserves historical owner and both source totals'
      );
    }
    assert(
      !routes.some(
        (call) => call.status === 403 && call.credentialHash !== hash('gateway-e2e-invalid-key')
      ),
      'No member used inherited lead credentials'
    );
    const evidence = {
      scenario: name,
      team,
      runId: created.runId,
      members: await Promise.all(
        members.map(async (member) => ({
          name: member.name,
          providerId: member.providerId,
          usageRef: member.ref,
          usage: await usage(member),
        }))
      ),
      firstSnapshot: {
        requestCount: firstSnapshot.summary.requestCount,
        gatewaySourceCount: firstSnapshot.gatewaySourceCount,
      },
    };
    results.push(evidence);
    await json(path.join(dirs.evidence, `${name}.json`), evidence);
    await invoke('teams', 'stop', team);
    for (const member of members)
      await invoke('gatewayProvider', 'unbindGatewayMember', {
        teamName: team,
        memberName: member.name,
      });
    console.log(`PASS ${name}: real desktop runtimes, fresh per-key usage, exact app attribution`);
  }
  await json(path.join(dirs.evidence, 'result.json'), {
    ok: true,
    results,
    routes,
    upstream: mock.calls,
  });
  await page.screenshot({ path: path.join(dirs.evidence, 'desktop.png'), scale: 'css' });
  console.log(`Gateway desktop E2E passed: ${dirs.evidence}`);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(dirs.evidence, 'failure.png'), scale: 'css' })
      .catch(() => {});
  await json(path.join(dirs.evidence, 'result.json'), {
    ok: false,
    error: redact(String(error)),
    results,
    routes,
    upstream: mock?.calls,
  });
  console.error(`Gateway E2E failed: ${redact(String(error))}; evidence ${dirs.evidence}`);
  process.exitCode = 1;
} finally {
  if (page)
    for (const team of teams) {
      await invoke('teams', 'stop', team).catch(() => {});
      await invoke('teams', 'deleteTeam', team).catch(() => {});
    }
  await browser?.close().catch(() => {});
  if (app?.pid) {
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
  }
  for (const proxy of proxies) {
    proxy.closeAllConnections();
    proxy.close();
  }
  await mock?.close();
  // Only entities allocated by this run; existing stage0 fixtures are preserved.
  for (const id of keys) await api('DELETE', `/api/v1/keys/${id}`).catch(() => {});
  for (const id of accounts) await api('DELETE', `/api/v1/admin/accounts/${id}`).catch(() => {});
  for (const id of groups) await api('DELETE', `/api/v1/admin/groups/${id}`).catch(() => {});
  await writeFile(path.join(dirs.evidence, 'app.log'), redact(logs.join('')), { mode: 0o600 });
}
