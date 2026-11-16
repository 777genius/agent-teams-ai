/** TEST finite Codex/V1 recipes, original custody observations and real native process actions. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { captureCodexConfiguredMcpCatalog, codexMcpPolicyArgs,
  captureCodexMcpPolicy } from '../../packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/codex.js';
import { startCodexModel, codexToolReceipt, CONTEXT_MARKER as CODEX_CONTEXT,
  type RetainedProcessScenario } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import { startOpenCodeModel, CONTEXT_MARKER as OPENCODE_CONTEXT } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import { nativeToolReceipt } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { PROCESS_BOOTSTRAP, PROCESS_REGISTER_ID, PROCESS_LABEL, PROCESS_NEIGHBOR_REGISTER_ID,
  PROCESS_NEIGHBOR_LABEL, type Service } from '../../scripts/legacy-agent-host/desktop-native-process-model.ts';
import { captureInitialRuntimeModelAdmission } from '../../packages/legacy-agent-host/dist/composition/initialRuntimeModelAdmission.js';
import { teamModelProbeProfile } from '../../packages/legacy-agent-host/dist/composition/teamLaunchModelProbe.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { storedModelProbeSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { decodeLaunch } from '../../packages/legacy-agent-host/dist/owned-process/codec.js';
import { windowsBrokerReference } from '../../packages/legacy-agent-host/dist/owned-process/HostWindowsLaunch.js';
import { windowsLaunchSpec } from '../../packages/legacy-agent-host/dist/adapters/providers/WindowsCapturedProcess.js';
import { canonicalOpenCodeAgentPermission } from '../../packages/legacy-agent-host/dist/adapters/providers/openCodeAgentPolicy.js';
import { capturedQueryableWitness, timeout } from './nativeGateContext';
import type { CapturedHostClient } from '../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { runtimeMemberProfileSchema, type RuntimeMemberProfile } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import type { HostCustodyCall, HostCustodyResult } from '@agent-teams/legacy-agent-host/owned-process';
import type { NativeGateEvents } from './nativeGateEvents';

export type RetainedProvider = 'codex' | 'opencode-v1';
export interface RetainedProviderSelection {
  provider?: RetainedProvider; version: string;
  executable: { path: string; sha256: string }; bash: { path: string; sha256: string };
}
type Witness = Awaited<ReturnType<typeof capturedQueryableWitness>>;
type Allocation = Extract<HostCustodyCall, { operation: 'allocate' }>;
type Root = Extract<HostCustodyResult, { operation: 'prepare' }>['root'];
type Role = 'codex-metadata' | 'codex-census' | 'standalone-management-probe' | 'member';
interface RootRow {
  allocation: Allocation; chunks: Buffer[]; length: number; role?: Role; ordinal?: number;
  root?: Root; witness?: Witness; resumed: boolean; stopped: boolean; drained: boolean; released: boolean;
  receiptRef?: string; specDigest?: string; environmentDigest?: string; absent?: boolean;
}
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const remaining = (deadline: number) => {
  const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, 'One original deadline'); return value;
};
const same = (left: unknown, right: unknown) => assert.deepEqual(left, right);
const memberToken = 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN';

async function reserveEndpoint(port = 0, deadline?: number): Promise<string> {
  const server = createServer(), abort = new AbortController();
  let budget: ReturnType<typeof setTimeout> | undefined;
  try {
    if (deadline !== undefined) budget = setTimeout(() => abort.abort(), remaining(deadline));
    await new Promise<void>((done, reject) => {
      server.once('error', reject); abort.signal.addEventListener('abort', () => reject(new Error('Original endpoint deadline')), { once: true });
      server.listen({ host: '127.0.0.1', port, exclusive: true, signal: abort.signal }, done);
    });
    if (deadline !== undefined) remaining(deadline);
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return 'http://127.0.0.1:' + address.port;
  } finally {
    if (budget !== undefined) clearTimeout(budget);
    if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    abort.abort();
  }
}

/** Decode only the canonical quoting emitted by windowsLaunchSpec, then require its exact inverse. */
function argumentsOf(commandLine: string): string[] {
  const output: string[] = []; let offset = 0;
  while (offset < commandLine.length) {
    assert.equal(commandLine[offset++], '"'); let value = '', closed = false;
    while (offset < commandLine.length) {
      let slashes = 0;
      while (commandLine[offset] === '\\') { slashes++; offset++; }
      if (commandLine[offset] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2)); offset++;
        if (slashes % 2) value += '"'; else { closed = true; break; }
      } else {
        value += '\\'.repeat(slashes); assert.ok(offset < commandLine.length);
        value += commandLine[offset++];
      }
    }
    assert.equal(closed, true); output.push(value);
    if (offset < commandLine.length) assert.equal(commandLine[offset++], ' ');
  }
  assert.ok(output.length > 0 && output.length <= 4096); return output;
}
function inlineTable(encoded: string): Record<string, unknown> {
  let output = '', quoted = false, escaped = false;
  for (const char of encoded) {
    if (!quoted && char === '=') output += ':'; else output += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  assert.equal(quoted, false); return object(JSON.parse(output));
}
function originalReceipt(storageRoot: string, commandId: string) {
  const path = join(storageRoot, 'management-commands', managementDigest(commandId) + '.json');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.ok(before.isFile() && before.size > 0n && before.size <= 65536n);
    const bytes = Buffer.alloc(65537); let length = 0, count = 0;
    do { count = readSync(fd, bytes, length, bytes.length - length, null); length += count; }
    while (count && length < bytes.length);
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
      assert.equal(after[key], before[key]); assert.equal(named[key], before[key]);
    }
    assert.ok(named.isFile() && !named.isSymbolicLink()); assert.equal(BigInt(length), before.size);
    const raw = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
    const { digest, ...body } = raw; assert.equal(digest, managementDigest(body));
    return { record: storedModelProbeSchema.parse(body), sha256: hash(bytes.subarray(0, length)) };
  } finally { closeSync(fd); }
}

export async function prepareRetainedProviderFixture(options: {
  provider: RetainedProvider; sandbox: string; root: string; actor: string; node: string;
  bash: string; services(): Promise<{ primary: Service; neighbor: Service }>;
  fixture: string; track(child: ChildProcess): void; events: NativeGateEvents;
}) {
  const endpoint = options.provider === 'opencode-v1' ? await reserveEndpoint() : undefined;
  let phase: ReturnType<RetainedProcessScenario['phase']> = 'closed', businessDeadline = 0, nextStep = 0;
  let selectedMember: RuntimeMemberProfile | undefined, selectedProfile: TeamHostProfile | undefined;
  let recipeDigest: string | undefined, configPath: string | undefined, configSha: string | undefined;
  let managementReceipt: Record<string, unknown> | null = null, managementComplete = false, mainClosed = false;
  let memberTools: string[] | undefined, memberMcpUrl: string | undefined;
  const roots = new Map<string, RootRow>(), acceptedResults: string[] = [], processRefs = new Set<string>();
  const actions: { name: string; input: Record<string, unknown> }[] = [];
  const expectedNames: string[] = [];
  let originalServices: Awaited<ReturnType<typeof options.services>> | undefined;
  const workspace = join(options.root, 'workspace'), marker = 'TEST_RETAINED_NATIVE_SERVICES_STARTED';
  const shell = (role: 'primary' | 'neighbor') => quote(options.node) + ' ' + quote(options.actor) + ' ' +
    quote(options.root) + ' ' + role + ' < /dev/null > ' + quote(join(workspace, 'process-' + role + '.stdout')) +
    ' 2> ' + quote(join(workspace, 'process-' + role + '.stderr')) + ' &';
  const command = shell('primary') + '\n' + shell('neighbor') + '\nprintf ' + quote(marker + '\n');
  const member = () => {
    assert.ok(selectedMember && selectedProfile);
    assert.ok(selectedMember.provider === 'codex' || selectedMember.provider === 'opencode');
    return selectedMember;
  };
  const assertRecipe = () => {
    assert.equal(managementDigest(member()), recipeDigest);
    if (configPath) assert.equal(hash(readFileSync(configPath)), configSha);
    assert.equal(hash(readFileSync(member().executable.path)), member().executable.sha256);
  };
  const getRole = (role: Role) => [...roots.values()].filter(row => row.role === role);
  const memberRow = () => { const rows = getRole('member'); assert.equal(rows.length, 1); return rows[0]!; };
  const shortReleased = async (deadline: number, count: number) => {
    const rows = [...roots.values()].filter(row => row.role !== 'member'); assert.equal(rows.length, count);
    for (const row of rows) {
      assert.ok(row.role && row.witness && row.resumed && row.stopped && row.drained && row.released);
      if (!row.absent) {
        assert.equal(await timeout(row.witness.observe(), remaining(deadline)), 'absent');
        assert.equal(await timeout(row.witness.wait(), remaining(deadline)), 0); row.absent = true;
      } else assert.equal(await timeout(row.witness.wait(), remaining(deadline)), 0);
    }
  };
  const originalNativeName = (name: string, tools: readonly { name: string; namespace?: string }[]) => {
    const matches = tools.filter(tool => name === 'exec_command' || name === 'bash' ? tool.name === name
      : options.provider === 'codex' ? tool.name === name && tool.namespace?.includes('team') ||
        tool.name.endsWith('__' + name) : tool.name === 'team_' + name);
    assert.equal(matches.length, 1, 'One actual advertised native tool'); return matches[0]!.name;
  };
  const scenario: RetainedProcessScenario = {
    turn: PROCESS_BOOTSTRAP, phase: () => phase,
    async next(input) {
      assertRecipe(); assert.equal(phase, 'business'); remaining(businessDeadline);
      assert.equal(input.provider, options.provider); assert.equal(input.step, nextStep);
      assert.ok(nextStep < 4 && input.userText.includes(PROCESS_BOOTSTRAP));
      if (nextStep === 0) {
        assert.equal(input.previous, undefined);
        await shortReleased(businessDeadline, options.provider === 'codex' ? 6 : 1);
        assert.equal(roots.size, options.provider === 'codex' ? 7 : 2);
        assert.ok(memberRow().resumed && memberRow().witness);
        assert.equal(memberRow().witness!.process.exitCode, null);
        assert.ok(memberTools);
        assert.ok(memberTools?.includes('process_register') && memberMcpUrl);
        for (const name of memberTools) originalNativeName(name, input.tools);
      } else {
        const previous = input.previous; assert.ok(previous);
        assert.equal(previous.callId, (options.provider === 'codex' ? 'native_' : 'TEST_') +
          PROCESS_BOOTSTRAP + '_' + (nextStep - 1));
        assert.equal(previous.name, expectedNames[nextStep - 1]); same(previous.input, actions[nextStep - 1]!.input);
        assert.ok(!acceptedResults.includes(hash(JSON.stringify(previous))));
        acceptedResults.push(hash(JSON.stringify(previous)));
        if (nextStep === 1) {
          assert.equal(typeof previous.output, 'string');
          if (options.provider === 'codex') {
            assert.match(String(previous.output), /Process exited with code 0/);
            assert.ok(String(previous.output).includes(marker));
            assert.doesNotMatch(String(previous.output), /Process running with session ID/);
          } else assert.equal(String(previous.output).trim(), marker);
          for (;;) {
            try { originalServices = structuredClone(await options.services()); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await delay(Math.min(25, remaining(businessDeadline)));
          }
        } else {
          assert.ok(originalServices);
          const role = nextStep === 2 ? 'primary' : 'neighbor', service = originalServices[role];
          const receipt = options.provider === 'codex' ? codexToolReceipt(previous.output) : nativeToolReceipt(previous.output);
          assert.equal(receipt.commandId, role === 'primary' ? PROCESS_REGISTER_ID : PROCESS_NEIGHBOR_REGISTER_ID);
          assert.equal(receipt.operation, 'register'); assert.equal(receipt.phase, 'completed');
          const view = object(receipt.result); assert.equal(view.pid, service.pid);
          assert.equal(view.port, service.port); assert.equal(view.url, service.url);
          assert.equal(view.label, role === 'primary' ? PROCESS_LABEL : PROCESS_NEIGHBOR_LABEL);
          assert.equal(view.observation, 'unknown'); assert.equal(view.canTerminate, false);
          assert.match(String(view.processRef), /^p1:/); assert.equal(processRefs.has(String(view.processRef)), false);
          processRefs.add(String(view.processRef));
        }
      }
      let action: Awaited<ReturnType<RetainedProcessScenario['next']>>;
      if (nextStep === 0) action = options.provider === 'codex'
        ? { name: 'exec_command', input: { cmd: command, shell: options.bash, login: false, workdir: workspace,
            yield_time_ms: 1000, max_output_tokens: 500 } }
        : { name: 'bash', input: { command, description: 'Run two finite TEST services in the captured workspace' } };
      else if (nextStep < 3) {
        assert.ok(originalServices); const role = nextStep === 1 ? 'primary' : 'neighbor', service = originalServices[role];
        action = { name: 'process_register', input: {
          commandId: role === 'primary' ? PROCESS_REGISTER_ID : PROCESS_NEIGHBOR_REGISTER_ID,
          pid: service.pid, label: role === 'primary' ? PROCESS_LABEL : PROCESS_NEIGHBOR_LABEL,
          port: service.port, url: service.url,
          command: role === 'primary' ? 'TEST finite original native-owned service' : 'TEST finite original native-owned neighbor service',
        } };
      } else { assert.equal(processRefs.size, 2); assert.equal(acceptedResults.length, 3); }
      if (action) { actions.push(structuredClone(action)); expectedNames.push(originalNativeName(action.name, input.tools)); }
      nextStep++; return action;
    },
  };
  const native = options.provider === 'codex'
    ? await startCodexModel({ retainedProcess: scenario }) : await startOpenCodeModel({ retainedProcess: scenario });
  const model = { ...native, notificationAcks: [] };
  function configure(profile: TeamHostProfile, selected: RetainedProviderSelection) {
    assert.equal(selectedMember, undefined); assert.equal(selected.provider, options.provider);
    const original = profile.runtime?.members[0]; assert.ok(original && original.windowsBroker);
    const root = realpathSync.native(options.sandbox), env = { ...original.environment };
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']) delete env[key];
    for (const [key, name] of [['XDG_CONFIG_HOME', 'xdg-config'], ['XDG_DATA_HOME', 'xdg-data'],
      ['XDG_CACHE_HOME', 'xdg-cache']] as const) { mkdirSync(join(root, name)); env[key] = join(root, name); }
    env.SHELL = selected.bash.path;
    const common = { teamId: original.teamId, memberId: original.memberId, principalId: original.principalId,
      sessionId: original.sessionId, generation: original.generation, configRevision: original.configRevision,
      cwd: workspace, executable: selected.executable, windowsBroker: original.windowsBroker,
      accountBinding: original.accountBinding, limits: original.limits };
    if (options.provider === 'codex') {
      assert.equal(selected.version, '0.162.0'); mkdirSync(join(root, 'codex-home'));
      env.CODEX_HOME = join(root, 'codex-home'); env.TEST_CODEX_FIXTURE_KEY = 'TEST-LOCALHOST-ONLY';
      const shellEnvironment = { HOME: env.HOME!, TMPDIR: env.TMP!, PATH: env.PATH!, SystemRoot: env.SystemRoot!,
        WINDIR: env.WINDIR!, ComSpec: env.ComSpec! };
      const lines = ['model = "mock-model"', 'model_provider = "TEST_fixture"', 'approval_policy = "never"',
        'sandbox_mode = "workspace-write"', 'web_search = "disabled"', 'check_for_update_on_startup = false',
        'cli_auth_credentials_store = "file"', 'project_doc_max_bytes = 0', '[analytics]', 'enabled = false',
        '[otel]', 'exporter = "none"', 'metrics_exporter = "none"', '[features]', 'code_mode = false',
        'apps = false', 'plugins = false', 'remote_models = false', 'shell_snapshot = false',
        'skip_host_skill_discovery = true', 'enable_request_compression = false', 'multi_agent = false',
        '[shell_environment_policy]', 'inherit = "none"',
        'set = { ' + Object.entries(shellEnvironment).map(([key, value]) => key + ' = ' + JSON.stringify(value)).join(', ') + ' }',
        '[model_providers.TEST_fixture]', 'name = "TEST local fixture"', 'base_url = ' + JSON.stringify(model.url + '/v1'),
        'env_key = "TEST_CODEX_FIXTURE_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
        'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'];
      configPath = join(env.CODEX_HOME, 'config.toml'); writeFileSync(configPath, lines.join('\n') + '\n', { flag: 'wx' });
      configSha = hash(readFileSync(configPath));
      selectedMember = { ...common, provider: 'codex', protocolRevision: '0.162.0', model: 'mock-model', environment: env,
        capturedMcpServers: {}, capturedMcpCatalog: captureCodexConfiguredMcpCatalog({ digest: hash('[]'), servers: [] }),
        nativeOptions: { approvalPolicy: 'never', sandbox: 'workspace-write', modelProvider: 'TEST_fixture',
          developerInstructions: CODEX_CONTEXT + '. You are alice working only in ' + workspace + '.' } };
    } else {
      assert.equal(selected.version, '1.19.4'); assert.ok(endpoint);
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ autoupdate: false, share: 'disabled',
        enabled_providers: ['TEST-local'], model: 'TEST-local/TEST-model', small_model: 'TEST-local/TEST-model',
        permission: { '*': 'deny', bash: 'allow' },
        agent: { title: { disable: true }, summary: { disable: true }, 'TEST-member': { mode: 'primary' } },
        compaction: { auto: false }, provider: { 'TEST-local': { npm: '@ai-sdk/openai-compatible',
          name: 'TEST local', options: { baseURL: model.url + '/v1', apiKey: 'TEST-LOCALHOST-ONLY' },
          models: { 'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } } } } } });
      Object.assign(env, { OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1' });
      selectedMember = { ...common, provider: 'opencode', protocolRevision: '1.19.4', model: 'TEST-model',
        environment: env, endpoint, nativeOptions: { providerId: 'TEST-local', agent: 'TEST-member',
          instructions: OPENCODE_CONTEXT + '. You are alice working only in ' + workspace + '.' } };
    }
    selectedMember = runtimeMemberProfileSchema.parse(selectedMember);
    profile.runtime!.members[0] = selectedMember; selectedProfile = profile;
    if (options.provider === 'opencode-v1') profile.runtime!.initialModelAdmissions = [
      captureInitialRuntimeModelAdmission(profile, { method: 'runtime.open', teamId: selectedMember.teamId,
        commandId: 'TEST-original-open', payload: { memberId: selectedMember.memberId } })];
    recipeDigest = managementDigest(selectedMember);
  }

  function classify(bytes: Buffer): Role {
    assertRecipe(); const selected = member(), spec = decodeLaunch(bytes), args = argumentsOf(spec.commandLine);
    assert.equal(spec.executable, selected.executable.path); assert.equal(spec.cwd, selected.cwd);
    assert.equal(args.shift(), selected.executable.path);
    const environment = Object.fromEntries(spec.environment.map(entry => {
      const index = entry.indexOf('='); assert.ok(index > 0); return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    const expected = (env: Record<string, string>, argv: string[]) => {
      const value = windowsLaunchSpec({ ...selected, environment: env }, argv);
      same({ ...spec, environment: [...spec.environment].sort() }, { ...value, environment: [...value.environment].sort() });
    };
    if (selected.provider === 'codex') {
      if (!Object.hasOwn(environment, memberToken)) {
        expected(selected.environment, args);
        if (args.join('\0') === ['app-server', '--listen', 'stdio://'].join('\0')) {
          assert.equal(phase, 'closed'); assert.equal(roots.size, 1); return 'codex-metadata';
        }
        same(args, ['mcp', 'list', '--json']); return 'codex-census';
      }
      assert.match(environment[memberToken]!, /^[A-Za-z0-9_-]{32,256}$/);
      same(Object.keys(environment).sort(), [...Object.keys(selected.environment), memberToken].sort());
      same(args.slice(0, 3), ['-c', 'features.apps=false', '-c']);
      assert.ok(args[3]?.startsWith('mcp_servers='));
      const servers = inlineTable(args[3]!.slice('mcp_servers='.length)); same(Object.keys(servers), ['team']);
      const team = object(servers.team), required = team.enabled_tools;
      assert.ok(Array.isArray(required) && required.length > 0 && required.length <= 256);
      assert.ok(required.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name)));
      const names = required as string[]; assert.equal(new Set(names).size, names.length);
      assert.ok(names.includes('process_register')); memberTools = [...names];
      const url = new URL(String(team.url)); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
      assert.ok(url.port && !url.username && !url.password); memberMcpUrl = url.href;
      const configured = { url: String(team.url), bearer_token_env_var: memberToken, enabled_tools: names,
        startup_timeout_sec: Math.ceil(selected.limits.timeoutMs / 1000),
        tool_timeout_sec: Math.ceil(selected.limits.timeoutMs / 1000),
        tools: Object.fromEntries(names.map(name => [name, { approval_mode: 'approve' as const }])) };
      same(team, { ...configured, enabled: true }); assert.ok(selected.capturedMcpCatalog);
      const policy = captureCodexMcpPolicy({ catalog: selected.capturedMcpCatalog, selected: { team: configured } });
      expected({ ...selected.environment, [memberToken]: environment[memberToken]! },
        [...codexMcpPolicyArgs(policy), 'app-server', '--listen', 'stdio://']);
      return 'member';
    }
    assert.equal(selected.provider, 'opencode');
    if (selected.provider !== 'opencode') throw new Error('Original V1 recipe required');
    same(Object.keys(environment).sort(), [...Object.keys(selected.environment),
      'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD'].sort());
    assert.equal(environment.OPENCODE_SERVER_USERNAME, 'opencode');
    assert.match(environment.OPENCODE_SERVER_PASSWORD!, /^[A-Za-z0-9_-]{43}$/);
    const config = object(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!));
    const original = object(JSON.parse(selected.environment.OPENCODE_CONFIG_CONTENT!));
    const agents = object(config.agent), originalAgents = object(original.agent);
    let role: Role;
    if (config.mcp === undefined) {
      const added = Object.keys(agents).filter(name => !Object.hasOwn(originalAgents, name));
      assert.equal(added.length, 1); assert.match(added[0]!, /^management_[a-f0-9]{24}$/);
      const witness = object(agents[added[0]!]); assert.match(String(witness.prompt), /^[A-Za-z0-9_-]{43}$/);
      same(witness, { prompt: witness.prompt, disable: true, hidden: true });
      same(config, { ...original, permission: { '*': 'deny' }, agent: { ...originalAgents, [added[0]!]: witness } });
      assert.equal(phase, 'standalone-management-probe'); role = 'standalone-management-probe';
    } else {
      const mcp = object(config.mcp); same(Object.keys(mcp), ['team']);
      const team = object(mcp.team), headers = object(team.headers);
      same(Object.keys(headers), ['Authorization']); assert.match(String(headers.Authorization), /^Bearer [A-Za-z0-9_-]{32,256}$/);
      const url = new URL(String(team.url)); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
      assert.ok(url.port && !url.username && !url.password); memberMcpUrl = url.href;
      same(team, { type: 'remote', url: team.url, headers, oauth: false, enabled: true, timeout: selected.limits.timeoutMs });
      const agentName = selected.nativeOptions.agent, agent = object(agents[agentName]);
      const required = Object.keys(object(agent.permission));
      assert.ok(required.length > 0 && required.length <= 256 && required.every(name => /^team_[a-z][a-z0-9_]*$/.test(name)));
      memberTools = required.map(name => name.slice(5)); assert.ok(memberTools.includes('process_register'));
      assert.equal(typeof agent.prompt, 'string'); assert.ok(String(agent.prompt).includes(OPENCODE_CONTEXT));
      assert.ok(String(agent.prompt).includes(selected.nativeOptions.instructions!));
      same(config, { ...original, agent: { ...originalAgents, [agentName]: {
        ...object(originalAgents[agentName]), prompt: agent.prompt,
        model: selected.nativeOptions.providerId + '/' + selected.model,
        permission: canonicalOpenCodeAgentPermission({}, {}, required),
      } }, mcp });
      role = 'member';
    }
    expected({ ...selected.environment, OPENCODE_CONFIG_CONTENT: environment.OPENCODE_CONFIG_CONTENT!,
      OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: environment.OPENCODE_SERVER_PASSWORD! },
      ['serve', '--hostname', '127.0.0.1', '--port', new URL(selected.endpoint).port]);
    return role;
  }
  const isMember = (call: HostCustodyCall) => 'capability' in call && roots.get(call.capability)?.role === 'member';
  function observeAttempt(call: HostCustodyCall, epoch: number) {
    if (epoch === 2) assert.ok(!['allocate', 'launch-chunk', 'launch-commit', 'prepare', 'resume', 'write', 'end',
      'service-capture'].includes(call.operation), 'Cold successor has no fresh provider operation');
    if (call.operation !== 'allocate') return;
    assertRecipe(); assert.equal(epoch, 1); assert.equal(roots.has(call.capability), false);
    assert.ok(roots.size < (options.provider === 'codex' ? 7 : 2));
    assert.equal(call.executableSha256, member().executable.sha256);
    assert.equal(call.brokerRef, windowsBrokerReference(member().windowsBroker!));
    roots.set(call.capability, { allocation: structuredClone(call), chunks: [], length: 0,
      resumed: false, stopped: false, drained: false, released: false });
  }
  async function observeCustody(call: HostCustodyCall, value: HostCustodyResult) {
    assert.equal(value.operation, call.operation);
    if (!('capability' in call)) return;
    const saved = roots.get(call.capability); assert.ok(saved, 'Only original observed capability');
    if (call.operation === 'launch-chunk') {
      assert.equal(value.operation, 'launch-chunk'); if (value.operation !== 'launch-chunk') throw new Error('Chunk reply');
      assert.equal(saved.role, undefined); assert.equal(call.offset, saved.length);
      const bytes = Buffer.from(call.bytes, 'base64'); assert.equal(bytes.toString('base64'), call.bytes);
      saved.length += bytes.length; assert.ok(saved.length <= saved.allocation.launchBytes);
      assert.equal(value.offset, saved.length); saved.chunks.push(bytes);
    } else if (call.operation === 'launch-commit') {
      assert.equal(value.operation, 'launch-commit'); assert.equal(saved.role, undefined);
      const bytes = Buffer.concat(saved.chunks); assert.equal(bytes.length, saved.allocation.launchBytes);
      assert.equal(hash(bytes), saved.allocation.launchSha256);
      saved.role = classify(bytes); saved.ordinal = getRole(saved.role).length;
      assert.ok(saved.ordinal <= (saved.role === 'codex-census' ? 5 : 1));
      const spec = decodeLaunch(bytes); saved.specDigest = hash(spec.commandLine);
      saved.environmentDigest = hash(JSON.stringify([...spec.environment].sort())); saved.chunks.length = 0;
    } else if (call.operation === 'prepare') {
      assert.equal(value.operation, 'prepare'); if (value.operation !== 'prepare') throw new Error('Prepare reply');
      assert.ok(saved.role && !saved.root && !saved.witness); saved.root = structuredClone(value.root);
      saved.witness = await capturedQueryableWitness(options.fixture, value.root.pid, value.root.birth, options.track, options.events);
    } else if (call.operation === 'resume') {
      assert.equal(value.operation, 'resume'); assert.ok(saved.root && saved.witness && !saved.resumed); saved.resumed = true;
    } else if (call.operation === 'stop') {
      assert.equal(value.operation, 'stop'); if (value.operation !== 'stop') throw new Error('Stop reply');
      assert.equal(value.state, 'confirmed'); assert.ok(value.receiptRef && value.receipt);
      assert.equal(value.receipt.coverage, 'job-membership'); assert.equal(value.receipt.rootExited, true);
      same(value.receipt.owner, saved.allocation.owner); assert.equal(value.receipt.attemptId, call.attemptRef);
      saved.stopped = true; saved.receiptRef = value.receiptRef;
    } else if (call.operation === 'drain') {
      assert.equal(value.operation, 'drain'); if (value.operation !== 'drain') throw new Error('Drain reply');
      assert.equal(value.state, 'complete'); assert.equal(saved.stopped, true); saved.drained = true;
    } else if (call.operation === 'release') {
      assert.equal(value.operation, 'release'); if (value.operation !== 'release') throw new Error('Release reply');
      assert.ok(saved.stopped && saved.drained); assert.equal(call.receiptRef, saved.receiptRef);
      assert.equal(value.state, 'released'); saved.released = true;
    }
  }
  async function prelude(client: CapturedHostClient, deadline: number) {
    assertRecipe(); assert.equal(managementComplete, false); const profile = teamModelProbeProfile(member());
    const request = async (method: string, payload: Record<string, string | boolean>, control = false) => {
      const value = object(await client.request(method, payload, { control, remainingMs: () => remaining(deadline) }));
      remaining(deadline); assert.equal(value.ok, true, 'Original standalone management request'); return object(value.value);
    };
    if (options.provider === 'codex') {
      await request('management.codex.metadata', { profileId: profile.profileId, configRevision: profile.configRevision,
        includeModels: false, includeRateLimits: false });
      assert.equal(roots.size, 1); assert.equal(getRole('codex-metadata').length, 1);
      await shortReleased(deadline, 1); assert.equal(model.probes.length, 0);
    } else {
      assert.equal(profile.provider, 'opencode'); phase = 'standalone-management-probe';
      const input = { commandId: 'TEST-standalone-management-probe', profileId: profile.profileId,
        configRevision: profile.configRevision, providerId: 'TEST-local', modelId: 'TEST-model' };
      let state = await request('management.probe.start', input), reads = 0;
      while (state.phase === 'running') {
        assert.ok(reads++ < 128, 'Read only the original finite admitted probe');
        await delay(Math.min(500, remaining(deadline)));
        state = await request('management.probe.read', { commandId: input.commandId, profileId: input.profileId,
          configRevision: input.configRevision }, true);
      }
      for (const [key, value] of Object.entries(input)) assert.equal(state[key], value);
      assert.equal(state.phase, 'completed'); assert.equal(state.ok, true); assert.equal(model.probes.length, 1);
      assert.ok(selectedProfile); const receipt = originalReceipt(selectedProfile.owner.storageRoot, input.commandId);
      const saved = receipt.record; assert.equal(saved.kind, 'model.probe');
      for (const [key, value] of Object.entries(input)) assert.equal(object(saved)[key], value);
      assert.equal(saved.fingerprint, managementDigest(input)); assert.equal(saved.phase, 'completed');
      assert.equal(saved.ok, true); assert.equal(saved.resourceHeld, false);
      for (const key of ['purpose', 'readiness', 'localModelReadinessOrigin', 'localModelReadinessPreparation',
        'readinessScope', 'nativeFileKeyWitness', 'readinessRetired', 'context', 'limits']) assert.equal(object(saved)[key], undefined);
      const directories = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(key => {
        const path = profile.environment[key]; assert.ok(path && realpathSync(path) === path);
        const stat = statSync(path); assert.ok(stat.isDirectory()); return [key, { path, dev: stat.dev, ino: stat.ino }];
      }));
      assert.equal(saved.selectionDigest, managementDigest({ profile, directories }));
      assert.equal(saved.resourceId, managementDigest(directories.XDG_DATA_HOME));
      assert.equal(roots.size, 1); assert.equal(getRole('standalone-management-probe').length, 1);
      await shortReleased(deadline, 1); assert.ok(endpoint);
      assert.equal(await reserveEndpoint(Number(new URL(endpoint).port), deadline), endpoint);
      managementReceipt = { role: 'standalone-management-probe', ...input, fingerprint: saved.fingerprint,
        phase: saved.phase, ok: saved.ok, resourceHeld: saved.resourceHeld, receiptSha256: receipt.sha256,
        originalRootReleased: true, endpointReleased: true, initialReadinessProof: false };
      phase = 'closed';
    }
    assert.equal(model.observations.length, 0); same(model.failures, []); assertRecipe(); managementComplete = true;
  }
  async function openingComplete(deadline: number) {
    assert.equal(managementComplete, true); assert.equal(phase, 'closed'); assertRecipe();
    assert.equal(roots.size, options.provider === 'codex' ? 6 : 2);
    assert.equal(getRole('codex-census').length, options.provider === 'codex' ? 4 : 0);
    await shortReleased(deadline, options.provider === 'codex' ? 5 : 1);
    const row = memberRow(); assert.ok(row.witness && row.root && row.resumed && !row.stopped && !row.released);
    remaining(deadline); assert.equal(row.witness.process.exitCode, null); return row.witness;
  }
  return { model, configure, prelude, openingComplete, observeAttempt, observeCustody, isMember, workspace,
    provider: options.provider, seal: () => { phase = 'closed'; },
    memberAllocation: () => structuredClone(memberRow().allocation),
    memberWitness: () => { const value = memberRow().witness; assert.ok(value); return value; },
    beginBusiness: () => {
      assert.equal(managementComplete, true); assert.equal(phase, 'closed'); assert.equal(nextStep, 0);
      phase = 'business'; businessDeadline = performance.now() + 35000; return businessDeadline;
    },
    businessComplete: () => {
      assert.equal(nextStep, 4); assert.equal(processRefs.size, 2); assert.equal(acceptedResults.length, 3);
      assert.equal(model.observations.length, 4); assert.equal(model.probes.length, options.provider === 'codex' ? 0 : 1);
      assert.equal(model.notificationAcks.length, 0); same(model.failures, []); assertRecipe(); phase = 'closed';
    },
    async confirmMainCleanup(memberAbsent: 'alive' | 'absent' | null) {
      assert.equal(memberAbsent, 'absent'); assertRecipe();
      assert.equal(roots.size, options.provider === 'codex' ? 7 : 2);
      for (const row of roots.values()) {
        assert.ok(row.witness); assert.equal(await row.witness.wait(), 0);
        if (row.role === 'member') row.absent = true;
        else assert.ok(row.absent && row.stopped && row.drained && row.released);
      }
      mainClosed = true;
    },
    async drain() { for (const row of roots.values()) if (row.witness) assert.equal(await row.witness.wait(), 0); },
    evidence: () => ({ provider: options.provider, version: member().protocolRevision,
      initialProbeCount: 0, standaloneManagementProbeCount: model.probes.length,
      businessRequestCount: model.observations.length, businessInputCount: nextStep > 0 ? 1 : 0,
      managementReceipt, mainOwnerCleanupConfirmed: mainClosed, nativeSdkBackgroundTaskQualified: false,
      nativeNotificationCount: 0, recipeDigest, configSha256: configSha ?? null,
      roots: [...roots.values()].map(row => ({ role: row.role ?? 'unclassified', ordinal: row.ordinal ?? null,
        capability: row.allocation.capability, owner: row.allocation.owner, root: row.root ?? null,
        executableSha256: row.allocation.executableSha256, launchSha256: row.allocation.launchSha256,
        commandLineSha256: row.specDigest ?? null, environmentSha256: row.environmentDigest ?? null,
        resumed: row.resumed, stoppedByHost: row.stopped, drainedByHost: row.drained, releasedByHost: row.released,
        releasedByMainCleanup: row.role === 'member' && mainClosed, originalHandleAbsent: row.absent === true })),
    }),
  };
}
