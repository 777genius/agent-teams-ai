import { codexMcpPolicy } from '../dist/adapters/providers/codexMcpPolicy.js';
import type { CodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';

import {
  codexLaunchArguments,
  createCodexMemberProvider,
} from '../dist/adapters/providers/CodexMemberProvider.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { applyLaunchConfiguration } from '../dist/composition/launchConfiguration.js';
import { runtimeProfileSchema } from '../dist/composition/runtimeProfile.js';

import type {
  CapturedProcessLaunch,
  CapturedProcessPort,
} from '../dist/adapters/providers/CapturedProcess.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { CodexMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { Event } from '@agent-teams/provider-session-contracts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** In-memory process streams only. Real public D handles all requests and projections. */
class ControlledChild extends ChildProcess {
  override stdin: Writable;
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: [Writable, PassThrough, PassThrough, undefined, undefined];
  readonly frames: Record<string, unknown>[] = [];
  required: string[] = [];
  mcpConfiguration: Record<string, unknown> | undefined;
  unexpectedMcp = false;
  failInitialize = false;
  turns = 0;
  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        try {
          const frame = record(JSON.parse(chunk.toString()) as unknown);
          this.frames.push(frame);
          if (frame.id === undefined) {
            done();
            return;
          }
          const params = record(frame.params);
          let result: unknown = {};
          if (frame.method === 'initialize' && this.failInitialize) {
            this.stdout.write(
              `${JSON.stringify({ id: frame.id, error: { code: -32000, message: 'TEST-rejection' } })}\n`
            );
            done();
            return;
          }
          if (frame.method === 'config/read')
            result = {
              config: {
                features: { apps: false },
                mcp_servers: this.mcpConfiguration,
              },
            };
          if (frame.method === 'thread/start') result = { thread: { id: 'TEST-thread' } };
          if (frame.method === 'thread/resume') {
            assert.equal(params.threadId, 'TEST-thread');
            result = { thread: { id: 'TEST-thread' } };
          }
          if (frame.method === 'mcpServerStatus/list') {
            assert.equal(params.threadId, 'TEST-thread');
            assert.equal(params.serverName, this.mcpConfiguration ? undefined : 'team');
            result = {
              data: [
                {
                  name: 'team',
                  authStatus: 'bearerToken',
                  runtimeStatus: 'connected',
                  toolsError: null,
                  resources: [],
                  resourceTemplates: [],
                  tools: Object.fromEntries(
                    this.required.map((name) => [name, { name, inputSchema: {} }])
                  ),
                },
              ],
              nextCursor: null,
            };
            if (this.mcpConfiguration) {
              const rows = record(result).data as Record<string, unknown>[];
              for (const [name, value] of Object.entries(this.mcpConfiguration))
                if (name !== 'team')
                  rows.push({
                    name,
                    authStatus: 'unsupported',
                    runtimeStatus: record(value).enabled === false ? 'disabled' : 'connected',
                    toolsError: null,
                    resources: [],
                    resourceTemplates: [],
                    tools: {},
                  });
              if (this.unexpectedMcp)
                rows.push({
                  name: 'TEST-uncaptured',
                  authStatus: 'unsupported',
                  runtimeStatus: 'connected',
                  toolsError: null,
                  resources: [],
                  resourceTemplates: [],
                  tools: {},
                });
            }
          }
          if (frame.method === 'turn/start') {
            const turnId = `TEST-turn-${++this.turns}`;
            result = { turn: { id: turnId } };
            setImmediate(() => {
              const item = {
                id: `TEST-tool-${this.turns}`,
                type: 'commandExecution',
                command: 'TEST-only command',
                cwd: '/TEST-workspace',
                status: 'inProgress',
              };
              this.notify('item/started', {
                threadId: 'TEST-thread',
                turnId,
                item,
              });
              this.notify('item/completed', {
                threadId: 'TEST-thread',
                turnId,
                item: {
                  ...item,
                  status: 'failed',
                  exitCode: 7,
                  aggregatedOutput: 'TEST partial effect',
                },
              });
              this.notify('item/completed', {
                threadId: 'TEST-thread',
                turnId,
                item: {
                  id: `TEST-message-${this.turns}`,
                  type: 'agentMessage',
                  text: `TEST reply ${this.turns}`,
                },
              });
              this.notify('turn/completed', {
                threadId: 'TEST-thread',
                turn: { id: turnId, status: 'completed' },
              });
            });
          }
          this.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error('TEST stream rejected'));
        }
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr, undefined, undefined];
  }
  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
}

function fixture(
  options: {
    extraArgs?: string[];
    onCreateProcess?(): void;
    capturedMcpServers?: CodexMemberProfile['capturedMcpServers'];
    capturedMcpCatalog?: CodexConfiguredMcpCatalog;
    readCatalog?: () => Promise<CodexConfiguredMcpCatalog>;
    nativeOptions?: Partial<CodexMemberProfile['nativeOptions']>;
    missingTools?: boolean;
    failInitialize?: boolean;
    checkpoint?: boolean;
    checkpointData?: unknown;
    endpointUrl?: string;
    generation?: number;
    previousTurns?: number;
    codexEvidence?: NonNullable<MemberProviderContext['codexEvidence']>;
  } = {}
) {
  const profile: CodexMemberProfile = {
    provider: 'codex',
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    ...(options.capturedMcpServers ? { capturedMcpServers: options.capturedMcpServers } : {}),
    ...(options.capturedMcpCatalog ? { capturedMcpCatalog: options.capturedMcpCatalog } : {}),
    teamId: 'TEST-team',
    memberId: 'bob',
    principalId: 'bob-session',
    sessionId: 'TEST-session',
    generation: options.generation ?? 1,
    configRevision: 'TEST-config',
    protocolRevision: '0.162.0',
    cwd: '/TEST-workspace',
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    environment: {
      HOME: '/TEST-home',
      CODEX_HOME: '/TEST-codex',
      TEST_ENV: 'captured',
    },
    executable: { path: '/TEST-codex-bin', sha256: 'a'.repeat(64) },
    nativeOptions: {
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      modelProvider: 'TEST-provider',
      developerInstructions: 'TEST appended instruction',
      ...options.nativeOptions,
    },
    limits: {
      queuedInputs: 2,
      inputBytes: 4096,
      outputBytes: 65536,
      outputEvents: 256,
      pendingInteractions: 4,
      timeoutMs: 1000,
    },
  };
  let current = true;
  let allocate = true;
  let running = false;
  let sealed = false;
  let cleanupCalls = 0;
  const launches: CapturedProcessLaunch[] = [];
  let captured: CodexMemberProfile | undefined;
  const child = new ControlledChild();
  child.turns = options.previousTurns ?? 0;
  child.failInitialize = !!options.failInitialize;
  const context: MemberProviderContext = {
    profile,
    request: {
      tenantId: 'TEST-tenant',
      projectId: 'TEST-project',
      sessionId: profile.sessionId,
      generation: profile.generation,
      configRevision: profile.configRevision,
      requiredCapabilities: ['text', 'tools'],
      ...(options.checkpoint || options.checkpointData !== undefined
        ? { checkpointRef: 'TEST-checkpoint' }
        : {}),
    },
    endpoint: {
      url: options.endpointUrl ?? 'http://127.0.0.1:12345/TEST-private',
      bearerToken: 'TEST-private-bearer',
      binding: {
        backendId: 'TEST-backend',
        teamId: 'TEST-team',
        teamName: 'test-team',
        runId: 'TEST-run',
        memberId: 'bob',
        generation: String(profile.generation),
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
    instructions: 'TEST captured role/team/cwd',
    ...(options.codexEvidence ? { codexEvidence: options.codexEvidence } : {}),
    isCurrent: () => current,
    canAllocate: () => allocate,
    readCheckpoint: async () => options.checkpointData,
    onProgress() {},
  };
  child.required = options.missingTools
    ? []
    : createTeamMcpTools(context.connection)
        .list()
        .map((tool) => tool.name);
  if (profile.capturedMcpServers !== undefined) {
    const policy = codexMcpPolicy(profile, context.endpoint, child.required)!;
    const rows: Record<string, unknown> = {};
    for (const row of policy.catalog.servers)
      rows[row.name] = {
        ...(row.transport.type === 'stdio'
          ? { command: row.transport.command }
          : { url: row.transport.url }),
        enabled: false,
      };
    // config/read exposes Codex 0.162's serialized defaults after TOML merging.
    for (const [name, value] of Object.entries(policy.selected))
      rows[name] = {
        ...value,
        environment_id: 'local',
        tool_timeout_sec: value.tool_timeout_sec ?? null,
        ...('command' in value ? { args: value.args ?? [] } : {}),
        enabled: true,
      };
    child.mcpConfiguration = rows;
  }
  const custody: CapturedProcessPort = {
    launch(request) {
      assert.ok(!sealed && allocate);
      launches.push(request);
      running = true;
      return child;
    },
    seal() {
      sealed = true;
    },
    isRunning: () => running,
    async confirmStopped() {
      cleanupCalls++;
      sealed = true;
      running = false;
      child.stdin.end();
      child.stdout.end();
      child.stderr.end();
      return true;
    },
  };
  const provider = createCodexMemberProvider(context, {
    ...(options.readCatalog ? { readCatalog: options.readCatalog } : {}),
    createProcess(selected) {
      options.onCreateProcess?.();
      captured = selected;
      return custody;
    },
  });
  return {
    provider,
    context,
    profile,
    child,
    launches,
    captured: () => captured!,
    revoke: () => {
      current = false;
    },
    forbidAllocation: () => {
      allocate = false;
    },
    cleanupCalls: () => cleanupCalls,
    running: () => running,
  };
}

test('Codex profile is a finite private union and requires captured namespace paths', () => {
  const f = fixture();
  assert.ok(runtimeProfileSchema.safeParse({ members: [f.profile] }).success);
  assert.equal(
    runtimeProfileSchema.safeParse({
      members: [{ ...f.profile, nativeTools: [] }],
    }).success,
    false
  );
  assert.equal(
    runtimeProfileSchema.safeParse({
      members: [{ ...f.profile, environment: { HOME: '/TEST' } }],
    }).success,
    false
  );
  assert.equal(
    runtimeProfileSchema.safeParse({
      members: [{ ...f.profile, protocolRevision: 'unknown' }],
    }).success,
    false
  );
});

test('Codex profile enforces native 1 MiB ceiling before allocation and preserves Claude bounds', () => {
  const f = fixture();
  const selected = {
    ...f.profile,
    limits: { ...f.profile.limits, outputBytes: 2_000_000 },
  };
  assert.equal(runtimeProfileSchema.safeParse({ members: [selected] }).success, false);
  assert.equal(
    f.launches.length,
    0,
    'invalid captured configuration must be rejected before a process exists'
  );
  assert.ok(
    runtimeProfileSchema.safeParse({
      members: [
        {
          ...f.profile,
          limits: { ...f.profile.limits, outputBytes: 1_048_576 },
        },
      ],
    }).success
  );
  const { protocolRevision: _revision, nativeOptions: _options, ...common } = selected;
  assert.ok(
    runtimeProfileSchema.safeParse({
      members: [
        {
          ...common,
          provider: 'claude',
          nativeTools: [],
          autoAllowedTools: [],
        },
      ],
    }).success,
    'Claude retains its existing 16 MiB ceiling'
  );
});

test(
  'real public Codex D uses selected config, same-thread tools and two attributed sequential inputs',
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const { driver, capabilities } = await f.provider.factory.open(f.context.request);
    const events: Event[] = [];
    const observing = (async () => {
      for await (const event of driver.observe()) events.push(event);
    })();
    try {
      assert.deepEqual(capabilities, ['text', 'tools']);
      assert.ok((await driver.checkReadiness()).ok);
      assert.equal(f.provider.isReady(), true);
      assert.equal(f.launches.length, 1);
      const launch = f.launches[0]!;
      assert.equal(launch.command, f.profile.executable.path);
      assert.equal(launch.cwd, f.profile.cwd);
      assert.deepEqual(launch.args.slice(-3), ['app-server', '--listen', 'stdio://']);
      const settings = launch.args.filter((_, index) => launch.args[index - 1] === '-c');
      assert.ok(settings.includes('mcp_servers.team.enabled=true'));
      assert.ok(
        settings.includes(`mcp_servers.team.enabled_tools=${JSON.stringify(f.child.required)}`)
      );
      for (const name of f.child.required)
        assert.ok(settings.includes(`mcp_servers.team.tools.${name}.approval_mode="approve"`));
      assert.equal(JSON.stringify(launch).includes(f.context.endpoint.bearerToken), false);
      assert.equal(f.profile.environment.LEGACY_AGENT_HOST_TEAM_MCP_TOKEN, undefined);
      assert.equal(
        f.captured().environment.LEGACY_AGENT_HOST_TEAM_MCP_TOKEN,
        f.context.endpoint.bearerToken
      );
      const thread = record(
        f.child.frames.find((frame) => frame.method === 'thread/start')?.params
      );
      assert.equal(thread.cwd, f.profile.cwd);
      assert.equal(thread.model, f.profile.model);
      assert.equal(thread.approvalPolicy, 'on-request');
      assert.equal(thread.sandbox, 'read-only');
      assert.equal(thread.modelProvider, 'TEST-provider');
      assert.equal(
        thread.developerInstructions,
        `${f.context.instructions}\n\nTEST appended instruction`
      );
      for (let n = 1; n <= 2; n++) {
        const input = {
          inputId: `TEST-input-${n}`,
          operationRef: `TEST-operation-${n}`,
          content: `TEST message ${n}`,
        };
        const receipt = await driver.submit(input);
        assert.ok(receipt.ok);
        for (
          let count = 0;
          count < 100 &&
          !events.some((event) => event.kind === 'result' && event.inputId === input.inputId);
          count++
        )
          await tick();
        assert.equal(
          events.filter((event) => event.kind === 'result' && event.inputId === input.inputId)
            .length,
          1
        );
        assert.ok(
          events.some(
            (event) =>
              event.kind === 'text' &&
              event.inputId === input.inputId &&
              event.text === `TEST reply ${n}`
          )
        );
        assert.ok(
          events.some(
            (event) =>
              event.kind === 'tool' && event.inputId === input.inputId && event.name === 'Bash'
          )
        );
        assert.ok(
          events.some(
            (event) =>
              event.kind === 'tool-result' && event.inputId === input.inputId && event.isError
          )
        );
        assert.ok(
          events
            .filter((event) => event.inputId === input.inputId)
            .every(
              (event) =>
                event.operationRef === input.operationRef &&
                event.sessionRef === f.profile.sessionId
            )
        );
      }
      assert.equal(f.child.turns, 2);
      f.revoke();
      assert.equal(f.provider.isReady(), false);
      assert.equal((await driver.checkReadiness()).ok, false);
    } finally {
      assert.equal((await driver.close()).cleanup, 'confirmed');
      await observing;
      assert.equal(f.running(), false);
    }
  }
);

for (const scenario of ['missingTools', 'failInitialize', 'checkpoint'] as const) {
  test(
    `Codex ${scenario} setup failure cleans captured handles before throwing`,
    { timeout: 5000 },
    async () => {
      const f = fixture({ [scenario]: true });
      await assert.rejects(f.provider.factory.open(f.context.request), /Codex member unavailable/);
      assert.ok(f.cleanupCalls() > 0);
      assert.equal(f.running(), false);
      assert.equal(f.provider.isReady(), false);
    }
  );
}

test('seal or lost allocation authority prevents a Codex process allocation', async () => {
  for (const mode of ['seal', 'authority'] as const) {
    const f = fixture();
    if (mode === 'seal') f.provider.seal();
    else f.forbidAllocation();
    await assert.rejects(f.provider.factory.open(f.context.request));
    assert.equal(f.launches.length, 0);
  }
});

test(
  'Host Codex adapter awaits its captured original-input baseline and terminal observer through real public D',
  { timeout: 5000 },
  async () => {
    let beforeEntered!: () => void, releaseBefore!: () => void;
    let afterEntered!: () => void, releaseAfter!: () => void;
    const beforeReady = new Promise<void>((resolve) => {
      beforeEntered = resolve;
    });
    const beforeGate = new Promise<void>((resolve) => {
      releaseBefore = resolve;
    });
    const afterReady = new Promise<void>((resolve) => {
      afterEntered = resolve;
    });
    const afterGate = new Promise<void>((resolve) => {
      releaseAfter = resolve;
    });
    const requests: Parameters<
      NonNullable<MemberProviderContext['codexEvidence']>['observe']
    >[0][] = [];
    let sealed = false;
    const f = fixture({
      codexEvidence: {
        async observe(request) {
          requests.push(request);
          if (request.phase === 'before') {
            beforeEntered();
            await beforeGate;
          }
          if (request.phase === 'after') {
            afterEntered();
            await afterGate;
          }
        },
        seal() {
          sealed = true;
        },
        readStatus: () => ({
          phase: sealed ? 'sealed' : 'capturing',
          baseline: 'ready',
        }),
      },
    });
    const { driver } = await f.provider.factory.open(f.context.request);
    const events: Event[] = [];
    const observing = (async () => {
      for await (const event of driver.observe()) events.push(event);
    })();
    try {
      const input = {
        inputId: 'TEST-original-input',
        operationRef: 'TEST-original-operation',
        content: 'TEST original',
      };
      const submission = driver.submit(input);
      await beforeReady;
      assert.equal(f.child.turns, 0, 'no native turn/start before the baseline callback settles');
      assert.equal(requests[0]!.inputId, input.inputId);
      assert.equal(requests[0]!.operationRef, input.operationRef);
      assert.equal(requests[0]!.threadId, 'TEST-thread');
      releaseBefore();
      assert.ok((await submission).ok);
      await afterReady;
      assert.equal(
        events.some((event) => event.kind === 'result'),
        false
      );
      assert.equal(requests[1]!.phase, 'after');
      if (requests[1]!.phase !== 'after') throw new Error('Wrong terminal callback');
      assert.equal(requests[1]!.beforeObserved, true);
      assert.equal(requests[1]!.windowRef, requests[0]!.windowRef);
      assert.equal(requests[1]!.turnId, 'TEST-turn-1');
      releaseAfter();
      for (let i = 0; i < 100 && !events.some((event) => event.kind === 'result'); i++)
        await tick();
      assert.equal(events.filter((event) => event.kind === 'result').length, 1);
    } finally {
      releaseBefore();
      releaseAfter();
      await driver.close();
      await observing;
      assert.equal(sealed, true);
      assert.equal(f.running(), false);
    }
  }
);

for (const effort of ['none', 'minimal', 'ultra', 'TEST-future-native-effort'])
  test(`captured Codex options preserve ${effort} across each input and true-only Fast config`, async () => {
    const f = fixture({
      nativeOptions: { reasoningEffort: effort, fastMode: true },
    });
    const opened = await f.provider.factory.open(f.context.request);
    const events: Event[] = [];
    const observing = (async () => {
      for await (const event of opened.driver.observe()) events.push(event);
    })();
    try {
      const args = f.launches[0]!.args;
      assert.ok(args.includes(`model_reasoning_effort=${JSON.stringify(effort)}`));
      assert.ok(args.includes('service_tier="fast"'));
      assert.ok(args.includes('features.fast_mode=true'));
      assert.equal(
        record(f.child.frames.find((frame) => frame.method === 'thread/start')!.params).serviceTier,
        'fast'
      );
      f.profile.nativeOptions.reasoningEffort = 'TEST-later-draft';
      for (let n = 1; n <= 2; n++) {
        assert.ok(
          (
            await opened.driver.submit({
              inputId: `TEST-option-${n}`,
              operationRef: `TEST-option-op-${n}`,
              content: 'TEST input',
            })
          ).ok
        );
        const deadline = Date.now() + 1000;
        while (
          !events.some(
            (event) => event.kind === 'result' && event.inputId === `TEST-option-${n}`
          ) &&
          Date.now() < deadline
        )
          await tick();
        assert.equal(f.child.turns, n);
      }
      for (const turn of f.child.frames.filter((frame) => frame.method === 'turn/start'))
        assert.equal(record(turn.params).effort, effort);
    } finally {
      await opened.driver.close();
      await observing;
      await f.provider.cleanup();
    }
  });

test('Codex Default/absent options preserve the captured recipe; explicit false adds no native Fast override', () => {
  const f = fixture({
    nativeOptions: { reasoningEffort: 'minimal', fastMode: true },
  });
  const unchanged = applyLaunchConfiguration(f.profile, {
    model: f.profile.model,
  });
  assert.equal(unchanged.provider, 'codex');
  if (unchanged.provider !== 'codex') assert.fail('TEST-codex');
  assert.equal(unchanged.nativeOptions.reasoningEffort, 'minimal');
  assert.equal(unchanged.nativeOptions.fastMode, true);
  const selected = applyLaunchConfiguration(f.profile, {
    effort: 'ultra',
    fastMode: false,
  });
  if (selected.provider !== 'codex') assert.fail('TEST-codex');
  assert.equal(selected.nativeOptions.reasoningEffort, 'ultra');
  assert.equal(selected.nativeOptions.fastMode, false);
  const args = codexLaunchArguments({ ...f.context, profile: selected });
  assert.equal(
    args.some((arg) => arg.startsWith('service_tier=') || arg.startsWith('features.fast_mode=')),
    false
  );
  assert.ok(args.includes('model_reasoning_effort="ultra"'));
  const absent = codexLaunchArguments(fixture().context);
  assert.equal(
    absent.some(
      (arg) => arg.startsWith('model_reasoning_effort=') || arg.startsWith('service_tier=')
    ),
    false
  );
  assert.equal(f.profile.nativeOptions.reasoningEffort, 'minimal');
  assert.notEqual(selected.configRevision, f.profile.configRevision);
  assert.deepEqual(selected.environment, f.profile.environment);
  assert.equal(selected.sessionId, f.profile.sessionId);
});

const policyCatalog: CodexConfiguredMcpCatalog = {
  digest: 'c'.repeat(64),
  servers: [
    {
      name: 'TEST-plugin-only',
      enabled: true,
      transport: { type: 'stdio', command: '/TEST/plugin' },
    },
  ],
};
for (const mode of ['appOnly', 'inherited'] as const)
  test(
    `managed Codex ${mode} cold restore keeps its original thread across Host endpoint rotation`,
    { timeout: 5000 },
    async () => {
      const catalog: CodexConfiguredMcpCatalog = {
        ...policyCatalog,
        servers: [
          ...policyCatalog.servers,
          {
            name: 'Docs',
            enabled: true,
            transport: { type: 'streamable_http', url: 'https://example.invalid/Docs' },
          },
        ],
      };
      const selected: NonNullable<CodexMemberProfile['capturedMcpServers']> =
        mode === 'appOnly' ? {} : { Docs: { type: 'http', url: 'https://example.invalid/Docs' } };
      const options = {
        capturedMcpServers: selected,
        capturedMcpCatalog: catalog,
        readCatalog: async () => catalog,
      };
      const original = fixture(options);
      const opened = await original.provider.factory.open(original.context.request);
      let checkpoint: unknown;
      try {
        assert.ok(
          (
            await opened.driver.submit({
              inputId: 'TEST-before-cold',
              operationRef: 'TEST-operation-before-cold',
              content: 'TEST original input',
            })
          ).ok
        );
        for (let count = 0; count < 100; count++) {
          const captured = await opened.driver.checkpoint();
          if (captured.ok) {
            checkpoint = captured.value;
            break;
          }
          await tick();
        }
        assert.ok(checkpoint, 'original completed native thread supplies its own checkpoint');
        assert.equal(original.child.turns, 1);
      } finally {
        assert.equal((await opened.driver.close()).cleanup, 'confirmed');
        await original.provider.cleanup();
      }
      const resumed = fixture({
        ...options,
        endpointUrl: 'http://127.0.0.1:54321/TEST-new-private',
        generation: 2,
        previousTurns: 1,
        checkpointData: checkpoint,
      });
      const restored = await resumed.provider.factory.open(resumed.context.request);
      try {
        assert.ok((await restored.driver.checkReadiness()).ok);
        assert.equal(
          resumed.child.frames.filter((frame) => frame.method === 'thread/resume').length,
          1
        );
        assert.equal(
          resumed.child.frames.some((frame) => frame.method === 'thread/start'),
          false
        );
        assert.equal(
          resumed.child.frames.some((frame) => frame.method === 'turn/start'),
          false
        );
        assert.equal(
          record(resumed.child.mcpConfiguration!.team).url,
          resumed.context.endpoint.url
        );
        assert.ok(
          (
            await restored.driver.submit({
              inputId: 'TEST-after-cold',
              operationRef: 'TEST-operation-after-cold',
              content: 'TEST next original input',
            })
          ).ok
        );
        let continuation: unknown;
        for (let count = 0; count < 100; count++) {
          const captured = await restored.driver.checkpoint();
          if (captured.ok) {
            continuation = captured.value;
            break;
          }
          await tick();
        }
        assert.equal(record(continuation).nativeThreadId, 'TEST-thread');
        assert.equal(resumed.child.turns, 2);
        assert.equal(
          resumed.child.frames.filter((frame) => frame.method === 'turn/start').length,
          1
        );
        assert.equal(
          record(resumed.child.frames.find((frame) => frame.method === 'turn/start')!.params)
            .threadId,
          'TEST-thread'
        );
        assert.equal(resumed.launches.length, 1);
      } finally {
        assert.equal((await restored.driver.close()).cleanup, 'confirmed');
        await resumed.provider.cleanup();
      }
      if (mode === 'inherited') {
        const foreign = fixture({
          ...options,
          capturedMcpServers: { Docs: { type: 'http', url: 'https://example.invalid/changed' } },
          checkpointData: checkpoint,
          generation: 2,
          previousTurns: 1,
        });
        await assert.rejects(
          foreign.provider.factory.open(foreign.context.request),
          /Codex member unavailable/u
        );
        assert.equal(
          foreign.child.frames.length,
          0,
          'changed foreign policy never resumes or starts a thread'
        );
        assert.equal(foreign.running(), false);
        assert.ok(foreign.cleanupCalls() > 0);
      }
    }
  );
test('captured appOnly launches veto original plugin names and exact native gate precedes thread allocation', async () => {
  let reads = 0;
  const f = fixture({
    capturedMcpServers: {},
    capturedMcpCatalog: policyCatalog,
    readCatalog: async () => {
      reads++;
      return policyCatalog;
    },
  });
  const opened = await f.provider.factory.open(f.context.request);
  try {
    assert(reads >= 2);
    const configIndex = f.child.frames.findIndex((frame) => frame.method === 'config/read');
    const threadIndex = f.child.frames.findIndex((frame) => frame.method === 'thread/start');
    assert(configIndex >= 0 && configIndex < threadIndex);
    const args = f.launches[0]!.args;
    assert(args.includes('features.apps=false'));
    const table = args.find((value) => value.startsWith('mcp_servers='));
    assert(table?.includes('"TEST-plugin-only"={"command"="/TEST/plugin","enabled"=false}'));
    assert(table?.includes('"team"='));
    assert((await opened.driver.checkReadiness()).ok);
    f.child.unexpectedMcp = true;
    assert.equal((await opened.driver.checkReadiness()).ok, false);
    assert.equal(f.child.turns, 0);
  } finally {
    await opened.driver.close();
    await f.provider.cleanup();
  }
  const rejected = fixture({
    capturedMcpServers: {},
    capturedMcpCatalog: policyCatalog,
    readCatalog: async () => policyCatalog,
  });
  record(rejected.child.mcpConfiguration!.team).environment_id = 'FOREIGN';
  await assert.rejects(rejected.provider.factory.open(rejected.context.request));
  assert.equal(rejected.launches.length, 1);
  assert.ok(rejected.child.frames.some((frame) => frame.method === 'config/read'));
  assert.equal(
    rejected.child.frames.some((frame) => frame.method === 'thread/start'),
    false
  );
  await rejected.provider.cleanup();
});
test('changed original native census refuses before app-server allocation and without a thread', async () => {
  const f = fixture({
    capturedMcpServers: {},
    capturedMcpCatalog: policyCatalog,
    readCatalog: async () => ({ ...policyCatalog, digest: 'd'.repeat(64) }),
  });
  await assert.rejects(f.provider.factory.open(f.context.request));
  assert.equal(f.launches.length, 0);
  assert.equal(f.child.frames.length, 0);
});
test('new captured selection without original native census refuses before process custody', () => {
  assert.throws(() => fixture({ capturedMcpServers: {} }), /census unavailable/u);
});

test('captured Codex argv reaches only the selected app-server launch, preserving managed flags', async () => {
  const extraArgs = ['--strict-config', '--analytics-default-enabled', '--strict-config'];
  const f = fixture({ extraArgs });
  extraArgs.splice(0, extraArgs.length, '--listen', 'FOREIGN');
  const opened = await f.provider.factory.open(f.context.request);
  try {
    const launch = f.launches[0]!;
    assert.equal(launch.command, '/TEST-codex-bin');
    assert.equal(launch.cwd, '/TEST-workspace');
    assert.deepEqual(launch.args.slice(-6), [
      'app-server',
      '--listen',
      'stdio://',
      '--strict-config',
      '--analytics-default-enabled',
      '--strict-config',
    ]);
    assert.equal(launch.args.includes('FOREIGN'), false);
    assert.equal(launch.args.filter((value) => value === '--listen').length, 1);
    assert.ok((await opened.driver.checkReadiness()).ok);
  } finally {
    await opened.driver.close();
    await f.provider.cleanup();
  }
});

test('captured Codex managed aliases and positional prompts refuse before custody allocation', () => {
  let created = 0;
  for (const extraArgs of [
    ['-c', 'model="FOREIGN"'],
    ['--listen=FOREIGN'],
    ['-C', '/FOREIGN'],
    ['prompt'],
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
