/** TEST-only stdio MCP actor. Only the actual native engine starts it and calls its tool. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

const [logPath, effectPath, nonce, server, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.ok(logPath && effectPath && isAbsolute(logPath) && isAbsolute(effectPath));
assert.match(nonce ?? '', /^[a-f0-9-]{36}$/);
assert.ok(server === 'selected' || server === 'excluded');
assert.equal(process.env.TEST_MCP_NONCE, nonce);
assert.equal(process.version, 'v24.21.0');
const instanceId = randomUUID();
assert.ok(process.platform === 'linux' || process.platform === 'darwin');
let birth = {};
if (process.platform === 'linux') {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
  assert.match(startTicks ?? '', /^\d+$/);
  birth = { startTicks };
}
// Desktop captures Darwin birth/ancestry through its existing read-only processFacts observer.
const identity = { server, instanceId, pid: process.pid, ...birth };
const log = (event, detail = {}) => appendFileSync(logPath,
  JSON.stringify({ ...identity, event, ...detail }) + '\n', { mode: 0o600 });
log('started');
let finished = false;
const finish = (reason) => {
  if (finished) return;
  finished = true;
  log('closed', { reason });
  process.exit(0);
};
process.on('SIGTERM', () => finish('SIGTERM'));
process.on('SIGINT', () => finish('SIGINT'));
process.stdin.once('end', () => finish('stdin-eof'));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let messages = 0, calls = 0;
for await (const line of lines) {
  assert.ok(++messages <= 64 && Buffer.byteLength(line) <= 64 * 1024);
  const request = JSON.parse(line);
  assert.equal(request.jsonrpc, '2.0');
  if (request.id === undefined) continue;
  assert.ok(typeof request.id === 'string' || typeof request.id === 'number');
  let result;
  if (request.method === 'initialize') {
    assert.equal(typeof request.params?.protocolVersion, 'string');
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'TEST-captured-external-mcp', version: '1.0.0' } };
  } else if (request.method === 'ping') {
    result = {};
  } else if (request.method === 'tools/list') {
    log('listed');
    result = { tools: [{ name: 'write_marker',
      description: 'Write the one captured TEST MCP effect and return its original instance.',
      inputSchema: { type: 'object', properties: { nonce: { type: 'string' } },
        required: ['nonce'], additionalProperties: false } }] };
  } else if (request.method === 'tools/call') {
    assert.equal(server, 'selected', 'unselected server must never execute');
    assert.equal(++calls, 1, 'one original native call, never a replay');
    assert.equal(request.params?.name, 'write_marker');
    assert.deepEqual(request.params.arguments, { nonce });
    writeFileSync(effectPath, JSON.stringify({ ...identity, nonce }) + '\n',
      { mode: 0o600, flag: 'wx' });
    log('called');
    result = { content: [{ type: 'text',
      text: 'TEST_EXTERNAL_MCP_EFFECT:' + nonce + ':' + instanceId }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'TEST method unavailable' } }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
finish('readline-closed');
