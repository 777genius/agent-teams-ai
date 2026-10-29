import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import NativePlugin from '../dist/adapters/providers/OpenCodeMcpPolicyPlugin.js';
import { createOpenCodeMemberProvider } from '../dist/adapters/providers/OpenCodeMemberProvider.js';
import {
  exactOpenCodeMcpPolicy,
  exactOpenCodeMcpStatus,
  openCodeMcpServers,
  verifyOpenCodeMcpPolicyPlugin,
} from '../dist/adapters/providers/openCodeMcpPolicy.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import type { OpenCodeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { CapturedProcessPort } from '../dist/adapters/providers/CapturedProcess.js';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
async function pluginFor(environment: Record<string, string>) {
  const keys = [
    'OPENCODE_CONFIG_CONTENT',
    'LEGACY_AGENT_HOST_MCP_POLICY_NONCE',
    'LEGACY_AGENT_HOST_MCP_TEAM_SERVER',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let pending: ReturnType<typeof NativePlugin>;
  try {
    for (const key of keys) process.env[key] = environment[key];
    pending = NativePlugin(undefined);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
  return pending;
}
class ControlledChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [
    this.stdin,
    this.stdout,
    this.stderr,
    undefined,
    undefined,
  ];
}
function fixture(t: { after(callback: () => void): void }, options: { skipPlugin?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-opencode-mcp-policy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginPath = join(root, 'OpenCodeMcpPolicyPlugin.js');
  const bytes = readFileSync(
    fileURLToPath(
      new URL('../dist/adapters/providers/OpenCodeMcpPolicyPlugin.js', import.meta.url)
    )
  );
  writeFileSync(pluginPath, bytes);
  const profile: OpenCodeMemberProfile = {
    provider: 'opencode',
    protocolRevision: '1.19.4',
    endpoint: 'http://127.0.0.1:14321',
    teamId: 'TEST-team',
    memberId: 'worker',
    principalId: 'TEST-agent',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    cwd: '/TEST-workspace',
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    environment: {
      HOME: '/TEST-home',
      XDG_CONFIG_HOME: '/TEST-config',
      XDG_DATA_HOME: '/TEST-data',
      XDG_CACHE_HOME: '/TEST-cache',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: ['TEST-existing-plugin'],
        instructions: ['TEST-existing-instructions'],
        mcp: {
          inlineForeign: { type: 'remote', url: 'https://example.invalid/foreign', enabled: true },
        },
        agent: { build: { prompt: 'TEST-user-prompt' } },
      }),
    },
    executable: { path: '/TEST-opencode', sha256: 'a'.repeat(64) },
    nativeOptions: { providerId: 'TEST-provider', agent: 'build' },
    capturedMcpServers: {},
    mcpPolicyPlugin: { path: pluginPath, sha256: createHash('sha256').update(bytes).digest('hex') },
    limits: {
      queuedInputs: 2,
      inputBytes: 4096,
      outputBytes: 65536,
      outputEvents: 256,
      pendingInteractions: 4,
      timeoutMs: 150,
    },
  };
  let captured: OpenCodeMemberProfile | undefined;
  let running = false,
    served = false,
    extraStatus = false,
    allocations = 0;
  const writes: string[] = [];
  const child = new ControlledChild();
  const context: MemberProviderContext = {
    profile,
    request: {
      tenantId: 'TEST-tenant',
      projectId: 'TEST-project',
      sessionId: profile.sessionId,
      generation: 1,
      configRevision: profile.configRevision,
      requiredCapabilities: ['text', 'tools'],
    },
    endpoint: {
      url: 'http://127.0.0.1:12345/TEST-team',
      bearerToken: 'TEST-team-token',
      binding: {
        backendId: 'TEST-owner',
        teamId: 'TEST-team',
        teamName: 'test-team',
        runId: 'TEST-run',
        memberId: 'worker',
        generation: '1',
      },
      getCatalogReceipt() {
        return served
          ? {
              binding: this.binding,
              toolNames: createTeamMcpTools(context.connection)
                .list()
                .map((tool) => tool.name),
              sequence: 1,
              servedAtMs: Date.now(),
            }
          : undefined;
      },
      revoke() {},
      async close() {},
    },
    connection: {
      execute() {
        throw new Error('TEST unexpected Team mutation');
      },
      lookup: () => undefined,
      getTask() {
        throw new Error('TEST unexpected Task read');
      },
      listTasks: () => [],
    },
    instructions: 'TEST-captured-instructions',
    isCurrent: () => true,
    canAllocate: () => true,
    async readCheckpoint() {
      throw new Error('TEST no checkpoint');
    },
    onProgress() {},
  };
  const custody: CapturedProcessPort = {
    launch() {
      allocations++;
      running = true;
      return child;
    },
    seal() {},
    isRunning: () => running,
    async confirmStopped() {
      running = false;
      child.stdin.end();
      child.stdout.end();
      child.stderr.end();
      return true;
    },
  };
  const provider = createOpenCodeMemberProvider(context, {
    createProcess(selected) {
      captured = selected;
      return custody;
    },
    async fetchImpl(input, init) {
      const request = new Request(input, init),
        url = new URL(request.url);
      const config = row(JSON.parse(captured!.environment.OPENCODE_CONFIG_CONTENT!));
      const effective = structuredClone(config);
      row(effective).mcp = {
        remoteUnselected: { type: 'remote', url: 'https://example.invalid/remote', enabled: true },
        ...row(config.mcp),
      };
      if (!options.skipPlugin) await (await pluginFor(captured!.environment)).config(effective);
      if (request.method === 'POST') {
        writes.push(url.pathname);
        if (url.pathname === '/session')
          return Response.json({
            id: 'ses_TESTowned',
            directory: profile.cwd,
            version: profile.protocolRevision,
          });
        throw new Error('TEST unexpected native mutation');
      }
      if (url.pathname === '/config') return Response.json(effective);
      if (url.pathname === '/agent') return Response.json([{ name: 'build', mode: 'primary' }]);
      if (url.pathname === '/config/providers')
        return Response.json({
          providers: [{ id: 'TEST-provider', models: { 'TEST-model': {} } }],
        });
      if (url.pathname === '/mcp') {
        served = true;
        return Response.json({
          ...Object.fromEntries(
            Object.keys(row(config.mcp)).map((name) => [name, { status: 'connected' }])
          ),
          ...(extraStatus ? { lateForeign: { status: 'connected' } } : {}),
        });
      }
      if (url.pathname === '/session/ses_TESTowned')
        return Response.json({
          id: 'ses_TESTowned',
          directory: profile.cwd,
          version: profile.protocolRevision,
        });
      if (url.pathname === '/session/status') return Response.json({});
      if (url.pathname.endsWith('/message')) return Response.json([]);
      throw new Error(`TEST unexpected query ${url.pathname}`);
    },
  });
  return {
    root,
    profile,
    context,
    provider,
    writes,
    pluginPath,
    get captured() {
      return captured!;
    },
    get allocations() {
      return allocations;
    },
    addForeign() {
      extraStatus = true;
    },
  };
}

test('actual native hook replaces only MCP after merged source config and proves a fresh private nonce', async () => {
  const selected = {
    team: {
      type: 'remote',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'TEST-private-team-token' },
      enabled: true,
    },
  };
  const nonce = 'a'.repeat(64);
  const config: Record<string, unknown> = {
    instructions: ['TEST-user-instructions'],
    plugin: ['TEST-user-plugin'],
    skills: { paths: ['TEST-skills'] },
    mcp: { unselected: { type: 'remote', url: 'https://example.invalid' } },
  };
  const before = structuredClone(config);
  const hook = await pluginFor({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: selected }),
    LEGACY_AGENT_HOST_MCP_POLICY_NONCE: nonce,
    LEGACY_AGENT_HOST_MCP_TEAM_SERVER: 'team',
  });
  await hook.config(config);
  assert.deepEqual(Object.keys(row(config.mcp)), ['team']);
  assert.equal(row(row(row(config.mcp).team).headers)['X-Legacy-Mcp-Policy'], nonce);
  for (const key of ['instructions', 'plugin', 'skills'])
    assert.deepEqual(config[key], before[key]);
  assert.throws(() => {
    config.mcp = { unselected: {} };
  }, TypeError);
  config.unrelatedLaterSetting = 'TEST-allowed';
  assert.equal(config.unrelatedLaterSetting, 'TEST-allowed');
});

test('OpenCode conversion preserves selected local/remote private config; strict comparison rejects extra servers/statuses', (t) => {
  const f = fixture(t);
  f.profile.capturedMcpServers = {
    docs: {
      type: 'stdio',
      command: 'TEST-docs',
      args: ['TEST-arg'],
      env: { TOKEN: 'TEST-private' },
    },
    web: {
      type: 'sse',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'TEST-header' },
    },
  };
  assert.deepEqual(
    { ...openCodeMcpServers(f.profile) },
    {
      docs: {
        type: 'local',
        command: ['TEST-docs', 'TEST-arg'],
        environment: { TOKEN: 'TEST-private' },
        enabled: true,
      },
      web: {
        type: 'remote',
        url: 'https://example.invalid/mcp',
        headers: { Authorization: 'TEST-header' },
        enabled: true,
      },
    }
  );
  assert.equal(exactOpenCodeMcpPolicy({ team: {}, other: {} }, { team: {} }), false);
  assert.equal(
    exactOpenCodeMcpStatus(
      { team: { status: 'connected' }, other: { status: 'disabled' } },
      { team: {} }
    ),
    false
  );
  assert.equal(exactOpenCodeMcpStatus({ team: { status: 'connected' } }, { team: {} }), true);
});

test('pinned plugin drift refuses before native custody allocation', async (t) => {
  const f = fixture(t);
  writeFileSync(f.pluginPath, '// TEST changed plugin');
  assert.throws(() => verifyOpenCodeMcpPolicyPlugin(f.profile));
  assert.equal(f.allocations, 0);
});

test('swallowed/missing native plugin cannot qualify startup or create a native session', async (t) => {
  const f = fixture(t, { skipPlugin: true });
  await assert.rejects(() => f.provider.factory.open(f.context.request));
  assert.equal(f.provider.isReady(), false);
  assert.deepEqual(f.writes, []);
  await f.provider.cleanup();
});

test('exact hooked policy qualifies; later unexpected connected server blocks original input before native prompt', async (t) => {
  const f = fixture(t);
  const opened = await f.provider.factory.open(f.context.request);
  try {
    assert.equal((await opened.driver.checkReadiness()).ok, true);
    assert.deepEqual(f.writes, ['/session']);
    f.addForeign();
    const result = await opened.driver.submit({
      inputId: 'TEST-input',
      operationRef: 'TEST-operation',
      content: 'TEST never sent',
    });
    assert.deepEqual(result, {
      ok: false,
      code: 'dependency-unavailable',
      delivery: 'known-not-sent',
    });
    assert.deepEqual(f.writes, ['/session']);
    const config = row(JSON.parse(f.captured.environment.OPENCODE_CONFIG_CONTENT!));
    assert.deepEqual(row(config).instructions, ['TEST-existing-instructions']);
    assert.ok(Array.isArray(config.plugin) && config.plugin.includes('TEST-existing-plugin'));
  } finally {
    await opened.driver.close();
    await f.provider.cleanup();
  }
});
