/** TEST stream-JSON CLI peer for the real pinned Claude SDK. Never runs a vendor CLI or model. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
// Resolve the declared, locked Host dependency; tools/ has no separate package or ambient SDK.
const hostRequire = createRequire(new URL('../../../packages/legacy-agent-host/package.json', import.meta.url));
const { Client } = hostRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = hostRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1', 'environment');
assert.equal(process.env.TEST_PEER_SCENARIO, 'desktop-ui-v1', 'environment');
assert.equal(process.env.TEST_PEER_PROVIDER, 'claude', 'environment');
const role = process.env.TEST_PEER_ROLE;
assert.ok(role === 'management' || role === 'runtime', 'environment');
const root = process.env.TEST_DESKTOP_PEER_ROOT;
assert.ok(root && isAbsolute(root) && basename(root).startsWith('TEST-'), 'environment');
assert.equal(realpathSync(root), root, 'environment');
const proof = join(root, 'effects.ndjson');
assert.equal(process.env.TEST_PEER_EFFECTS, proof, 'environment');
const inside = path => {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'environment');
  const part = relative(root, path);
  assert.ok(part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part), 'environment');
  assert.equal(realpathSync(path), path, 'environment');
  return path;
};
const fixtureRoot = dirname(root);
assert.ok(basename(fixtureRoot).startsWith('TEST-'), 'environment');
assert.equal(realpathSync(fixtureRoot), fixtureRoot, 'environment');
assert.equal(root, join(fixtureRoot, 'TEST-peer-claude-scope'), 'environment');
const cwd = join(fixtureRoot, 'workspace');
assert.equal(process.env.TEST_DESKTOP_PEER_WORKSPACE, cwd, 'environment');
assert.equal(realpathSync(cwd), cwd, 'environment');
assert.equal(process.cwd(), cwd, 'environment');
inside(process.env.HOME);
const configRoot = inside(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, '.claude'));
if (existsSync(proof)) assert.ok(lstatSync(proof).isFile() && !lstatSync(proof).isSymbolicLink(), 'environment');
let effectCount = 0;
const effect = value => {
  assert.ok(++effectCount <= 512, 'limit');
  appendFileSync(proof, JSON.stringify({ provider: 'claude', role, pid: process.pid, ...value }) + '\n');
};
const record = value => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'wire');
  return value;
};
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const options = {};
const flags = new Set(['verbose', 'strict-mcp-config', 'include-partial-messages', 'no-session-persistence', 'allow-dangerously-skip-permissions']);
const values = new Set(['output-format', 'input-format', 'model', 'effort', 'tools', 'allowedTools', 'disallowedTools',
  'setting-sources', 'permission-mode', 'permission-prompt-tool', 'session-id', 'resume', 'max-turns', 'max-budget-usd', 'betas', 'mcp-config', 'settings']);
const argv = process.argv.slice(2);
assert.ok(argv.length <= 64 && Buffer.byteLength(JSON.stringify(argv)) <= 128 * 1024, 'argv');
for (let index = 0; index < argv.length; index++) {
  const match = /^--([a-zA-Z-]+)(?:=([\s\S]*))?$/u.exec(argv[index]);
  assert.ok(match && !Object.hasOwn(options, match[1]), 'argv');
  const name = match[1];
  if (flags.has(name)) { assert.equal(match[2], undefined, 'argv'); options[name] = true; }
  else {
    assert.ok(values.has(name), 'argv');
    const value = match[2] ?? argv[++index];
    assert.ok(typeof value === 'string' && !value.includes('\0'), 'argv'); options[name] = value;
  }
}
assert.equal(options['output-format'], 'stream-json', 'argv');
assert.equal(options['input-format'], 'stream-json', 'argv');
assert.equal(options.verbose, true, 'argv');
assert.equal(options['strict-mcp-config'], true, 'argv');
assert.ok(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(options['permission-mode']), 'argv');
assert.ok(options['permission-prompt-tool'] === undefined || options['permission-prompt-tool'] === 'stdio', 'argv');
assert.ok(options.effort === undefined || ['low', 'medium', 'high'].includes(options.effort), 'argv');
assert.ok(options.model === undefined || ['sonnet', 'sonnet[1m]', 'TEST-claude-sonnet'].includes(options.model), 'argv');
assert.ok(options['max-turns'] === undefined || ['1', '6', '8'].includes(options['max-turns']), 'argv');
assert.ok(options['max-budget-usd'] === undefined || ['0.25', '0.5'].includes(options['max-budget-usd']), 'argv');
assert.ok(options.betas === undefined || options.betas === 'context-1m-2025-08-07', 'argv');
assert.ok(typeof options['setting-sources'] === 'string' && options['setting-sources'].split(',').every(value => ['', 'user', 'project', 'local'].includes(value)), 'argv');
for (const name of ['tools', 'allowedTools', 'disallowedTools']) {
  assert.ok(options[name] === undefined || options[name].split(',').every(value => /^[a-zA-Z0-9_:*.-]*$/u.test(value)), 'argv');
}
if (options.settings !== undefined) {
  const settings = record(JSON.parse(options.settings));
  assert.ok(Object.keys(settings).every(name => ['disableAllHooks', 'fastMode'].includes(name)), 'argv');
  assert.ok(Object.values(settings).every(value => typeof value === 'boolean'), 'argv');
}
assert.ok(!(options['session-id'] && options.resume), 'argv');
const session = options.resume ?? options['session-id'] ?? randomUUID();
assert.ok(uuid(session), 'argv');
const teamRuntime = options['mcp-config'] !== undefined;
const finite = !teamRuntime && options['permission-mode'] === 'dontAsk';
const standalone = !teamRuntime && !finite;
if (finite) {
  assert.equal(options.tools, '', 'argv');
  assert.equal(options['no-session-persistence'], true, 'argv');
  assert.equal(options['permission-mode'], 'dontAsk', 'argv');
  assert.equal(options.resume, undefined, 'argv');
  assert.ok(options['max-turns'] === undefined || options['max-turns'] === '1', 'argv');
  assert.equal(options['max-budget-usd'], undefined, 'argv');
  assert.deepEqual(JSON.parse(options.settings), { disableAllHooks: true }, 'argv');
} else {
  assert.equal(role, 'runtime', 'argv');
  assert.ok(options['session-id'] || options.resume, 'argv');
  assert.equal(options['permission-prompt-tool'], 'stdio', 'argv');
  if (standalone) {
    assert.ok(options['session-id'], 'argv');
    assert.equal(options.resume, undefined, 'argv');
    assert.equal(options['no-session-persistence'], true, 'argv');
    assert.equal(options['permission-mode'], 'bypassPermissions', 'argv');
    assert.equal(options['allow-dangerously-skip-permissions'], true, 'argv');
    assert.ok(options['max-turns'] === '8' && options['max-budget-usd'] === '0.5'
      || options['max-turns'] === '6' && options['max-budget-usd'] === '0.25', 'argv');
    assert.equal(options.effort, 'low', 'argv');
    assert.deepEqual(JSON.parse(options.settings), { fastMode: false }, 'argv');
    assert.deepEqual(options.tools.split(',').sort(), ['Agent', 'AskUserQuestion', 'Read', 'Write'], 'argv');
    assert.ok(options.allowedTools === undefined || options.allowedTools === '', 'argv');
    assert.equal(options.disallowedTools, undefined, 'argv');
  } else {
    assert.equal(options['no-session-persistence'], undefined, 'argv');
    assert.equal(options['max-turns'], undefined, 'argv');
    assert.equal(options['max-budget-usd'], undefined, 'argv');
  }
}

// These native command shapes are the recorded SDK0.3.305 metadata contract.
const commands = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context.', argumentHint: '<optional custom summarization instructions>', builtin: true },
  { name: 'usage', description: 'Show session cost, plan usage, and limits.', argumentHint: '', aliases: ['cost'], builtin: true },
  { name: 'code-review', description: 'Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model\'s review recipe covers them) at the given effort level (low|medium|high|xhigh|max: from few high-confidence findings up to many, some of them uncertain); with no level given, it reuses the level you typed last. Pass --comment to post findings as inline PR comments, or --fix to apply the findings to the working tree after the review. Pass --max-findings <n> to report up to n findings, or --max-findings all for every finding. The choice stays until you pass --max-findings default.',
    argumentHint: '[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]', aliases: ['review'], builtin: true },
  { name: 'test-desktop-skill', description: 'Run the declared TEST desktop skill.', argumentHint: '' },
];
// Exact original review.ts prompt, with one finite TEST argument. This peer never executes gh.
// The installed adapter must expand the qualified /review alias before this reaches native input.
const review = `
      You are an expert code reviewer. Follow these steps:

      1. If no PR number is provided in the args, run \`gh pr list\` to show open PRs
      2. If a PR number is provided, run \`gh pr view <number>\` to get PR details
      3. Run \`gh pr diff <number>\` to get the diff
      4. Analyze the changes and provide a thorough code review that includes:
         - Overview of what the PR does
         - Analysis of code quality and style
         - Specific suggestions for improvements
         - Any potential issues or risks

      Keep your review concise but thorough. Focus on:
      - Code correctness
      - Following project conventions
      - Performance implications
      - Test coverage
      - Security considerations

      Format your review with clear sections and bullet points.

      PR number: TEST_UI_REVIEW
    `;
const models = [{ value: 'sonnet', resolvedModel: 'TEST-claude-sonnet', displayName: 'TEST Claude Sonnet',
  description: 'Subscription-free protocol emulation', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsFastMode: false }];
let initialized = false, active, streamTimer, frames = 0, bytes = 0, inputCount = 0, resultCount = 0;
let mcp, nativeTools = [], hooks = {}, failed = false;
const pending = new Map(), seenInputs = new Set();
const historyDirectory = join(configRoot, 'projects', 'TEST-desktop-peer');
const history = join(historyDirectory, `${session}.jsonl`);
const persist = options['no-session-persistence'] !== true;
let resumedHistory;
if (persist) {
  mkdirSync(historyDirectory, { recursive: true }); inside(historyDirectory);
  if (options.resume) {
    assert.equal(realpathSync(history), history, 'resume');
    assert.ok(lstatSync(history).isFile() && lstatSync(history).size <= 1024 * 1024, 'resume');
    const rows = readFileSync(history, 'utf8').trim().split('\n').map(line => record(JSON.parse(line)));
    assert.ok(rows.length > 0 && rows.every(row => row.sessionId === session && row.cwd === cwd && row.isSidechain === false), 'resume');
    for (const row of rows) if (row.type === 'user') seenInputs.add(row.uuid);
    resumedHistory = { sha256: createHash('sha256').update(readFileSync(history)).digest('hex'),
      rows: rows.length, userIds: rows.filter(row => row.type === 'user').map(row => row.uuid),
      bootRetained: rows.some(row => row.type === 'user' && row.message.content.includes('TEST_UI_BOOT')) &&
        rows.some(row => row.type === 'assistant' && row.message.content === 'TEST boot ready') };
  } else writeFileSync(history, '', { flag: 'wx', mode: 0o600 });
}
const remember = (type, id, text) => {
  if (persist) appendFileSync(history, JSON.stringify({ type, uuid: id, sessionId: session, cwd, isSidechain: false,
    message: { role: type, content: text } }) + '\n');
};
const send = value => {
  const line = JSON.stringify(value) + '\n'; bytes += Buffer.byteLength(line);
  assert.ok(++frames <= 2048 && bytes <= 2 * 1024 * 1024, 'limit'); process.stdout.write(line);
};
const reply = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
const envelope = input => ({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null,
  ...(input ? { user_message_uuid: input.id } : {}) });
const usage = { input_tokens: 42, output_tokens: 18, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const message = (id, content) => ({ id, type: 'message', role: 'assistant', model: 'TEST-claude-sonnet', content,
  stop_reason: 'end_turn', stop_sequence: null, usage });
const assistant = (input, content) => send({ type: 'assistant', ...envelope(input), message: message(input.messageId, content) });
const partial = (input, text) => {
  const frame = event => send({ type: 'stream_event', ...envelope(input), event });
  frame({ type: 'message_start', message: message(input.messageId, []) });
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  effect({ event: 'partial', inputId: input.id, marker: input.marker, text });
};
function finish(input, text, { interrupted = false, localCommand } = {}) {
  assert.equal(active, input, 'authority');
  clearTimeout(streamTimer); streamTimer = undefined;
  if (!interrupted && !localCommand) assistant(input, [{ type: 'text', text }]);
  const counted = localCommand !== 'usage';
  if (counted) resultCount++;
  const cost = Number((resultCount * 0.0123).toFixed(4));
  const resultUsage = counted ? usage : { ...usage, input_tokens: 0, output_tokens: 0 };
  const result = { type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', ...envelope(input),
    duration_ms: 1, duration_api_ms: 0, is_error: interrupted, num_turns: counted ? 1 : 0, stop_reason: interrupted ? null : 'end_turn',
    total_cost_usd: cost, usage: resultUsage, modelUsage: { 'TEST-claude-sonnet': { inputTokens: resultCount * 42, outputTokens: resultCount * 18,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost,
      contextWindow: options.betas || options.model === 'sonnet[1m]' ? 1000000 : 200000, maxOutputTokens: 8192 } },
    permission_denials: [], ...(interrupted ? { errors: ['TEST input interrupted'] } : { result: text }),
    ...(localCommand ? { local_command: localCommand } : {}) };
  remember('assistant', result.uuid, text); send(result);
  effect({ event: 'terminal', inputId: input.id, marker: input.marker, outcome: interrupted ? 'interrupted' : 'succeeded', text,
    usage: resultUsage, cumulativeCostUsd: cost });
  active = undefined;
}
function nativeRequest(input, request) {
  assert.equal(active, input, 'authority'); assert.ok(pending.size < 16, 'limit');
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('control-timeout')); }, 30000);
    pending.set(id, { input, resolve, reject, timer });
    send({ type: 'control_request', request_id: id, request });
    effect({ event: 'control-request', inputId: input.id, requestId: id, subtype: request.subtype, toolUseId: request.tool_use_id });
  });
}
async function hook(input, event, tool, extra = {}) {
  const entries = hooks[event] ?? [];
  for (const entry of entries) {
    assert.ok(entry.matcher === undefined || entry.matcher === '*', 'wire');
    for (const callback of entry.hookCallbackIds) {
      const result = record(await nativeRequest(input, { subtype: 'hook_callback', callback_id: callback, tool_use_id: tool.id,
        input: { hook_event_name: event, session_id: session, cwd, transcript_path: history,
          permission_mode: options['permission-mode'], tool_name: tool.name, tool_input: tool.input, tool_use_id: tool.id, ...extra } }));
      assert.ok(result.continue !== false && result.decision !== 'block' && result.hookSpecificOutput?.permissionDecision !== 'deny', 'authority');
    }
  }
}
async function interaction(input) {
  const question = input.marker === 'TEST_UI_QUESTION' || input.marker === 'TEST_UI_QUESTION_DECLINE';
  const tool = { id: randomUUID(), type: 'tool_use', name: question ? 'AskUserQuestion' : 'Write', input: question
    ? { questions: [{ question: 'Choose the TEST route', header: 'TEST', multiSelect: false,
      options: [{ label: 'Alpha', description: 'Use the first TEST route' }, { label: 'Beta', description: 'Use the second TEST route' }] }] }
    : { file_path: join(root, 'approved-effect.txt'), content: 'TEST approved effect\n' } };
  assistant(input, [tool]);
  await hook(input, 'PreToolUse', tool);
  const decision = record(await nativeRequest(input, { subtype: 'can_use_tool', tool_name: tool.name, tool_use_id: tool.id, input: tool.input }));
  assert.equal(active, input, 'authority');
  assert.ok(decision.behavior === 'allow' || decision.behavior === 'deny', 'wire');
  let text = question ? 'TEST question declined' : 'TEST approval denied';
  if (decision.behavior === 'allow') {
    const updated = record(decision.updatedInput);
    if (question) {
      assert.deepEqual(updated.questions, tool.input.questions, 'authority');
      const answers = record(updated.answers);
      assert.deepEqual(Object.keys(answers), ['Choose the TEST route'], 'authority');
      assert.ok(['Alpha', 'Beta'].includes(answers['Choose the TEST route']), 'authority');
      text = `TEST question ${answers['Choose the TEST route']}`;
    } else {
      assert.deepEqual(updated, tool.input, 'authority');
      writeFileSync(tool.input.file_path, tool.input.content, { flag: 'wx', mode: 0o600 });
      text = 'TEST approval allowed';
    }
  }
  effect({ event: 'decision', inputId: input.id, marker: input.marker, toolUseId: tool.id, decision: decision.behavior, text });
  const denied = decision.behavior === 'deny';
  await hook(input, denied ? 'PostToolUseFailure' : 'PostToolUse', tool, denied ? { error: 'TEST denied', is_interrupt: false } : { tool_response: { content: text } });
  await hook(input, 'PostToolBatch', tool, { tool_calls: [{ tool_use_id: tool.id, tool_name: tool.name, tool_input: tool.input,
    tool_response: { content: text, is_error: denied } }] });
  send({ type: 'user', ...envelope(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: text, is_error: denied }] } });
  finish(input, text);
}
async function scheduled(input) {
  assert.ok(mcp, 'mcp');
  const call = async (name, args) => {
    assert.equal(active, input, 'authority');
    const result = await mcp.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, 'mcp');
    assert.ok(Array.isArray(result.content) && result.content.length === 1 && result.content[0].type === 'text', 'mcp');
    effect({ event: 'mcp-call', inputId: input.id, name, ...(args.commandId ? { commandId: args.commandId } : {}) });
    return JSON.parse(result.content[0].text);
  };
  const tasks = await call('task_list', { owner: 'alice', status: 'in_progress' });
  assert.ok(Array.isArray(tasks) && tasks.length === 1 && typeof tasks[0].id === 'string' && tasks[0].subject.includes('TEST'), 'mcp');
  const taskId = tasks[0].id;
  const complete = await call('task_complete', { commandId: `TEST-peer-complete-${input.id}`, taskId });
  assert.equal(complete.phase, 'completed', 'mcp');
  const sent = await call('message_send', { commandId: `TEST-peer-message-${input.id}`, to: 'user', text: 'TEST scheduled reply' });
  assert.equal(sent.phase, 'completed', 'mcp');
  effect({ event: 'scheduled', inputId: input.id, taskId }); finish(input, 'TEST scheduled complete');
}
async function initialize(frame) {
  assert.equal(initialized, false, 'wire');
  const request = record(frame.request);
  hooks = request.hooks ?? {};
  assert.ok(Object.keys(hooks).every(name => ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch'].includes(name)), 'wire');
  for (const entries of Object.values(hooks)) for (const entry of entries) {
    assert.ok(Array.isArray(entry.hookCallbackIds) && entry.hookCallbackIds.length <= 8 && entry.hookCallbackIds.every(id => /^hook_\d+$/u.test(id)), 'wire');
  }
  if (teamRuntime) {
    const servers = record(record(JSON.parse(options['mcp-config'])).mcpServers);
    assert.deepEqual(Object.keys(servers), ['team'], 'mcp');
    const selected = record(servers.team), url = new URL(selected.url);
    assert.equal(selected.type, 'http', 'mcp'); assert.equal(url.protocol, 'http:', 'mcp'); assert.equal(url.hostname, '127.0.0.1', 'mcp');
    assert.ok(!url.username && !url.password && !url.hash, 'mcp');
    const headers = record(selected.headers);
    assert.deepEqual(Object.keys(headers), ['Authorization'], 'mcp'); assert.match(headers.Authorization, /^Bearer [^\r\n]+$/u, 'mcp');
    mcp = new Client({ name: 'TEST-Claude-SDK-peer', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    nativeTools = (await mcp.listTools()).tools;
    assert.ok(nativeTools.length > 0 && nativeTools.length <= 256, 'mcp');
    effect({ event: 'mcp-connected', sessionId: session, tools: nativeTools.map(tool => tool.name) });
  }
  initialized = true;
  reply(frame.request_id, { commands, models, agents: [], output_style: 'default', available_output_styles: ['default'],
    account: { apiProvider: 'firstParty', tokenSource: 'TEST-emulated', subscriptionType: 'TEST-emulated' },
    ...(request.hooks ? { hooks_applied: true } : {}) });
  send({ type: 'system', subtype: 'init', ...envelope(), cwd, model: 'TEST-claude-sonnet', tools: (options.tools ?? '').split(',').filter(Boolean),
    mcp_servers: teamRuntime ? [{ name: 'team', status: 'connected' }] : [], permissionMode: options['permission-mode'],
    slash_commands: commands.map(row => row.name), skills: ['test-desktop-skill'], plugins: [], output_style: 'default', apiKeySource: 'none',
    claude_code_version: 'TEST-peer-sdk-0.3.305', capabilities: ['interrupt_receipt_v1'] });
  effect({ event: 'initialized', sessionId: session, restored: Boolean(options.resume), commands: commands.map(row => row.name) });
}
const fail = error => {
  if (failed) return; failed = true; clearTimeout(streamTimer);
  const known = ['environment', 'argv', 'wire', 'limit', 'authority', 'mcp', 'resume', 'input', 'control-timeout'];
  const code = known.includes(error?.message) ? error.message : 'unknown';
  effect({ event: 'failure', code }); process.stderr.write(`TEST Claude peer refused: ${code}\n`);
  process.exit(1);
};
function input(frame) {
  assert.ok(initialized && active === undefined && ++inputCount <= 32, 'input');
  assert.ok(uuid(frame.uuid) && !seenInputs.has(frame.uuid), 'input');
  assert.ok(frame.session_id === session && frame.parent_tool_use_id === null && frame.message?.role === 'user', 'input');
  const content = frame.message.content;
  const raw = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined;
  assert.ok(typeof raw === 'string' && Buffer.byteLength(raw) <= 65536, 'input');
  let text = raw === review ? '/review TEST_UI_REVIEW' : raw;
  if (teamRuntime && text !== '/review TEST_UI_REVIEW' && !text.startsWith('/')) {
    // Original Composer/Task formatting adds complete agent-only envelopes around the user text.
    const visible = raw.replace(/<info_for_agent>\n[\s\S]*?\n<\/info_for_agent>/gu, '');
    assert.ok(!visible.includes('<info_for_agent') && !visible.includes('</info_for_agent'), 'input');
    const markers = visible.match(/\bTEST_UI_[A-Z_]+\b/gu);
    assert.equal(markers?.length, 1, 'input');
    assert.ok(visible.split('\n').some(line => line.trim() === markers[0]), 'input');
    text = markers[0];
  }
  const probe = 'Reply only OK. Do not use tools, access files or run commands.';
  const allowed = finite ? [probe] : standalone ? ['TEST_UI_STANDALONE_DONE', 'TEST_UI_STANDALONE_HOLD']
    : ['TEST_UI_BOOT', 'TEST_UI_STREAM', 'TEST_UI_HOLD', 'TEST_UI_RESUME', 'TEST_UI_APPROVAL_ALLOW', 'TEST_UI_APPROVAL_DENY',
      'TEST_UI_QUESTION', 'TEST_UI_QUESTION_DECLINE', 'TEST_UI_SCHEDULE_DONE', 'TEST_UI_SCHEDULE_HOLD',
      '/compact', '/cost', '/usage', '/test-desktop-skill', '/review TEST_UI_REVIEW'];
  assert.ok(allowed.includes(text), 'input');
  if (text === 'TEST_UI_RESUME') assert.ok(teamRuntime && options.resume && resumedHistory?.bootRetained, 'resume');
  assert.ok(text !== '/review TEST_UI_REVIEW' || raw === review, 'input');
  if (standalone) assert.equal(inputCount, 1, 'input');
  seenInputs.add(frame.uuid); active = { id: frame.uuid, marker: text, messageId: randomUUID() };
  const selected = active;
  remember('user', selected.id, raw);
  effect({ event: 'input', inputId: selected.id, marker: text === probe ? 'TEST_MODEL_PROBE' : text, sessionId: session, wrapped: raw !== text });
  if (text === 'TEST_UI_STREAM') {
    partial(selected, 'TEST stream partial');
    const wait = () => {
      if (active !== selected || failed) return;
      const path = join(root, 'release-stream');
      if (existsSync(path)) {
        assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'authority');
        finish(selected, 'TEST stream partial complete');
      } else streamTimer = setTimeout(() => { try { wait(); } catch (error) { fail(error); } }, 20);
    };
    wait();
  } else if (text === 'TEST_UI_HOLD' || text === 'TEST_UI_SCHEDULE_HOLD' || text === 'TEST_UI_STANDALONE_HOLD') partial(selected, 'TEST held partial');
  else if (text.startsWith('TEST_UI_APPROVAL_') || text === 'TEST_UI_QUESTION' || text === 'TEST_UI_QUESTION_DECLINE') void interaction(selected).catch(fail);
  else if (text === 'TEST_UI_SCHEDULE_DONE') void scheduled(selected).catch(fail);
  else if (text === '/compact') {
    send({ type: 'system', subtype: 'compact_boundary', ...envelope(selected), compact_metadata: { trigger: 'manual', pre_tokens: 42, post_tokens: 12 } });
    effect({ event: 'compact', inputId: selected.id }); finish(selected, 'TEST context compacted', { localCommand: 'compact' });
  } else if (text === '/cost' || text === '/usage')
    finish(selected, 'TEST cost input=' + resultCount * 42 + ' output=' + resultCount * 18 + ' total=$' + (resultCount * 0.0123).toFixed(4), { localCommand: 'usage' });
  else finish(selected, text === probe ? 'OK' : text === '/test-desktop-skill' ? 'TEST skill complete'
    : text === '/review TEST_UI_REVIEW' ? 'TEST review complete'
      : text === 'TEST_UI_STANDALONE_DONE' ? 'TEST standalone complete'
        : text === 'TEST_UI_RESUME' ? 'TEST resumed history retained' : 'TEST boot ready');
}
async function accept(frame) {
  record(frame);
  if (frame.type === 'user') return input(frame);
  if (frame.type === 'control_response') {
    const response = record(frame.response), request = pending.get(response.request_id);
    assert.ok(request && response.subtype === 'success' && request.input === active, 'wire');
    pending.delete(response.request_id); clearTimeout(request.timer); request.resolve(record(response.response)); return;
  }
  assert.equal(frame.type, 'control_request', 'wire'); assert.ok(typeof frame.request_id === 'string' && frame.request_id.length <= 256, 'wire');
  const request = record(frame.request);
  if (request.subtype === 'initialize') return initialize(frame);
  assert.equal(initialized, true, 'wire');
  if (request.subtype === 'mcp_status') return reply(frame.request_id, { mcpServers: teamRuntime
    ? [{ name: 'team', status: 'connected', tools: nativeTools.map(tool => ({ name: tool.name, description: tool.description })) }] : [] });
  assert.equal(request.subtype, 'interrupt', 'wire');
  assert.ok(active && ['TEST_UI_HOLD', 'TEST_UI_SCHEDULE_HOLD', 'TEST_UI_STANDALONE_HOLD', 'TEST_UI_STREAM'].includes(active.marker) && pending.size === 0, 'authority');
  effect({ event: 'interrupt', inputId: active.id, requestId: frame.request_id });
  reply(frame.request_id, { still_queued: [] }); finish(active, 'TEST input interrupted', { interrupted: true });
}
effect({ event: 'launch', parentPid: process.ppid, sessionId: session, restored: Boolean(options.resume) });
effect({ event: 'started', sessionId: session, restored: Boolean(options.resume), ...(resumedHistory ? { resumedHistory } : {}) });
let buffer = '', inputBytes = 0, chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  try {
    inputBytes += Buffer.byteLength(chunk); buffer += chunk;
    assert.ok(inputBytes <= 2 * 1024 * 1024 && Buffer.byteLength(buffer) <= 256 * 1024, 'limit');
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
      const frame = JSON.parse(line); chain = chain.then(() => accept(frame)); void chain.catch(fail);
    }
  } catch (error) { fail(error); }
});
process.stdin.on('end', () => { void chain.then(async () => {
  assert.equal(buffer.length, 0, 'wire'); clearTimeout(streamTimer); effect({ event: 'stdin-ended', active: Boolean(active) });
  await mcp?.close(); process.exit(0);
}).catch(fail); });
// The original Host/SDK process owner performs Stop. This peer never signals a PID or another process.
process.on('exit', code => { effect({ event: 'exited', code }); });
