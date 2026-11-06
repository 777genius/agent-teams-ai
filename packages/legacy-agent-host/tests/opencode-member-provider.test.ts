import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import type { MemberProviderContext } from '../src/adapters/providers/MemberProvider.ts';
import type {
  CapturedProcessPort,
  CapturedProcessLaunch,
} from '../src/adapters/providers/CapturedProcess.ts';
import type { OpenCodeMemberProfile } from '../src/composition/runtimeProfile.ts';
import type { Event } from '@agent-teams/provider-session-contracts';

// Source mode permits controlled qualification while root's prior dist proof stays frozen.
const sourceMode = process.env.LEGACY_PROVIDER_SOURCE_TEST === '1';
const {
  createOpenCodeMemberProvider,
}: typeof import('../src/adapters/providers/OpenCodeMemberProvider.ts') = await import(
  sourceMode
    ? '../src/adapters/providers/OpenCodeMemberProvider.ts'
    : '../dist/adapters/providers/OpenCodeMemberProvider.js'
);
const { runtimeProfileSchema }: typeof import('../src/composition/runtimeProfile.ts') =
  await import(
    sourceMode ? '../src/composition/runtimeProfile.ts' : '../dist/composition/runtimeProfile.js'
  );
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
// Pinned OpenCode 1.19.4 ConfigAgentV1 normalization; preserve native key insertion order.
function nativeAgentPermission(agent: Record<string, unknown>): Record<string, unknown> {
  const permission: Record<string, unknown> = {};
  const tools = agent.tools === undefined ? {} : record(agent.tools);
  for (const [tool, enabled] of Object.entries(tools)) {
    assert.equal(typeof enabled, 'boolean');
    const key = ['write', 'edit', 'patch'].includes(tool) ? 'edit' : tool;
    permission[key] = enabled ? 'allow' : 'deny';
  }
  Object.assign(permission, agent.permission);
  return permission;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
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

function fixture(
  options: {
    missingTools?: boolean;
    agentConfiguration?: Record<string, unknown>;
    inheritedAgentTools?: Record<string, boolean>;
    deniedManagedPermission?: boolean;
    missingCatalogReceipt?: boolean;
    foreignCatalogBinding?: boolean;
    disconnectDuringProof?: boolean;
    foreignSession?: boolean;
    failedCreation?: boolean;
    promptMismatch?: boolean;
    checkpoint?: boolean;
    existing?: boolean;
    unknownCleanup?: boolean;
    checkpointValue?: unknown;
    nativeOptions?: Partial<OpenCodeMemberProfile['nativeOptions']>;
    extraArgs?: string[];
    onCreateProcess?(): void;
    nativeLimitsCwd?: string;
    attachments?: MemberProviderContext['attachments'];
  } = {}
) {
  const profile: OpenCodeMemberProfile = {
    provider: 'opencode',
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    protocolRevision: '1.18.35',
    endpoint: 'http://127.0.0.1:14321',
    teamId: 'TEST-team',
    memberId: 'bob',
    principalId: 'bob-session',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    cwd: options.nativeLimitsCwd ?? '/TEST-workspace',
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    environment: {
      HOME: '/TEST-home',
      XDG_CONFIG_HOME: '/TEST-config',
      XDG_DATA_HOME: '/TEST-data',
      XDG_CACHE_HOME: '/TEST-cache',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: ['TEST-plugin'],
        permission: { bash: 'ask' },
        agent: {
          build: {
            prompt: 'TEST preserved prompt',
            permission: { bash: 'ask', read: 'allow' },
            temperature: 0.4,
            ...options.agentConfiguration,
          },
        },
      }),
    },
    executable: { path: '/TEST-opencode', sha256: 'a'.repeat(64) },
    ...(options.existing ? { nativeSessionId: 'ses_TESTowned' } : {}),
    nativeOptions: {
      providerId: 'TEST-provider',
      agent: 'build',
      variant: 'TEST-variant',
      instructions: 'TEST appended context',
      ...options.nativeOptions,
    },
    limits: {
      queuedInputs: 2,
      inputBytes: 4096,
      outputBytes: options.nativeLimitsCwd ? 1_000_000 : 65536,
      outputEvents: 256,
      pendingInteractions: 4,
      timeoutMs: options.nativeLimitsCwd ? 45_000 : 150,
    },
  };
  let current = true,
    allocate = true,
    sealed = false,
    running = false,
    cleanup = 0;
  const launches: CapturedProcessLaunch[] = [];
  let captured: OpenCodeMemberProfile | undefined;
  const child = new ControlledChild();
  const reads: string[] = [];
  const order: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[] = [];
  let nativeProviders: unknown[] = [{ id: 'TEST-provider', models: { 'TEST-model': {} } }];
  let beforeCatalogReply = () => {};
  let catalogNames: string[] | undefined;
  let mcpReads = 0;
  let disconnected = false;
  const context: MemberProviderContext = {
    profile,
    request: {
      tenantId: 'TEST-tenant',
      projectId: 'TEST-project',
      sessionId: profile.sessionId,
      generation: 1,
      configRevision: profile.configRevision,
      requiredCapabilities: ['text', 'tools'],
      ...(options.checkpoint ? { checkpointRef: 'TEST-checkpoint' } : {}),
    },
    endpoint: {
      url: 'http://127.0.0.1:12345/TEST-capability',
      bearerToken: 'TEST-private-token',
      binding: {
        backendId: 'TEST-owner',
        teamId: 'TEST-team',
        teamName: 'test-team',
        runId: 'TEST-run',
        memberId: 'bob',
        generation: '1',
      },
      getCatalogReceipt() {
        if (!catalogNames || options.missingCatalogReceipt || disconnected) return undefined;
        return {
          binding: {
            ...context.endpoint.binding,
            ...(options.foreignCatalogBinding ? { generation: 'TEST-stale' } : {}),
          },
          toolNames: options.missingTools ? catalogNames.slice(1) : [...catalogNames],
          sequence: 1,
          servedAtMs: Date.now(),
        };
      },
      revoke() {},
      async close() {},
    },
    connection: {
      execute() {
        throw new Error('Not called');
      },
      lookup: () => undefined,
      getTask() {
        throw new Error('Not called');
      },
      listTasks: () => [],
    },
    ...(options.attachments ? { attachments: options.attachments } : {}),
    instructions: 'TEST fixed role/team/cwd',
    isCurrent: () => current,
    canAllocate: () => allocate,
    readCheckpoint: async () => {
      order.push('checkpoint-read');
      return options.checkpointValue;
    },
    onProgress() {},
  };
  const custody: CapturedProcessPort = {
    launch(request) {
      assert.ok(allocate && !sealed);
      order.push('launch');
      launches.push(request);
      running = true;
      return child;
    },
    seal() {
      sealed = true;
    },
    isRunning: () => running,
    async confirmStopped() {
      cleanup++;
      running = false;
      sealed = true;
      child.stdin.end();
      child.stdout.end();
      child.stderr.end();
      return !options.unknownCleanup;
    },
  };
  let time = Date.now();
  const provider = createOpenCodeMemberProvider(context, {
    createProcess(selected) {
      options.onCreateProcess?.();
      captured = selected;
      return custody;
    },
    async fetchImpl(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === 'GET') reads.push(url.pathname);
      assert.equal(url.origin, profile.endpoint);
      assert.equal(request.headers.get('x-opencode-directory'), profile.cwd);
      assert.equal(
        request.headers.get('authorization'),
        'Basic ' +
          Buffer.from(`opencode:${captured!.environment.OPENCODE_SERVER_PASSWORD}`).toString(
            'base64'
          )
      );
      const nativeConfig = record(
        JSON.parse(captured!.environment.OPENCODE_CONFIG_CONTENT!) as unknown
      );
      const server = Object.keys(record(nativeConfig.mcp))[0]!;
      const required = Object.keys(
        record(record(record(nativeConfig.agent).build).permission)
      ).filter((name) => name.startsWith(server + '_'));
      let body: unknown;
      if (request.method === 'POST') {
        const payload = record(await request.json());
        writes.push({ path: url.pathname, body: payload });
        if (url.pathname === '/session') {
          if (options.failedCreation)
            return Response.json({ error: 'TEST uncertain creation' }, { status: 500 });
          body = { id: 'ses_TESTowned', directory: profile.cwd, version: profile.protocolRevision };
        } else if (url.pathname.endsWith('/prompt_async')) {
          const id = String(payload.messageID),
            text = String(record((payload.parts as unknown[])[0]).text);
          const assistant = 'msg_' + id.slice(4, 16) + 'T'.repeat(14);
          const number = messages.length;
          messages.push({
            info: { id, role: 'user', sessionID: 'ses_TESTowned', time: { created: time++ } },
            parts: [
              {
                id: `prt_user${number}`,
                sessionID: 'ses_TESTowned',
                messageID: id,
                type: 'text',
                text,
              },
            ],
          });
          messages.push({
            info: {
              id: assistant,
              parentID: id,
              role: 'assistant',
              sessionID: 'ses_TESTowned',
              providerID: 'TEST-provider',
              modelID: 'TEST-model',
              finish: 'stop',
              time: { created: time++, completed: time++ },
            },
            parts: [
              {
                id: `prt_text${number}`,
                sessionID: 'ses_TESTowned',
                messageID: assistant,
                type: 'text',
                text: `TEST reply ${messages.length}`,
              },
              {
                id: `prt_tool${number}`,
                sessionID: 'ses_TESTowned',
                messageID: assistant,
                type: 'tool',
                callID: `TEST-tool-${messages.length}`,
                tool: 'bash',
                state: {
                  status: 'completed',
                  input: { command: 'TEST only' },
                  output: 'TEST partial effect',
                  metadata: { exit: 7 },
                  time: { start: time - 1, end: time },
                },
              },
            ],
          });
          return new Response(null, { status: 204 });
        } else if (url.pathname.endsWith('/abort')) body = true;
        else throw new Error('Unexpected TEST mutation');
      } else if (url.pathname === '/config') {
        body = structuredClone(nativeConfig);
        const agent = record(record(record(body).agent).build);
        agent.permission = nativeAgentPermission({
          ...agent,
          tools: {
            ...options.inheritedAgentTools,
            ...(agent.tools === undefined ? {} : record(agent.tools)),
          },
        });
        if (options.deniedManagedPermission) record(agent.permission).team_task_get = 'deny';
        if (options.promptMismatch)
          record(record(record(body).agent).build).prompt = 'TEST foreign context';
      } else if (url.pathname === '/agent') body = [{ name: 'build', mode: 'primary' }];
      else if (url.pathname === '/config/providers') {
        body = { providers: structuredClone(nativeProviders) };
        beforeCatalogReply();
      } else if (url.pathname === '/mcp') {
        mcpReads++;
        // Controlled native boundary: connected follows the owner's served tools/list catalog.
        // Real authenticated HTTP-finish receipt semantics are covered by endpoint tests.
        catalogNames = required.map((name) => name.slice(server.length + 1));
        body = {
          [server]: {
            status:
              disconnected || (options.disconnectDuringProof && mcpReads > 1)
                ? 'failed'
                : 'connected',
          },
        };
      } else if (url.pathname === '/experimental/tool') {
        // Pinned native route returns builtin/custom tools, never MCP tool IDs.
        body = ['bash', 'read'].map((id) => ({
          id,
          parameters: {},
        }));
      } else if (url.pathname === '/session/ses_TESTowned')
        body = {
          id: 'ses_TESTowned',
          directory: options.foreignSession ? '/TEST-other-workspace' : profile.cwd,
          version: profile.protocolRevision,
        };
      else if (url.pathname === '/session/ses_TESTowned/message') body = messages;
      else if (url.pathname === '/session/status') body = { ses_TESTowned: { type: 'idle' } };
      else if (url.pathname === '/permission' || url.pathname === '/question') body = [];
      else throw new Error('Unexpected TEST read ' + url.pathname);
      return Response.json(body);
    },
  });
  return {
    profile,
    context,
    provider,
    launches,
    writes,
    reads,
    order,
    captured: () => captured!,
    messages,
    revoke: () => {
      current = false;
    },
    forbid: () => {
      allocate = false;
    },
    cleanup: () => cleanup,
    running: () => running,
    setNativeProviders: (providers: unknown[]) => {
      nativeProviders = providers;
    },
    beforeCatalogReply: (callback: () => void) => {
      beforeCatalogReply = callback;
    },
    disconnect: () => {
      disconnected = true;
    },
  };
}

test('OpenCode profile is finite, captures namespaces, bounds input and rejects unqualified V2', () => {
  const f = fixture();
  assert.ok(runtimeProfileSchema.safeParse({ members: [f.profile] }).success);
  for (const changed of [
    { protocolRevision: '2.0.21' },
    { endpoint: 'http://localhost:1' },
    { environment: { HOME: '/TEST' } },
    { limits: { ...f.profile.limits, inputBytes: 300_000 } },
  ])
    assert.equal(
      runtimeProfileSchema.safeParse({ members: [{ ...f.profile, ...changed }] }).success,
      false
    );
  assert.equal(f.launches.length, 0);
});

test(
  'public V1 D composes exact native config/tools/session and two sequential attributed inputs',
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const opened = await f.provider.factory.open(f.context.request);
    const events: Event[] = [];
    const observing = (async () => {
      for await (const event of opened.driver.observe()) events.push(event);
    })();
    try {
      assert.deepEqual(opened.capabilities, [
        'text',
        'tools',
        'permission',
        'interrupt',
        'checkpoint',
      ]);
      assert.ok((await opened.driver.checkReadiness()).ok);
      assert.ok(f.provider.isReady());
      assert.equal(f.reads.includes('/experimental/tool'), false);
      assert.deepEqual(f.provider.initialContextEvidence?.(), {
        kind: 'native-configuration',
        contextDigest: createHash('sha256').update(f.context.instructions, 'utf8').digest('hex'),
        generation: f.context.endpoint.binding.generation,
        configRevision: f.profile.configRevision,
      });
      assert.equal(f.launches.length, 1);
      assert.deepEqual(f.launches[0]!.args, [
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '14321',
      ]);
      const config = record(
        JSON.parse(f.captured().environment.OPENCODE_CONFIG_CONTENT!) as unknown
      );
      assert.deepEqual(config.plugin, ['TEST-plugin']);
      assert.deepEqual(config.permission, { bash: 'ask' });
      const agent = record(record(config.agent).build);
      assert.equal(
        agent.prompt,
        `${f.context.instructions}\n\nTEST preserved prompt\n\nTEST appended context`
      );
      assert.equal(record(agent.permission).bash, 'ask');
      for (let n = 1; n <= 2; n++) {
        const input = {
          inputId: `TEST-input-${n}`,
          operationRef: `TEST-operation-${n}`,
          content: `TEST content ${n}`,
        };
        assert.ok((await opened.driver.submit(input)).ok);
        for (
          let step = 0;
          step < 1000 &&
          !events.some((event) => event.kind === 'result' && event.inputId === input.inputId);
          step++
        )
          await tick();
        const own = events.filter((event) => event.inputId === input.inputId);
        assert.equal(
          own.filter((event) => event.kind === 'result' && event.outcome === 'succeeded').length,
          1
        );
        assert.ok(own.some((event) => event.kind === 'text'));
        assert.ok(own.some((event) => event.kind === 'tool-result' && event.isError));
        assert.ok(
          own.every(
            (event) =>
              event.operationRef === input.operationRef && event.sessionRef === f.profile.sessionId
          )
        );
      }
      assert.equal(f.writes.filter((item) => item.path.endsWith('/prompt_async')).length, 2);
      assert.equal(f.writes.filter((item) => item.path === '/session').length, 1);
      assert.ok(opened.driver.checkpoint().ok);
      f.revoke();
      assert.equal(f.provider.isReady(), false);
      assert.equal(f.provider.initialContextEvidence?.(), undefined);
      assert.equal((await opened.driver.checkReadiness()).ok, false);
    } finally {
      assert.equal((await opened.driver.close()).cleanup, 'confirmed');
      await observing;
      assert.equal(f.running(), false);
    }
  }
);

for (const scenario of [
  'missingTools',
  'missingCatalogReceipt',
  'foreignCatalogBinding',
  'disconnectDuringProof',
  'foreignSession',
  'failedCreation',
  'promptMismatch',
  'checkpoint',
] as const) {
  test(
    `OpenCode ${scenario} failure cleans up before rejection without repeating session creation`,
    { timeout: 5000 },
    async () => {
      const f = fixture({ [scenario]: true });
      await assert.rejects(
        f.provider.factory.open(f.context.request),
        /OpenCode member unavailable/
      );
      assert.ok(f.cleanup() > 0);
      assert.equal(f.running(), false);
      assert.ok(f.writes.filter((item) => item.path === '/session').length <= 1);
      if (scenario === 'checkpoint')
        assert.equal(f.launches.length, 0, 'opaque checkpoint cannot invent a native session ID');
    }
  );
}

test('OpenCode revoked allocation or seal does not launch and unsupported attachments are explicit', async () => {
  for (const mode of ['authority', 'seal', 'attachments'] as const) {
    const f = fixture();
    if (mode === 'authority') f.forbid();
    else if (mode === 'seal') f.provider.seal();
    else f.context.request = { ...f.context.request, requiredCapabilities: ['attachments'] };
    await assert.rejects(f.provider.factory.open(f.context.request));
    assert.equal(f.launches.length, 0);
  }
});

test('OpenCode unknown custody never becomes confirmed', async () => {
  const f = fixture({ unknownCleanup: true });
  assert.equal(f.provider.initialContextEvidence?.(), undefined);
  const { driver } = await f.provider.factory.open(f.context.request);
  assert.ok((await driver.checkReadiness()).ok);
  assert.equal(f.writes.filter((item) => item.path === '/session').length, 1);
  const receipt = await driver.close();
  assert.equal(receipt.cleanup, 'unknown');
  assert.equal(await f.provider.cleanup(), false);
});

test('OpenCode catalog loss invalidates readiness and initial context evidence', async () => {
  const f = fixture();
  const { driver } = await f.provider.factory.open(f.context.request);
  try {
    assert.ok((await driver.checkReadiness()).ok);
    assert.ok(f.provider.initialContextEvidence?.());
    f.disconnect();
    assert.equal((await driver.checkReadiness()).ok, false);
    assert.equal(f.provider.isReady(), false);
    assert.equal(f.provider.initialContextEvidence?.(), undefined);
    assert.equal(
      f.writes.some((item) => item.path.endsWith('/prompt_async')),
      false
    );
  } finally {
    await driver.close();
  }
});

test('OpenCode selected native output/deadline limits qualify with controlled transport', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-opencode-selected-limits-')));
  const f = fixture({ nativeLimitsCwd: cwd });
  try {
    const { driver } = await f.provider.factory.open(f.context.request);
    try {
      assert.ok((await driver.checkReadiness()).ok);
      assert.equal(f.launches[0]!.cwd, cwd);
      assert.equal(f.writes.filter((item) => item.path === '/session').length, 1);
      assert.equal(f.reads.includes('/experimental/tool'), false);
    } finally {
      assert.equal((await driver.close()).cleanup, 'confirmed');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('OpenCode native locator does not authorize fresh history adoption, or allocation before checkpoint proof', async () => {
  for (const checkpoint of [false, true]) {
    const f = fixture({ existing: true, checkpoint });
    await assert.rejects(f.provider.factory.open(f.context.request));
    assert.equal(f.launches.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(
      f.reads.length,
      0,
      'native locator cannot trigger native history reads before restore proof'
    );
    assert.equal(f.messages.length, 0);
  }
});

test('OpenCode public D validates selected checkpoint before restore allocates native resources', async () => {
  const original = fixture();
  const first = await original.provider.factory.open(original.context.request);
  const checkpoint = first.driver.checkpoint();
  assert.ok(checkpoint.ok);
  await first.driver.close();
  const restored = fixture({ existing: true, checkpoint: true, checkpointValue: checkpoint.value });
  const next = await restored.provider.factory.open(restored.context.request);
  try {
    assert.deepEqual(
      restored.order.slice(0, 3),
      ['checkpoint-read', 'checkpoint-read', 'launch'],
      'selected identity and full native compatibility are both validated before allocation'
    );
    assert.equal(restored.writes.filter((item) => item.path === '/session').length, 0);
    assert.ok((await next.driver.checkReadiness()).ok);
  } finally {
    await next.driver.close();
  }
});

for (const mode of ['manual', 'auto'] as const)
  test(`OpenCode ${mode} permission choice and selected variant reach the captured native profile`, async () => {
    const f = fixture({ nativeOptions: { toolApprovalMode: mode, variant: 'high' } });
    const opened = await f.provider.factory.open(f.context.request);
    const events: Event[] = [];
    const observing = (async () => {
      for await (const event of opened.driver.observe()) events.push(event);
    })();
    try {
      assert.ok((await opened.driver.checkReadiness()).ok);
      const config = record(
        JSON.parse(f.captured().environment.OPENCODE_CONFIG_CONTENT!) as unknown
      );
      const permission = record(record(record(config.agent).build).permission);
      assert.equal(permission['*'], mode === 'manual' ? 'ask' : 'deny');
      assert.equal(permission.bash, mode === 'manual' ? undefined : 'allow');
      assert.equal(permission.read, mode === 'manual' ? undefined : 'allow');
      assert.deepEqual(permission.task, { '*': 'deny' });
      assert.equal(permission.external_directory, 'deny');
      assert.equal(permission.doom_loop, 'deny');
      assert.ok(
        Object.entries(permission).some(
          ([name, decision]) => name.startsWith('team_') && decision === 'allow'
        )
      );
      assert.ok(
        (
          await opened.driver.submit({
            inputId: 'TEST-options',
            operationRef: 'TEST-options-op',
            content: 'TEST input',
          })
        ).ok
      );
      const deadline = Date.now() + 1000;
      while (!f.writes.some((row) => row.path.endsWith('/prompt_async')) && Date.now() < deadline)
        await tick();
      assert.equal(
        f.writes.find((row) => row.path.endsWith('/prompt_async'))!.body.variant,
        'high'
      );
    } finally {
      await opened.driver.close();
      await observing;
      await f.provider.cleanup();
    }
  });

test('captured OpenCode ordered argv reaches selected serve without replacing managed endpoint', async () => {
  const extraArgs = ['--log-level', 'INFO', '--print-logs=false', '--log-level=DEBUG'];
  const f = fixture({ extraArgs });
  extraArgs.splice(0, extraArgs.length, '--port', '9999');
  const opened = await f.provider.factory.open(f.context.request);
  try {
    assert.deepEqual(f.launches[0]!.args, [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '14321',
      '--log-level',
      'INFO',
      '--print-logs=false',
      '--log-level=DEBUG',
    ]);
    assert.equal(f.launches[0]!.command, '/TEST-opencode');
    assert.equal(f.launches[0]!.cwd, '/TEST-workspace');
    assert.ok((await opened.driver.checkReadiness()).ok);
  } finally {
    await opened.driver.close();
    await f.provider.cleanup();
  }
});

test('captured OpenCode endpoint and root overrides refuse before custody allocation', () => {
  let created = 0;
  for (const extraArgs of [
    ['--port=9999'],
    ['--hostname', 'FOREIGN'],
    ['--agent', 'FOREIGN'],
    ['run'],
    ['--'],
  ])
    assert.throws(() =>
      fixture({
        extraArgs,
        onCreateProcess: () => {
          created++;
        },
      })
    );
  assert.equal(created, 0);
});

test('captured native agent emits ordered permissions without deprecated managed tool seeds', () => {
  const f = fixture({
    agentConfiguration: {
      tools: { read: false, team_task_get: false },
      permission: { team_task_get: 'deny', '*': 'deny', test_selected_test_echo: 'allow' },
    },
  });
  const config = record(JSON.parse(f.captured().environment.OPENCODE_CONFIG_CONTENT!) as unknown);
  const agent = record(record(config.agent).build);
  const permission = record(agent.permission);
  const keys = Object.keys(permission);
  const managed = keys.filter((name) => name.startsWith('team_'));
  assert.ok(managed.includes('team_task_get') && managed.includes('team_task_start'));
  const nativePermission = nativeAgentPermission(agent);
  for (const name of managed) {
    const last = Object.entries(nativePermission).findLast(([key]) => key === '*' || key === name);
    assert.equal(last?.[1], 'allow', name + ' survives native wildcard normalization');
    assert.equal(permission[name], 'allow');
    assert.ok(keys.indexOf(name) > keys.indexOf('*'));
  }
  assert.equal(permission.read, 'deny');
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.test_selected_test_echo, 'allow');
  assert.equal(agent.tools, undefined);
  assert.equal(f.launches.length, 0);
});

for (const defect of ['inherited-managed-tools', 'native-managed-deny'] as const)
  test(`effective GET/config ${defect} refuses before native input despite raw managed allow`, async () => {
    const f = fixture({
      agentConfiguration: { permission: { '*': 'deny', read: 'allow' } },
      ...(defect === 'inherited-managed-tools'
        ? { inheritedAgentTools: { team_task_get: true } }
        : { deniedManagedPermission: true }),
    });
    await assert.rejects(f.provider.factory.open(f.context.request));
    assert.equal(
      f.writes.some((write) => write.path.endsWith('/prompt_async')),
      false
    );
    assert.equal(f.cleanup(), 1);
    assert.equal(f.running(), false);
  });

test('native media uses the exact current OpenCode declaration before submit without model-name inference', async (t) => {
  const bytes = Buffer.from('TEST image bytes');
  const reference = {
    artifactId: 'TEST-image',
    mimeType: 'image/png',
    byteLength: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  const supported = {
    id: 'TEST-provider',
    models: { 'TEST-model': { capabilities: { input: ['text', 'image'] } } },
  };
  for (const scenario of [
    'image',
    'video',
    'video-only-reject-image',
    'image-only-reject-video',
    'unknown',
    'none',
    'malformed',
    'foreign-provider',
    'foreign-model',
    'duplicate-provider',
    'changed-during-proof',
    'changed-at-native-readiness',
    'revoked',
  ] as const) {
    let resolves = 0;
    const video = scenario === 'video' || scenario === 'image-only-reject-video';
    const selectedReference = { ...reference, mimeType: video ? 'video/mp4' : 'image/png' };
    const f = fixture({
      attachments: {
        model: 'TEST-provider/TEST-model',
        revision: 'TEST-transport-ceiling',
        mimeTypes: ['image/png', 'video/mp4'],
        async resolve(binding) {
          resolves++;
          return { binding, bytes };
        },
      },
    });
    t.after(() => f.provider.cleanup());
    f.setNativeProviders([supported]);
    const opened = await f.provider.factory.open(f.context.request);
    try {
      if (scenario === 'video' || scenario === 'video-only-reject-image')
        f.setNativeProviders([
          { id: 'TEST-provider', models: { 'TEST-model': { capabilities: { input: ['video'] } } } },
        ]);
      else if (scenario === 'duplicate-provider') f.setNativeProviders([supported, supported]);
      else if (scenario === 'unknown')
        f.setNativeProviders([{ id: 'TEST-provider', models: { 'TEST-model': {} } }]);
      else if (scenario === 'none')
        f.setNativeProviders([
          { id: 'TEST-provider', models: { 'TEST-model': { capabilities: { input: [] } } } },
        ]);
      else if (scenario === 'malformed')
        f.setNativeProviders([
          {
            id: 'TEST-provider',
            models: { 'TEST-model': { capabilities: { input: ['image', null] } } },
          },
        ]);
      else if (scenario === 'foreign-provider')
        f.setNativeProviders([{ ...supported, id: 'FOREIGN-provider' }]);
      else if (scenario === 'foreign-model')
        f.setNativeProviders([
          { id: 'TEST-provider', models: { 'foreign-model': supported.models['TEST-model'] } },
        ]);
      else if (scenario === 'changed-during-proof')
        f.beforeCatalogReply(() => {
          f.setNativeProviders([
            {
              id: 'TEST-provider',
              models: { 'TEST-model': { capabilities: { input: ['text'] } } },
            },
          ]);
        });
      else if (scenario === 'changed-at-native-readiness') {
        let replies = 0;
        f.beforeCatalogReply(() => {
          if (++replies === 2)
            f.setNativeProviders([
              { id: 'TEST-provider', models: { 'TEST-model': { capabilities: { input: [] } } } },
            ]);
        });
      } else if (scenario === 'revoked') f.beforeCatalogReply(() => f.revoke());
      const reply = await opened.driver.submit({
        inputId: 'TEST-media',
        operationRef: 'TEST-media-operation',
        content: 'Inspect this image',
        attachments: [selectedReference],
      });
      if (scenario === 'image' || scenario === 'video') {
        assert.equal(reply.ok, true);
        const posts = f.writes.filter((value) => value.path.endsWith('/prompt_async'));
        assert.equal(posts.length, 1);
        assert.deepEqual((posts[0]!.body.parts as Record<string, unknown>[])[1], {
          type: 'file',
          mime: selectedReference.mimeType,
          url: 'data:' + selectedReference.mimeType + ';base64,' + bytes.toString('base64'),
          filename: reference.artifactId,
        });
        assert.equal(resolves, 1);
      } else {
        assert.deepEqual(
          reply,
          { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' },
          scenario
        );
        assert.equal(
          f.writes.some((value) => value.path.endsWith('/prompt_async')),
          false,
          scenario
        );
        assert.equal(resolves, 0, scenario);
      }
      assert.equal(f.launches.length, 1, 'catalog reads reuse the original server');
    } finally {
      await opened.driver.close();
    }
  }
});
