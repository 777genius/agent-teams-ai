/** Finite SDK metadata and one no-tools probe for the original legacy saved Sonnet selection. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
assert.equal(process.env.TEST_PEER_SCENARIO, 'desktop-ui-v1');
assert.equal(process.env.TEST_PEER_PROVIDER, 'claude');
const role = process.env.TEST_PEER_ROLE;
assert.ok(role === 'management' || role === 'runtime');
assert.equal(process.env.TEST_DESKTOP_SETTINGS, 'saved-import');
const root = process.env.TEST_DESKTOP_PEER_ROOT;
assert.ok(root && basename(dirname(root)).startsWith('TEST-desktop-backend-'));
assert.equal(root, join(dirname(root), 'TEST-peer-claude-scope'));
const cwd = join(dirname(root), 'workspace'), config = join(root, 'config'), home = join(root, 'home');
for (const path of [root, cwd, config, home]) assert.equal(realpathSync(path), path);
assert.equal(process.cwd(), cwd);
assert.equal(process.env.TEST_DESKTOP_PEER_WORKSPACE, cwd);
assert.equal(process.env.CLAUDE_CONFIG_DIR, config);
assert.equal(process.env.HOME, home);
const effects = join(root, 'effects.ndjson');
assert.equal(process.env.TEST_PEER_EFFECTS, effects);
if (existsSync(effects)) assert.ok(lstatSync(effects).isFile() && !lstatSync(effects).isSymbolicLink());
let effectCount = 0;
const effect = value => {
  assert.ok(++effectCount <= 32);
  appendFileSync(effects, JSON.stringify({ provider: 'claude', role, pid: process.pid, ...value }) + '\n', { mode: 0o600 });
};
const model = 'claude-sonnet-4-6', probe = 'Reply only OK. Do not use tools, access files or run commands.';
const options = {}, flags = new Set(['verbose', 'strict-mcp-config', 'no-session-persistence']);
const values = new Set(['output-format', 'input-format', 'model', 'effort', 'tools', 'setting-sources',
  'permission-mode', 'permission-prompt-tool', 'session-id', 'max-turns', 'settings']);
const argv = process.argv.slice(2);
assert.ok(argv.length <= 40 && Buffer.byteLength(JSON.stringify(argv)) <= 4096);
effect({ event: 'argv', args: argv });
for (let index = 0; index < argv.length; index++) {
  const match = /^--([a-zA-Z-]+)(?:=([\s\S]*))?$/u.exec(argv[index]);
  assert.ok(match && !Object.hasOwn(options, match[1]), 'closed import argv');
  if (flags.has(match[1])) { assert.equal(match[2], undefined); options[match[1]] = true; }
  else {
    assert.ok(values.has(match[1]), 'closed import argv');
    const value = match[2] ?? argv[++index];
    assert.ok(typeof value === 'string' && !value.includes('\0'));
    options[match[1]] = value;
  }
}
assert.equal(options['output-format'], 'stream-json');
assert.equal(options['input-format'], 'stream-json');
assert.equal(options.verbose, true);
assert.equal(options['strict-mcp-config'], true);
assert.equal(options['no-session-persistence'], true);
assert.equal(options['permission-mode'], 'dontAsk');
assert.equal(options.tools, '');
assert.equal(options['setting-sources'], 'user,project,local');
assert.ok(options['max-turns'] === undefined || options['max-turns'] === '1');
assert.deepEqual(JSON.parse(options.settings), { disableAllHooks: true });
assert.ok(options.model === undefined || options.model === model);
assert.ok(options.effort === undefined || options.effort === 'low');
assert.equal(options.model === undefined, options.effort === undefined, 'saved model and effort travel together');
assert.equal(options['permission-prompt-tool'], options.model === undefined ? undefined : 'stdio');
assert.equal(options['session-id'] === undefined, options.model === undefined);
if (role === 'runtime') assert.equal(options.model, model, 'runtime-derived selection is a finite saved-model probe');
const session = options['session-id'] ?? randomUUID();
assert.match(session, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
let initialized = false, inputId, finished = false, failed = false, buffer = '', inputBytes = 0;
const record = value => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value; };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const envelope = () => ({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null,
  ...(inputId ? { user_message_uuid: inputId } : {}) });
const reply = (requestId, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
const fail = () => {
  if (failed) return; failed = true;
  effect({ event: 'failure', code: 'closed-saved-import-protocol' });
  process.stderr.write('TEST saved import peer refused\n'); process.exit(78);
};
const accept = frame => {
  record(frame);
  if (frame.type === 'control_request') {
    const request = record(frame.request);
    assert.ok(typeof frame.request_id === 'string' && frame.request_id.length <= 256);
    if (request.subtype === 'mcp_status') {
      assert.equal(initialized, true); reply(frame.request_id, { mcpServers: [] }); return;
    }
    assert.equal(request.subtype, 'initialize'); assert.equal(initialized, false);
    assert.deepEqual(request.hooks ?? {}, {});
    initialized = true;
    reply(frame.request_id, { commands: [], models: [{ value: model, resolvedModel: model,
      displayName: 'Sonnet 4.6', description: 'Finite TEST saved-import model probe',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsFastMode: false }],
    agents: [], output_style: 'default', available_output_styles: ['default'],
    account: { apiProvider: 'firstParty', tokenSource: 'TEST-emulated', subscriptionType: 'TEST-emulated' } });
    send({ type: 'system', subtype: 'init', ...envelope(), cwd, model, tools: [], mcp_servers: [],
      permissionMode: 'dontAsk', slash_commands: [], skills: [], plugins: [], output_style: 'default',
      apiKeySource: 'none', claude_code_version: 'TEST-saved-import-sdk-0.3.305' });
    effect({ event: 'initialized', sessionId: session, requestedModel: options.model ?? null,
      requestedEffort: options.effort ?? null });
    return;
  }
  assert.equal(frame.type, 'user'); assert.equal(initialized, true); assert.equal(inputId, undefined);
  assert.equal(options.model, model); assert.equal(options.effort, 'low');
  assert.equal(frame.session_id, session); assert.equal(frame.parent_tool_use_id, null);
  assert.equal(frame.message?.role, 'user');
  const content = frame.message.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined;
  assert.equal(text, probe, 'only original no-tools probe input');
  assert.match(frame.uuid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
  inputId = frame.uuid;
  effect({ event: 'input', inputId, sessionId: session, marker: 'TEST_MODEL_PROBE',
    requestedModel: options.model, requestedEffort: options.effort, text });
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  send({ type: 'assistant', ...envelope(), message: { id: randomUUID(), type: 'message', role: 'assistant',
    model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage } });
  effect({ event: 'terminal', inputId, sessionId: session, marker: 'TEST_MODEL_PROBE', outcome: 'succeeded', text: 'OK' });
  send({ type: 'result', subtype: 'success', ...envelope(), duration_ms: 1, duration_api_ms: 0,
    is_error: false, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage,
    modelUsage: { [model]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 8192 } },
    permission_denials: [], result: 'OK' });
  finished = true;
};
effect({ event: 'launch', parentPid: process.ppid, sessionId: session, requestedModel: options.model ?? null,
  requestedEffort: options.effort ?? null });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  try {
    inputBytes += Buffer.byteLength(chunk); buffer += chunk;
    assert.ok(inputBytes <= 128 * 1024 && Buffer.byteLength(buffer) <= 65536);
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      assert.ok(line); accept(JSON.parse(line));
    }
  } catch { fail(); }
});
process.stdin.on('end', () => {
  try { assert.equal(buffer, ''); effect({ event: 'stdin-ended', completedProbe: finished }); }
  catch { fail(); }
});
