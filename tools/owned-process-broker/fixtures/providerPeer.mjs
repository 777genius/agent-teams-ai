/** TEST protocol peer only. The real Host/D and native Job own every child in this fixture. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
const hostRequire = createRequire(new URL('../../../packages/legacy-agent-host/package.json', import.meta.url));
const { Client } = await import(pathToFileURL(hostRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(hostRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);

if (process.env.TEST_EMULATED_DESKTOP_PROVIDER !== undefined) {
  assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
  assert.equal(process.env.TEST_EMULATED_WINDOWS_PROVIDER, undefined);
  const helper = new URL('./providerDesktopPeer.mjs', import.meta.url);
  const path = fileURLToPath(helper);
  assert.equal(realpathSync(path), path, 'Only the original pinned TEST helper');
  assert.match(process.env.TEST_PEER_HELPER_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), process.env.TEST_PEER_HELPER_SHA256);
  await import(helper.href);
} else {
assert.equal(process.env.TEST_EMULATED_WINDOWS_PROVIDER, '1');
const provider = process.env.TEST_PEER_PROVIDER;
assert.ok(provider === 'codex' || provider === 'opencode');
const fixture = process.env.TEST_PROCESS_FIXTURE;
const proof = process.env.TEST_PEER_EFFECTS;
assert.ok(fixture && proof);
const record = value => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value; };
const effect = value => appendFileSync(proof, JSON.stringify(value) + '\n');
const options = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) if (argv[index] === '-c') {
  const value = argv[++index], separator = value.indexOf('=');
  options[value.slice(0, separator)] = JSON.parse(value.slice(separator + 1));
}
const config = provider === 'opencode' ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : undefined;
const mcpName = provider === 'opencode' ? Object.keys(record(config.mcp))[0] : 'team';
const endpoint = provider === 'opencode' ? config.mcp[mcpName].url : options['mcp_servers.team.url'];
const authorization = provider === 'opencode' ? config.mcp[mcpName].headers.Authorization
  : `Bearer ${process.env[options['mcp_servers.team.bearer_token_env_var']]}`;
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const mcp = new Client({ name: 'TEST-Windows-provider-peer', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization } },
}));
const tools = (await mcp.listTools()).tools;
assert.ok(tools.some(tool => tool.name === 'process_register'));
effect({ event: 'connected', provider, pid: process.pid, tools: tools.map(tool => tool.name) });

let inputs = 0;
async function registerServices() {
  assert.equal(++inputs, 1, 'Only one original fixture input');
  const services = [];
  for (const label of ['TEST-primary', 'TEST-neighbor']) {
    assert.equal(createHash('sha256').update(readFileSync(fixture)).digest('hex'), process.env.TEST_PROCESS_FIXTURE_SHA256);
    const child = spawn(fixture, ['leaf'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    assert.ok(child.pid);
    child.once('exit', code => effect({ event: 'service-exit', label, pid: child.pid, code }));
    const result = await mcp.callTool({ name: 'process_register',
      arguments: { commandId: `TEST-register-${label}`, pid: child.pid, label } });
    assert.notEqual(result.isError, true);
    const receipt = JSON.parse(result.content[0].text);
    assert.equal(receipt.operation, 'register'); assert.equal(receipt.phase, 'completed');
    assert.equal(receipt.result.pid, child.pid);
    services.push({ label, pid: child.pid, processRef: receipt.result.processRef });
  }
  effect({ event: 'registered', services });
}

const fail = error => { effect({ event: 'failure', code: error instanceof assert.AssertionError ? 'assertion' : 'unknown' });
  process.exitCode = 1; };

if (provider === 'codex') {
  const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
  const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\n');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => { void (async () => {
    const frame = JSON.parse(line);
    if (frame.id === undefined) return;
    let result;
    if (frame.method === 'initialize' || frame.method === 'turn/interrupt') result = {};
    else if (frame.method === 'config/read') result = { config: { features: { apps: false } } };
    else if (frame.method === 'thread/start') result = { thread: { id: 'TEST-thread' } };
    else if (frame.method === 'mcpServerStatus/list') result = { data: [{ name: 'team',
      authStatus: 'bearerToken', runtimeStatus: 'connected', toolsError: null, resources: [],
      resourceTemplates: [], tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }], nextCursor: null };
    else if (frame.method === 'turn/start') {
      reply(frame.id, { turn: { id: 'TEST-turn' } });
      await registerServices();
      notify('item/completed', { threadId: 'TEST-thread', turnId: 'TEST-turn',
        item: { id: 'TEST-message', type: 'agentMessage', text: 'TEST registered both services' } });
      notify('turn/completed', { threadId: 'TEST-thread', turn: { id: 'TEST-turn', status: 'completed' } });
      return;
    } else throw new Error('TEST unexpected Codex request');
    reply(frame.id, result);
  })().catch(fail); });
  lines.on('close', () => { void mcp.close().then(() => process.exit(process.exitCode ?? 0)); });
} else {
  const sessionId = 'ses_TESTowned', messages = [];
  const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value)); };
  const server = createServer((request, response) => { void (async () => {
    assert.equal(request.headers.authorization,
      'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64'));
    assert.equal(request.headers['x-opencode-directory'], process.cwd());
    const url = new URL(request.url, 'http://127.0.0.1');
    let input;
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }
    if (request.method === 'POST' && url.pathname === '/session')
      return json(response, { id: sessionId, directory: process.cwd(), version: '1.18.35' });
    if (request.method === 'POST' && url.pathname === `/session/${sessionId}/prompt_async`) {
      assert.equal(messages.length, 0);
      const userId = input.messageID, assistantId = 'msg_' + userId.slice(4, 16) + 'T'.repeat(14);
      const time = Date.now();
      messages.push({ info: { id: userId, role: 'user', sessionID: sessionId, time: { created: time } },
        parts: input.parts.map((part, index) => ({ ...part, id: `prt_user${index}`, sessionID: sessionId, messageID: userId })) });
      response.writeHead(204); response.end();
      await registerServices();
      messages.push({ info: { id: assistantId, parentID: userId, role: 'assistant', sessionID: sessionId,
        providerID: 'TEST-provider', modelID: 'TEST-model', finish: 'stop',
        time: { created: time + 1, completed: Date.now() } },
        parts: [{ id: 'prt_reply', sessionID: sessionId, messageID: assistantId,
          type: 'text', text: 'TEST registered both services' }] });
      return;
    }
    if (request.method === 'POST' && url.pathname === `/session/${sessionId}/abort`) return json(response, true);
    assert.equal(request.method, 'GET');
    if (url.pathname === '/config') return json(response, config);
    if (url.pathname === '/agent') return json(response, [{ name: 'build', mode: 'primary' }]);
    if (url.pathname === '/config/providers') return json(response,
      { providers: [{ id: 'TEST-provider', models: { 'TEST-model': {} } }] });
    if (url.pathname === '/mcp') return json(response, { [mcpName]: { status: 'connected' } });
    if (url.pathname === `/session/${sessionId}`) return json(response,
      { id: sessionId, directory: process.cwd(), version: '1.18.35' });
    if (url.pathname === `/session/${sessionId}/message`) return json(response, messages);
    if (url.pathname === '/session/status') return json(response,
      { [sessionId]: { type: inputs && messages.length < 2 ? 'busy' : 'idle' } });
    if (url.pathname === '/permission' || url.pathname === '/question') return json(response, []);
    throw new Error('TEST unexpected OpenCode route');
  })().catch(error => { if (!response.headersSent) json(response, { error: 'TEST refusal' }, 500);
    else response.end(); fail(error); }); });
  const port = Number(argv[argv.indexOf('--port') + 1]);
  assert.ok(port > 0 && port <= 65535);
  server.listen(port, '127.0.0.1');
}
}
