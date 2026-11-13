/** Finite TEST protocol responses. Original Host, checked D and MCP own all product effects. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
const hostRequire = createRequire(new URL('../../../packages/legacy-agent-host/package.json', import.meta.url));
const { Client } = await import(pathToFileURL(hostRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(hostRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
assert.equal(process.env.TEST_EMULATED_WINDOWS_PROVIDER, undefined);
assert.equal(process.env.TEST_PEER_SCENARIO, 'desktop-ui-v1');
const provider = process.env.TEST_PEER_PROVIDER, role = process.env.TEST_PEER_ROLE;
assert.equal(provider, 'codex');
assert.ok(role === 'management' || role === 'runtime');
const root = process.env.TEST_DESKTOP_PEER_ROOT;
assert.ok(root && /^TEST-peer-codex-/.test(basename(root)));
assert.equal(realpathSync(root), root);
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
  assert.ok(['model_reasoning_effort', 'service_tier', 'mcp_servers.team.enabled', 'mcp_servers.team.url',
    'mcp_servers.team.bearer_token_env_var', 'mcp_servers.team.enabled_tools',
    'mcp_servers.team.startup_timeout_sec', 'mcp_servers.team.tool_timeout_sec'].includes(key) ||
    /^mcp_servers\.team\.tools\.[a-z_]+\.approval_mode$/.test(key), 'Finite captured native argv');
  options[key] = JSON.parse(value.slice(separator + 1));
}
assert.equal(appServer, 1);
effect({ event: 'launch', parentPid: process.ppid, argc: argv.length });
let mcp, tools = [];
const runtimeMcp = role === 'runtime' && options['mcp_servers.team.url'] !== undefined;
if (runtimeMcp) {
  const endpoint = new URL(options['mcp_servers.team.url']);
  assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(endpoint.port); assert.equal(endpoint.username, ''); assert.equal(endpoint.password, '');
  assert.equal(options['mcp_servers.team.enabled'], true);
  const tokenName = options['mcp_servers.team.bearer_token_env_var'];
  assert.equal(tokenName, 'LEGACY_AGENT_HOST_TEAM_MCP_TOKEN');
  assert.ok(process.env[tokenName]);
  mcp = new Client({ name: 'TEST-desktop-provider-peer', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${process.env[tokenName]}` } },
  }));
  tools = (await mcp.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...options['mcp_servers.team.enabled_tools']].sort());
  for (const tool of tools) assert.equal(options[`mcp_servers.team.tools.${tool.name}.approval_mode`], 'approve');
  effect({ event: 'connected', tools: tools.map(tool => tool.name) });
} else assert.equal(Object.keys(options).some(key => key.startsWith('mcp_servers.')), false);

let stopped = false;
const close = async (code = 0) => {
  if (stopped) return; stopped = true;
  effect({ event: 'exit', code });
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
  'TEST_UI_SCHEDULE_DONE', 'TEST_UI_SCHEDULE_HOLD'];
const selectMarker = text => {
  assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 65536);
  if (!runtimeMcp) {
    assert.equal(text, 'Reply only OK. Do not use tools, access files or run commands.');
    return 'TEST_MODEL_PROBE';
  }
  const found = [...new Set(text.match(/\bTEST_UI_[A-Z_]+\b/g) ?? [])];
  assert.equal(found.length, 1); assert.ok(markers.includes(found[0])); return found[0];
};
async function scheduledCompletion() {
  assert.ok(mcp);
  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text');
    return JSON.parse(result.content[0].text);
  };
  const result = await call('task_list', { owner: 'alice', status: 'in_progress' });
  const tasks = Array.isArray(result) ? result : record(result).tasks;
  assert.ok(Array.isArray(tasks));
  const matches = tasks.filter(task => String(task.description ?? '').includes('TEST_UI_SCHEDULE_DONE'));
  assert.equal(matches.length, 1);
  const id = matches[0].id; assert.equal(typeof id, 'string');
  const completed = await call('task_complete', { commandId: `TEST-complete-${process.pid}`, taskId: id });
  const reply = await call('message_send', { commandId: `TEST-reply-${process.pid}`, to: 'user', text: 'TEST scheduled reply' });
  effect({ event: 'scheduled-effect', taskId: id, taskCommandId: completed.commandId, messageCommandId: reply.commandId });
}

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threadId = `TEST-thread-${process.pid}`;
let turns = 0, active, pending;
const fields = turn => ({ threadId, turnId: turn.id, itemId: turn.itemId });
const delta = (turn, text) => {
  assert.equal(active, turn); turn.text += text;
  notify('item/agentMessage/delta', { ...fields(turn), delta: text });
};
const finish = (turn, text, status = 'completed') => {
  assert.equal(active, turn); assert.equal(pending, undefined);
  if (text !== undefined) {
    if (text.startsWith(turn.text)) delta(turn, text.slice(turn.text.length));
    notify('item/completed', { threadId, turnId: turn.id,
      item: { id: turn.itemId, type: 'agentMessage', text } });
  }
  notify('thread/tokenUsage/updated', { threadId, turnId: turn.id,
    tokenUsage: { last: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 7 } } });
  notify('turn/completed', { threadId, turn: { id: turn.id, status } });
  active = undefined; effect({ event: 'terminal', marker: turn.marker, turnId: turn.id, status });
};
async function runTurn(turn) {
  const marker = turn.marker;
  if (marker === 'TEST_MODEL_PROBE' || marker === 'TEST_UI_BOOT')
    return finish(turn, marker === 'TEST_MODEL_PROBE' ? 'OK' : 'TEST boot ready');
  if (marker === 'TEST_UI_STREAM') {
    delta(turn, 'TEST stream partial'); effect({ event: 'partial', turnId: turn.id });
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
    delta(turn, 'TEST held partial'); return;
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
    case 'config/read': result = { config: { model: 'TEST-model', model_provider: 'TEST-fixture', features: { apps: false } } }; break;
    case 'model/list': result = { data: [{ id: 'TEST-model', model: 'TEST-model', displayName: 'TEST model', description: 'Finite TEST protocol peer',
      hidden: false, isDefault: true, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
      inputModalities: ['text'], supportsPersonality: false }], nextCursor: null }; break;
    case 'thread/start':
      assert.equal(active, undefined); assert.equal(params.cwd, process.cwd()); assert.equal(params.model, 'TEST-model');
      result = { thread: { id: threadId }, cwd: params.cwd, model: params.model, modelProvider: params.modelProvider ?? 'TEST-fixture',
        reasoningEffort: options.model_reasoning_effort ?? null, serviceTier: options.service_tier ?? null }; break;
    case 'mcpServerStatus/list':
      assert.equal(runtimeMcp, true); assert.equal(params.threadId, threadId);
      result = { data: [{ name: 'team', authStatus: 'bearerToken', runtimeStatus: 'connected', toolsError: null,
        resources: [], resourceTemplates: [], tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }], nextCursor: null }; break;
    case 'turn/start': {
      assert.equal(params.threadId, threadId); assert.equal(active, undefined); assert.ok(++turns <= 24);
      assert.ok(Array.isArray(params.input) && params.input.length > 0 && params.input.every(part => part.type === 'text'));
      const marker = selectMarker(params.input.map(part => part.text).join('\n'));
      const turn = { id: `TEST-turn-${process.pid}-${turns}`, itemId: `TEST-message-${turns}`, text: '', marker };
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
