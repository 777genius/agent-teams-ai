/** Finite TEST protocol responses. Original Host, checked D and MCP own all product effects. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
const hostRequire = createRequire(new URL('../../../packages/legacy-agent-host/package.json', import.meta.url));

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
assert.equal(process.env.TEST_EMULATED_WINDOWS_PROVIDER, undefined);
assert.equal(process.env.TEST_PEER_SCENARIO, 'desktop-ui-v1');
const provider = process.env.TEST_PEER_PROVIDER, role = process.env.TEST_PEER_ROLE;
assert.ok(provider === 'codex' || provider === 'opencode');
assert.ok(role === 'management' || role === 'runtime');
const selection = process.env.TEST_DESKTOP_SELECTION;
assert.ok(selection === undefined || selection === 'two-models-v1' && provider === 'codex');
let collaboration;
if (process.env.TEST_DESKTOP_COLLABORATION !== undefined) {
  assert.equal(process.env.TEST_DESKTOP_COLLABORATION, 'mixed-v1'); assert.equal(selection, undefined);
  const source = new URL('./providerCollaboration.mjs', import.meta.url), path = fileURLToPath(source);
  assert.equal(realpathSync(path), path);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), process.env.TEST_PEER_COLLABORATION_SHA256);
  collaboration = await import(source.href);
}
const codexModels = selection === undefined ? ['TEST-model'] : ['TEST-model', 'TEST-model-next'];
const root = process.env.TEST_DESKTOP_PEER_ROOT;
assert.ok(root); assert.equal(basename(root), `TEST-peer-${provider}-scope`);
assert.equal(realpathSync(root), root);
const workspace = process.env.TEST_DESKTOP_PEER_WORKSPACE;
assert.equal(workspace, join(dirname(root), 'workspace'));
assert.match(basename(dirname(root)), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
assert.equal(realpathSync(dirname(root)), dirname(root));
assert.equal(realpathSync(workspace), workspace); assert.equal(process.cwd(), workspace);
for (const [key, child] of [['HOME', 'home'], ['TMPDIR', 'tmp'], ['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache']]) {
  assert.equal(process.env[key], join(root, child)); assert.equal(realpathSync(process.env[key]), process.env[key]);
}
if (provider === 'codex') assert.equal(process.env.CODEX_HOME, join(root, 'config'));
const proof = process.env.TEST_PEER_EFFECTS;
assert.equal(proof, join(root, 'effects.ndjson'));
assert.equal(realpathSync(dirname(proof)), root);
const record = value => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value; };
let effects = 0;
const effect = value => {
  assert.ok(++effects <= 512, 'Bounded TEST effect journal');
  const line = JSON.stringify({ ...record(value), provider, role, pid: process.pid });
  assert.ok(Buffer.byteLength(line) <= 8192);
  appendFileSync(proof, line + '\n', { mode: 0o600 });
};
const argv = process.argv.slice(2), options = {};
assert.ok(argv.length <= 1024 && argv.every(arg => arg.length <= 65536 && !arg.includes('\0')));
// The managed Codex contract uses canonical inline TOML, with JSON-quoted keys/strings.
// Accept only the closed TEST Team policy; native config/catalog inputs are never inferred.
const managedPolicy = raw => {
  let json = '', quoted = false, escaped = false;
  for (const char of raw) {
    if (quoted) {
      json += char;
      if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false;
    } else { if (char === '"') quoted = true; json += char === '=' ? ':' : char; }
  }
  assert.equal(quoted, false); const rows = record(JSON.parse(json));
  const encode = value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(encode).join(',') + ']'
      : '{' + Object.entries(record(value)).map(([key, field]) => JSON.stringify(key) + '=' + encode(field)).join(',') + '}';
  assert.equal(encode(rows), raw, 'only the original canonical managed policy');
  assert.deepEqual(readdirSync(process.env.CODEX_HOME), [], 'only the original empty TEST native catalog');
  if (Object.keys(rows).length === 0) {
    assert.equal(process.env.LEGACY_AGENT_HOST_TEAM_MCP_TOKEN, undefined);
    return rows; // Runtime use additionally requires the original ephemeral thread below.
  }
  assert.deepEqual(Object.keys(rows), ['team']); const team = record(rows.team);
  assert.ok(Object.keys(team).every(key => ['url', 'bearer_token_env_var', 'enabled_tools', 'tools', 'enabled', 'startup_timeout_sec', 'tool_timeout_sec'].includes(key)));
  assert.equal(team.enabled, true); assert.equal(team.bearer_token_env_var, 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN');
  const endpoint = new URL(team.url); assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(endpoint.port && !endpoint.username && !endpoint.password && !endpoint.hash);
  assert.ok(Array.isArray(team.enabled_tools) && team.enabled_tools.length <= 256 && team.enabled_tools.every(name => /^[a-z_]+$/.test(name)));
  assert.equal(new Set(team.enabled_tools).size, team.enabled_tools.length);
  assert.deepEqual(Object.keys(record(team.tools)).sort(), [...team.enabled_tools].sort());
  for (const value of Object.values(team.tools)) assert.deepEqual(value, { approval_mode: 'approve' });
  for (const key of ['startup_timeout_sec', 'tool_timeout_sec']) if (team[key] !== undefined)
    assert.ok(typeof team[key] === 'number' && Number.isFinite(team[key]) && team[key] > 0 && team[key] <= 180000);
  return rows;
};
if (provider === 'codex' && argv[0] === 'mcp') {
  assert.deepEqual(argv, ['mcp', 'list', '--json']);
  assert.deepEqual(readdirSync(process.env.CODEX_HOME), [], 'only the original empty TEST native catalog');
  assert.equal(process.env.LEGACY_AGENT_HOST_TEAM_MCP_TOKEN, undefined);
  effect({ event: 'launch', parentPid: process.ppid, argc: argv.length });
  effect({ event: 'mcp-catalog', configuredServers: 0 });
  await new Promise((resolve, reject) => process.stdout.write('[]\n', error => error ? reject(error) : resolve()));
  process.exit(0);
}
const config = provider === 'opencode' ? record(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)) : undefined;
if (provider === 'codex') {
let appServer = 0;
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === 'app-server') {
    assert.deepEqual(argv.slice(index, index + 3), ['app-server', '--listen', 'stdio://']);
    assert.equal(++appServer, 1); index += 2; continue;
  }
  assert.equal(argv[index], '-c');
  const value = argv[++index]; assert.equal(typeof value, 'string');
  const separator = value.indexOf('='), key = value.slice(0, separator);
  assert.ok(separator > 0 && !Object.hasOwn(options, key));
  assert.ok(['model_reasoning_effort', 'service_tier', 'features.apps', 'mcp_servers', 'mcp_servers.team.enabled', 'mcp_servers.team.url',
    'mcp_servers.team.bearer_token_env_var', 'mcp_servers.team.enabled_tools',
    'mcp_servers.team.startup_timeout_sec', 'mcp_servers.team.tool_timeout_sec'].includes(key) ||
    /^mcp_servers\.team\.tools\.[a-z_]+\.approval_mode$/.test(key), 'Finite captured native argv');
  options[key] = key === 'mcp_servers' ? managedPolicy(value.slice(separator + 1)) : JSON.parse(value.slice(separator + 1));
}
assert.equal(appServer, 1);
} else {
  assert.equal(argv.length, 5); assert.deepEqual(argv.slice(0, 4), ['serve', '--hostname', '127.0.0.1', '--port']);
  assert.match(argv[4], /^[1-9][0-9]{0,4}$/); assert.ok(Number(argv[4]) <= 65535);
  assert.equal(process.env.OPENCODE_SERVER_USERNAME, 'opencode'); assert.ok(process.env.OPENCODE_SERVER_PASSWORD);
}
const managedMcp = options.mcp_servers;
const standaloneMcp = provider === 'codex' && role === 'runtime' && managedMcp !== undefined && Object.keys(managedMcp).length === 0;
if (managedMcp !== undefined) {
  assert.equal(options['features.apps'], false); assert.equal(Object.keys(options).some(key => key.startsWith('mcp_servers.')), false);
  if (managedMcp.team) {
    for (const [key, value] of Object.entries(managedMcp.team)) if (key !== 'tools') options['mcp_servers.team.' + key] = value;
    for (const name of managedMcp.team.enabled_tools) options[`mcp_servers.team.tools.${name}.approval_mode`] = 'approve';
  }
} else assert.equal(options['features.apps'], undefined);
effect({ event: 'launch', parentPid: process.ppid, argc: argv.length });
let mcp, server, tools = [];
if (provider === 'opencode' && config.plugin !== undefined) {
  assert.equal(role, 'runtime');
  const source = new URL('../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeMcpPolicyPlugin.js', import.meta.url);
  assert.deepEqual(config.plugin, [source.href], 'only the pinned shipped native configuration hook');
  const path = fileURLToPath(source), hash = process.env.TEST_PEER_MCP_POLICY_SHA256;
  assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(realpathSync(path), path);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash);
  const { mcp: beforeMcp, ...before } = globalThis.structuredClone(config);
  assert.ok(beforeMcp);
  const hooks = await (await import(source.href)).default(undefined);
  assert.deepEqual(Object.keys(hooks), ['config']); await hooks.config(config);
  const { mcp: afterMcp, ...after } = config; assert.deepEqual(after, before);
  assert.equal(Object.isFrozen(afterMcp), true);
  assert.equal(Object.getOwnPropertyDescriptor(config, 'mcp').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(config, 'mcp').configurable, false);
  effect({ event: 'policy-configured', pluginSha256: hash });
} else if (provider === 'opencode') {
  assert.equal(process.env.LEGACY_AGENT_HOST_MCP_POLICY_NONCE, undefined);
  assert.equal(process.env.LEGACY_AGENT_HOST_MCP_TEAM_SERVER, undefined);
}
const runtimeMcp = role === 'runtime' && (provider === 'opencode' ? config.mcp?.team !== undefined : options['mcp_servers.team.url'] !== undefined);
const connectTeam = async () => {
  assert.equal(runtimeMcp, true); assert.equal(mcp, undefined);
  const nativeMcp = provider === 'opencode' ? record(record(config.mcp).team) : undefined;
  const endpoint = new URL(nativeMcp ? nativeMcp.url : options['mcp_servers.team.url']);
  assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(endpoint.port); assert.equal(endpoint.username, ''); assert.equal(endpoint.password, '');
  let authorization;
  if (nativeMcp) {
    assert.deepEqual(Object.keys(config.mcp), ['team']);
    assert.equal(nativeMcp.enabled, true); assert.equal(nativeMcp.type, 'remote'); assert.equal(nativeMcp.oauth, false);
    authorization = record(nativeMcp.headers).Authorization; assert.match(authorization, /^Bearer [A-Za-z0-9_-]+$/);
  } else {
    assert.equal(options['mcp_servers.team.enabled'], true);
    const tokenName = options['mcp_servers.team.bearer_token_env_var'];
    assert.equal(tokenName, 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN'); assert.ok(process.env[tokenName]);
    authorization = `Bearer ${process.env[tokenName]}`;
  }
  const { Client } = await import(pathToFileURL(hostRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(hostRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
  mcp = new Client({ name: 'TEST-desktop-provider-peer', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: nativeMcp ? { ...record(nativeMcp.headers) } : { authorization } },
  }));
  tools = (await mcp.listTools()).tools;
  if (provider === 'codex') {
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...options['mcp_servers.team.enabled_tools']].sort());
    for (const tool of tools) assert.equal(options[`mcp_servers.team.tools.${tool.name}.approval_mode`], 'approve');
  } else {
    const agent = record(record(config.agent).build); assert.equal(agent.model, 'test-provider/TEST-model');
    const permissions = record(agent.permission);
    assert.deepEqual(Object.keys(permissions).filter(name => name.startsWith('team_')).sort(), tools.map(tool => 'team_' + tool.name).sort());
    for (const tool of tools) assert.equal(permissions['team_' + tool.name], 'allow');
  }
  effect({ event: 'connected', tools: tools.map(tool => tool.name) });
};
if (runtimeMcp) { if (managedMcp === undefined) await connectTeam(); }
else if (provider === 'codex') assert.equal(Object.keys(options).some(key => key.startsWith('mcp_servers.')), false);
else {
  assert.deepEqual(config.mcp ?? {}, {}); assert.deepEqual(config.permission, { '*': 'deny' });
}

let stopped = false;
const close = async (code = 0) => {
  if (stopped) return; stopped = true;
  effect({ event: 'exit', code });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await mcp?.close(); process.exit(code);
};
const fail = error => {
  effect({ event: 'failure', reason: error instanceof assert.AssertionError ? 'assertion' : 'protocol' });
  process.stderr.write(`TEST Desktop peer refused: ${error instanceof Error ? error.message.slice(0, 512) : 'invalid protocol'}\n`);
  void close(1);
};
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
setTimeout(() => fail(new Error('TEST peer lifetime exceeded')), 10 * 60_000).unref();
const markers = ['TEST_UI_BOOT', 'TEST_UI_STREAM', 'TEST_UI_HOLD', 'TEST_UI_APPROVAL_ALLOW',
  'TEST_UI_APPROVAL_DENY', 'TEST_UI_QUESTION', 'TEST_UI_QUESTION_DECLINE',
  'TEST_UI_SCHEDULE_DONE', 'TEST_UI_SCHEDULE_HOLD', ...(collaboration?.collaborationMarkers ?? [])];
const selectMarker = text => {
  assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 65536);
  if (!runtimeMcp) {
    assert.equal(text, 'Reply only OK. Do not use tools, access files or run commands.');
    return 'TEST_MODEL_PROBE';
  }
  const found = [...new Set(text.match(/\bTEST_UI_[A-Z_]+\b/g) ?? [])];
  assert.equal(found.length, 1); assert.ok(markers.includes(found[0]));
  if (provider === 'opencode') assert.equal(found[0].startsWith('TEST_UI_QUESTION'), false, 'V1 structured questions are unsupported in the original bridge');
  return found[0];
};
async function scheduledCompletion() {
  assert.ok(mcp);
  const call = async (name, args) => {
    assert.ok(tools.some(tool => tool.name === name), 'Only the exact original advertised Team tool');
    const result = await mcp.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text');
    effect({ event: 'mcp-call', name, ...(args.commandId ? { commandId: args.commandId } : {}) });
    return JSON.parse(result.content[0].text);
  };
  const result = await call('task_list', { owner: 'alice', status: 'in_progress' });
  const tasks = Array.isArray(result) ? result : record(result).tasks;
  assert.ok(Array.isArray(tasks) && tasks.length === 1);
  const task = record(tasks[0]);
  assert.equal(task.owner, 'alice'); assert.equal(task.status, 'in_progress'); assert.ok(String(task.subject).includes('TEST'));
  const id = task.id; assert.equal(typeof id, 'string');
  const completed = await call('task_lifecycle', { commandId: `TEST-complete-${process.pid}`, taskId: id, action: 'complete' });
  const reply = await call('message_send', { commandId: `TEST-reply-${process.pid}`, to: 'user', text: 'TEST scheduled reply' });
  assert.equal(completed.phase, 'completed'); assert.equal(reply.phase, 'completed');
  effect({ event: 'scheduled-effect', taskId: id, taskCommandId: completed.commandId, messageCommandId: reply.commandId });
}

if (provider === 'codex') {
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threadId = `TEST-thread-${process.pid}`;
let turns = 0, active, pending, managedConfigObserved = false, standaloneThread = false;
const fields = turn => ({ threadId, turnId: turn.id, itemId: turn.itemId });
const delta = (turn, text) => {
  assert.equal(active, turn); turn.text += text;
  notify('item/agentMessage/delta', { ...fields(turn), delta: text });
};
const completeItem = (turn, text) => {
  assert.equal(active, turn);
  if (text.startsWith(turn.text)) delta(turn, text.slice(turn.text.length));
  notify('item/completed', { threadId, turnId: turn.id,
    item: { id: turn.itemId, type: 'agentMessage', text } });
};
const finish = (turn, text, status = 'completed') => {
  assert.equal(active, turn); assert.equal(pending, undefined);
  if (text !== undefined) completeItem(turn, text);
  notify('thread/tokenUsage/updated', { threadId, turnId: turn.id,
    tokenUsage: { last: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 7 } } });
  notify('turn/completed', { threadId, turn: { id: turn.id, status } });
  active = undefined; effect({ event: 'terminal', marker: turn.marker, turnId: turn.id, status });
};
async function runTurn(turn) {
  const marker = turn.marker;
  if (collaboration?.collaborationMarkers.includes(marker)) return finish(turn, await collaboration.runCollaboration({
    marker, raw: turn.raw, inputId: turn.id, mcp, tools, current: () => assert.equal(active, turn), effect }));
  if (marker === 'TEST_MODEL_PROBE' || marker === 'TEST_UI_BOOT')
    return finish(turn, marker === 'TEST_MODEL_PROBE' ? 'OK' : 'TEST boot ready');
  if (marker === 'TEST_UI_STREAM') {
    // Original Codex exposes completed text items before the enclosing turn terminal.
    completeItem(turn, 'TEST stream partial'); effect({ event: 'partial', turnId: turn.id });
    turn.itemId += '-final'; turn.text = '';
    const deadline = Date.now() + 60_000;
    while (active === turn && !existsSync(join(root, 'release-stream'))) {
      assert.ok(Date.now() < deadline, 'Bounded TEST stream gate');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (active === turn) {
      assert.equal(realpathSync(join(root, 'release-stream')), join(root, 'release-stream'));
      assert.equal(readFileSync(join(root, 'release-stream'), 'utf8'), 'TEST release once\n');
      finish(turn, 'TEST stream partial complete');
    }
    return;
  }
  if (marker === 'TEST_UI_HOLD' || marker === 'TEST_UI_SCHEDULE_HOLD') {
    completeItem(turn, 'TEST held partial'); return;
  }
  if (marker === 'TEST_UI_SCHEDULE_DONE') {
    await scheduledCompletion(); return finish(turn, 'TEST scheduled complete');
  }
  const question = marker.startsWith('TEST_UI_QUESTION');
  const id = `TEST-interaction-${process.pid}-${turns}`;
  assert.equal(pending, undefined); pending = { id, turn, question };
  effect({ event: 'interaction', marker, turnId: turn.id, requestId: id, kind: question ? 'question' : 'permission' });
  send({ id, method: question ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval',
    params: question ? { ...fields(turn), questions: [{ id: 'TEST-choice', header: 'TEST',
      question: 'Choose the TEST route', isOther: false, isSecret: false,
      options: [{ label: 'Alpha', description: 'TEST alpha' }, { label: 'Beta', description: 'TEST beta' }] }] }
      : { ...fields(turn), command: 'TEST write approved-effect.txt', cwd: process.cwd(),
        reason: 'Finite TEST effect under the captured peer directory', availableDecisions: ['accept', 'decline'] } });
}
async function receive(frame) {
  record(frame);
  if (frame.method === undefined) {
    assert.ok(pending); assert.equal(frame.id, pending.id); assert.equal(frame.error, undefined);
    const current = pending; pending = undefined;
    const result = record(frame.result), turn = current.turn;
    assert.equal(active, turn);
    if (current.question) {
      const answers = record(result.answers), decline = Object.keys(answers).length === 0;
      if (!decline) assert.deepEqual(answers, { 'TEST-choice': { answers: ['Alpha'] } });
      effect({ event: 'interaction-reply', marker: turn.marker, requestId: current.id, decision: decline ? 'deny' : 'Alpha' });
      finish(turn, decline ? 'TEST question declined' : 'TEST question Alpha');
    } else {
      assert.ok(result.decision === 'accept' || result.decision === 'decline');
      if (result.decision === 'accept') writeFileSync(join(root, 'approved-effect.txt'), 'TEST approved once\n', { mode: 0o600, flag: 'wx' });
      effect({ event: 'interaction-reply', marker: turn.marker, requestId: current.id, decision: result.decision });
      finish(turn, result.decision === 'accept' ? 'TEST approval allowed' : 'TEST approval denied');
    }
    return;
  }
  if (frame.method === 'initialized') { assert.equal(frame.id, undefined); return; }
  assert.ok(typeof frame.id === 'string' || Number.isSafeInteger(frame.id));
  const params = record(frame.params ?? {}); let result;
  switch (frame.method) {
    case 'initialize': result = { codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: process.platform }; break;
    case 'account/read': result = { account: { type: 'chatgpt', email: 'TEST@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true }; break;
    case 'account/rateLimits/read': result = { rateLimits: { primary: null, secondary: null, credits: null, planType: 'plus' } }; break;
    case 'config/read':
      if (managedMcp !== undefined) { managedConfigObserved = true; effect({ event: 'managed-configuration-read', selectedServers: Object.keys(managedMcp) }); }
      result = { config: { model: 'TEST-model', model_provider: 'TEST-fixture', features: { apps: false },
      ...(managedMcp === undefined ? {} : { mcp_servers: Object.fromEntries(Object.entries(managedMcp).map(([name, row]) =>
        [name, { ...row, environment_id: 'local', tool_timeout_sec: row.tool_timeout_sec ?? null }])) }) } }; break;
    case 'model/list': result = { data: codexModels.map((model, index) => ({ id: model, model,
      displayName: index === 0 ? 'TEST model' : 'TEST next model', description: 'Finite TEST protocol peer',
      hidden: false, isDefault: index === 0, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
      inputModalities: ['text'], supportsPersonality: false })), nextCursor: null }; break;
    case 'thread/start':
      assert.equal(active, undefined); assert.equal(params.cwd, process.cwd()); assert.ok(codexModels.includes(params.model));
      if (managedMcp !== undefined) { assert.equal(managedConfigObserved, true); if (runtimeMcp) await connectTeam(); }
      if (standaloneMcp) {
        assert.equal(params.ephemeral, true, 'Only the original standalone ephemeral thread');
        assert.equal(standaloneThread, false); standaloneThread = true;
      }
      if (selection !== undefined) {
        if (runtimeMcp) assert.ok(['low', 'high'].includes(options.model_reasoning_effort));
        effect({ event: 'thread-selection', threadId, model: params.model,
          effort: options.model_reasoning_effort ?? null, runtimeMcp });
      }
      result = { thread: { id: threadId }, cwd: params.cwd, model: params.model, modelProvider: params.modelProvider ?? 'TEST-fixture',
        reasoningEffort: options.model_reasoning_effort ?? null, serviceTier: options.service_tier ?? null }; break;
    case 'mcpServerStatus/list':
      assert.equal(params.threadId, threadId);
      if (standaloneMcp) {
        assert.equal(standaloneThread, true); assert.equal(mcp, undefined); assert.deepEqual(tools, []);
        result = { data: [], nextCursor: null }; break;
      }
      assert.equal(runtimeMcp, true); assert.ok(mcp);
      result = { data: [{ name: 'team', authStatus: 'bearerToken', runtimeStatus: 'connected', toolsError: null,
        resources: [], resourceTemplates: [], tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }], nextCursor: null }; break;
    case 'turn/start': {
      if (standaloneMcp) assert.equal(standaloneThread, true);
      assert.equal(params.threadId, threadId); assert.equal(active, undefined); assert.ok(++turns <= 24);
      assert.ok(Array.isArray(params.input) && params.input.length > 0 && params.input.every(part => part.type === 'text'));
      const marker = selectMarker(params.input.map(part => part.text).join('\n'));
      const turn = { id: `TEST-turn-${process.pid}-${turns}`, itemId: `TEST-message-${turns}`, text: '', marker,
        raw: params.input.map(part => part.text).join('\n') };
      active = turn; effect({ event: 'input', marker, turnId: turn.id });
      reply(frame.id, { turn: { id: turn.id } }); notify('turn/started', { threadId, turn: { id: turn.id } });
      void runTurn(turn).catch(fail); return;
    }
    case 'turn/interrupt':
      assert.ok(active); assert.equal(params.threadId, threadId); assert.equal(params.turnId, active.id);
      assert.equal(pending, undefined); effect({ event: 'interrupt', marker: active.marker, turnId: active.id });
      reply(frame.id, {}); finish(active, undefined, 'interrupted'); return;
    default: throw new Error('Unexpected TEST Codex request: ' + String(frame.method));
  }
  reply(frame.id, result);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { try { assert.ok(Buffer.byteLength(line) <= 131072); void receive(JSON.parse(line)).catch(fail); } catch (error) { fail(error); } });
lines.once('close', () => { void close(); });
} else {
  const sessionId = `ses_TESTdesktop${process.pid}`, session = { id: sessionId, directory: workspace, version: '1.19.4' };
  const messages = [], model = { providerID: 'test-provider', modelID: 'TEST-model' };
  const configured = record(record(config.provider)['test-provider']);
  assert.equal(record(configured.options).baseURL, 'http://127.0.0.1:19999/TEST-no-network');
  assert.equal(record(configured.options).apiKey, 'TEST-LOCALHOST-ONLY');
  assert.deepEqual(Object.keys(record(configured.models)), ['TEST-model']);
  assert.equal(configured.npm, '@ai-sdk/openai-compatible');
  const nativeModels = { 'TEST-model': { ...record(record(configured.models)['TEST-model']),
    api: { npm: configured.npm, id: 'TEST-model', url: record(configured.options).baseURL } } };
  const catalog = [{ id: 'test-provider', name: 'TEST provider', source: 'custom', env: [],
    npm: configured.npm, options: { ...record(configured.options) }, models: nativeModels }];
  let allocated = false, turns = 0, active, pending;
  const json = (response, value, status = 200) => {
    const bytes = JSON.stringify(value); assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024);
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(bytes);
  };
  const partial = (turn, text) => {
    assert.equal(active, turn); turn.assistant.parts[0].text = text;
    effect({ event: 'partial', marker: turn.marker, inputId: turn.userId, messageId: turn.assistant.info.id });
  };
  const finish = (turn, text, outcome = 'succeeded') => {
    assert.equal(active, turn); assert.equal(pending, undefined);
    if (text !== undefined) turn.assistant.parts[0].text = text;
    turn.assistant.info.time.completed = Date.now();
    if (outcome === 'succeeded') turn.assistant.info.finish = 'stop';
    else { assert.equal(outcome, 'cancelled'); turn.assistant.info.error = { name: 'MessageAbortedError', data: { message: 'TEST interrupted' } }; }
    active = undefined;
    effect({ event: 'terminal', marker: turn.marker, inputId: turn.userId, messageId: turn.assistant.info.id, outcome });
  };
  const runTurn = async turn => {
    const marker = turn.marker;
    if (collaboration?.collaborationMarkers.includes(marker)) return finish(turn, await collaboration.runCollaboration({
      marker, raw: turn.raw, inputId: turn.userId, mcp, tools, current: () => assert.equal(active, turn), effect }));
    if (marker === 'TEST_UI_BOOT') return finish(turn, 'TEST boot ready');
    if (marker === 'TEST_UI_STREAM') {
      partial(turn, 'TEST stream partial');
      const gate = join(root, 'release-stream'), deadline = Date.now() + 60_000;
      while (active === turn && !existsSync(gate)) {
        assert.ok(Date.now() < deadline, 'Bounded TEST stream gate');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (active === turn) {
        assert.equal(realpathSync(gate), gate); assert.equal(readFileSync(gate, 'utf8'), 'TEST release once\n');
        finish(turn, 'TEST stream partial complete');
      }
      return;
    }
    if (marker === 'TEST_UI_HOLD' || marker === 'TEST_UI_SCHEDULE_HOLD') { partial(turn, 'TEST held partial'); return; }
    if (marker === 'TEST_UI_SCHEDULE_DONE') { await scheduledCompletion(); return finish(turn, 'TEST scheduled complete'); }
    assert.ok(marker === 'TEST_UI_APPROVAL_ALLOW' || marker === 'TEST_UI_APPROVAL_DENY');
    const requestId = `TEST-permission-${process.pid}-${turns}`, callID = `TEST-call-${turns}`;
    const tool = { id: `prt_tool${turns}`, sessionID: sessionId, messageID: turn.assistant.info.id, type: 'tool',
      callID, tool: 'bash', state: { status: 'running', input: { command: 'TEST write approved-effect.txt' },
        title: 'TEST write approved-effect.txt', time: { start: Date.now() } } };
    turn.assistant.parts.push(tool);
    const permission = { id: requestId, sessionID: sessionId, permission: 'bash',
      tool: { messageID: turn.assistant.info.id, callID } };
    assert.equal(pending, undefined); pending = { requestId, turn, tool, permission };
    effect({ event: 'interaction', marker, inputId: turn.userId, requestId, kind: 'permission' });
  };
  server = createServer((request, response) => { void (async () => {
    assert.equal(request.headers.authorization, 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64'));
    assert.equal(request.headers['x-opencode-directory'], encodeURIComponent(workspace));
    assert.ok(request.method === 'GET' || request.method === 'POST');
    const url = new URL(request.url, 'http://127.0.0.1');
    assert.equal(url.origin, 'http://127.0.0.1'); assert.equal(url.hash, '');
    for (const key of url.searchParams.keys()) {
      assert.equal(url.searchParams.getAll(key).length, 1);
      if (url.pathname === `/session/${sessionId}/message`) { assert.equal(key, 'limit'); assert.equal(url.searchParams.get(key), '50'); }
      else { assert.equal(url.pathname, '/experimental/tool/ids'); assert.equal(key, 'directory'); assert.equal(url.searchParams.get(key), workspace); }
    }
    let input;
    if (request.method === 'POST') {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 131072, 'Bounded TEST request'); chunks.push(chunk); }
      input = record(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    }
    if (request.method === 'POST' && url.pathname === '/session') {
      assert.equal(url.search, ''); assert.equal(allocated, false);
      if (runtimeMcp && collaboration) {
        assert.deepEqual(Object.keys(input), ['title']); assert.match(input.title, /^Team member [A-Za-z0-9_-]{1,200}$/);
        effect({ event: 'collaboration-session', memberId: input.title.slice('Team member '.length), sessionId });
      } else assert.deepEqual(input, { title: runtimeMcp ? 'Team member alice-id' : 'Agent Teams model connection test' });
      allocated = true; return json(response, session);
    }
    if (request.method === 'POST' && url.pathname === `/session/${sessionId}/message`) {
      assert.equal(runtimeMcp, false); assert.equal(allocated, true); assert.equal(turns, 0);
      assert.equal(url.search, '');
      assert.deepEqual(Object.keys(input).sort(), ['model', 'parts', 'tools', ...(input.variant === undefined ? [] : ['variant'])].sort());
      assert.deepEqual(input.model, model); assert.deepEqual(input.tools, { '*': false, bash: false, edit: false });
      if (input.variant !== undefined) assert.ok(input.variant === 'low' || input.variant === 'high');
      assert.ok(Array.isArray(input.parts) && input.parts.length === 1);
      assert.deepEqual(Object.keys(record(input.parts[0])).sort(), ['text', 'type']); assert.equal(input.parts[0].type, 'text');
      assert.equal(selectMarker(input.parts[0].text), 'TEST_MODEL_PROBE'); turns++;
      effect({ event: 'input', marker: 'TEST_MODEL_PROBE' });
      const reply = { info: { id: 'msg_TESTprobe', role: 'assistant', sessionID: sessionId, ...model,
        time: { created: Date.now(), completed: Date.now() } },
        parts: [{ id: 'prt_probe', sessionID: sessionId, messageID: 'msg_TESTprobe', type: 'text', text: 'OK' }] };
      effect({ event: 'terminal', marker: 'TEST_MODEL_PROBE', outcome: 'succeeded' });
      return json(response, reply);
    }
    if (request.method === 'POST' && url.pathname === `/session/${sessionId}/prompt_async`) {
      assert.equal(runtimeMcp, true); assert.equal(allocated, true); assert.equal(active, undefined); assert.equal(pending, undefined);
      assert.equal(url.search, ''); assert.ok(++turns <= 24);
      assert.deepEqual(Object.keys(input).sort(), ['agent', 'messageID', 'model', 'parts', ...(input.variant === undefined ? [] : ['variant'])].sort());
      assert.deepEqual(input.model, model); assert.equal(input.agent, 'build');
      if (input.variant !== undefined) assert.ok(input.variant === 'low' || input.variant === 'high');
      assert.ok(Array.isArray(input.parts) && input.parts.length === 1);
      assert.deepEqual(Object.keys(record(input.parts[0])).sort(), ['text', 'type']); assert.equal(input.parts[0].type, 'text');
      const marker = selectMarker(input.parts[0].text), userId = input.messageID;
      assert.match(userId, /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/); assert.equal(messages.some(row => row.info.id === userId), false);
      const assistantId = 'msg_' + userId.slice(4, 16) + 'T'.repeat(13) + turns.toString(36), time = Date.now();
      assert.equal(messages.some(row => row.info.id === assistantId), false); assert.notEqual(assistantId, userId);
      const assistant = { info: { id: assistantId, parentID: userId, role: 'assistant', sessionID: sessionId, ...model,
        time: { created: time } }, parts: [{ id: `prt_text${turns}`, sessionID: sessionId, messageID: assistantId, type: 'text', text: '' }] };
      messages.push({ info: { id: userId, role: 'user', sessionID: sessionId, time: { created: time } },
        parts: [{ ...input.parts[0], id: `prt_user${turns}`, sessionID: sessionId, messageID: userId }] }, assistant);
      const turn = { userId, marker, assistant, raw: input.parts[0].text }; active = turn;
      effect({ event: 'input', marker, inputId: userId, messageId: assistantId });
      response.writeHead(204); response.end(); void runTurn(turn).catch(fail); return;
    }
    if (request.method === 'POST' && /^\/permission\/[A-Za-z0-9_-]+\/reply$/.test(url.pathname)) {
      assert.ok(pending); assert.equal(url.pathname, `/permission/${pending.requestId}/reply`); assert.equal(url.search, '');
      assert.deepEqual(Object.keys(input), ['reply']); assert.ok(input.reply === 'once' || input.reply === 'reject');
      const current = pending; assert.equal(active, current.turn);
      const allowed = input.reply === 'once';
      if (allowed) writeFileSync(join(root, 'approved-effect.txt'), 'TEST approved once\n', { mode: 0o600, flag: 'wx' });
      current.tool.state = { ...current.tool.state, status: allowed ? 'completed' : 'error',
        ...(allowed ? { output: 'TEST approved once' } : { error: 'TEST denied' }),
        time: { ...current.tool.state.time, end: Date.now() } };
      effect({ event: 'interaction-reply', marker: current.turn.marker, inputId: current.turn.userId, requestId: current.requestId, decision: input.reply });
      pending = undefined; finish(current.turn, allowed ? 'TEST approval allowed' : 'TEST approval denied');
      return json(response, true);
    }
    if (request.method === 'POST' && url.pathname === `/session/${sessionId}/abort`) {
      assert.equal(url.search, ''); assert.deepEqual(input, {}); assert.ok(active); assert.equal(pending, undefined);
      assert.ok(['TEST_UI_HOLD', 'TEST_UI_SCHEDULE_HOLD', 'TEST_UI_STREAM'].includes(active.marker));
      effect({ event: 'interrupt', marker: active.marker, inputId: active.userId });
      finish(active, undefined, 'cancelled'); return json(response, true);
    }
    assert.equal(request.method, 'GET');
    if (url.pathname === '/config') return json(response, config);
    if (url.pathname === '/agent') return json(response, [{ name: 'build', mode: 'primary' }]);
    if (url.pathname === '/config/providers') return json(response, { providers: catalog, default: { 'test-provider': 'TEST-model' } });
    if (url.pathname === '/provider') return json(response, { all: catalog, connected: ['test-provider'], default: { 'test-provider': 'TEST-model' } });
    if (url.pathname === '/provider/auth') return json(response, {});
    if (url.pathname === '/experimental/tool/ids') return json(response, ['bash', 'edit']);
    if (url.pathname === '/mcp') return json(response, runtimeMcp ? { team: { status: 'connected' } } : {});
    assert.equal(allocated, true);
    if (url.pathname === `/session/${sessionId}`) return json(response, session);
    if (url.pathname === `/session/${sessionId}/message`) return json(response, messages);
    if (url.pathname === '/session/status') return json(response, active ? { [sessionId]: { type: 'busy' } } : {});
    if (url.pathname === '/permission') return json(response, pending ? [pending.permission] : []);
    if (url.pathname === '/question') return json(response, []);
    throw new Error('Unexpected TEST OpenCode route');
  })().catch(error => {
    if (!response.headersSent) json(response, { error: 'TEST refusal' }, 500); else response.end();
    fail(error);
  }); });
  server.once('error', fail);
  server.listen(Number(argv[4]), '127.0.0.1');
}
