import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { startTeamMcpEndpoint, TEAM_MCP_CATALOG_DISPOSITION } from '../dist/mcp/index.js';

import type { TeamMcpConnection, TeamMcpEndpoint } from '../dist/mcp/index.js';
import type { CommandReceipt, DeliveryBinding } from '../dist/team/contracts.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-mcp' };
  const delivery: DeliveryBinding = { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' };
  const owner = createFilesystemTeamOwner({
    root, binding,
    members: [
      { memberId: 'lead-id', name: 'lead', role: 'lead' },
      { memberId: 'alice-id', name: 'alice', role: 'member', delivery },
      { memberId: 'bob-id', name: 'bob', role: 'member', delivery: { ...delivery, memberId: 'bob-id' } },
    ],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
      { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] },
      { principalId: 'bob-session', memberName: 'bob', permissions: ['read', 'task.write', 'message.write'] },
    ],
  });
  let current = { ...delivery };
  let now = 1000;
  const endpoints: TeamMcpEndpoint[] = [];
  t.after(async () => { await Promise.all(endpoints.map((endpoint) => endpoint.close())); });
  return {
    root, owner, binding, delivery,
    human: owner.connect('human'), alice: owner.connect('alice-session'),
    current: (value: DeliveryBinding) => { current = value; },
    now: (value: number) => { now = value; },
    async endpoint(principal = 'alice-session', memberBinding = delivery, connection?: TeamMcpConnection) {
      const endpoint = await startTeamMcpEndpoint({
        connection: connection ?? owner.connect(principal), binding: memberBinding, expiresAtMs: 2000,
        now: () => now,
        isCurrentBinding: (captured) => Object.entries(captured).every(([key, value]) =>
          current[key as keyof DeliveryBinding] === value),
      });
      endpoints.push(endpoint);
      return endpoint;
    },
    commands() {
      try { return readdirSync(join(root, 'teams', binding.teamName, '.host-owner', 'commands')).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
    taskBytes(id: string) { return readFileSync(join(root, 'tasks', binding.teamName, `${id}.json`), 'utf8'); },
    inbox(member: string) {
      return JSON.parse(readFileSync(join(root, 'teams', binding.teamName, 'inboxes', `${member}.json`), 'utf8')) as {
        from: string; text: string; messageId: string;
      }[];
    },
  };
}

async function connect(t: TestContext, endpoint: TeamMcpEndpoint, token = endpoint.bearerToken) {
  const client = new Client({ name: 'TEST-native-mcp-client', version: '1' });
  t.after(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(response.content));
  const block = response.content[0] as { text?: unknown };
  assert.equal(typeof block?.text, 'string');
  const value: unknown = JSON.parse(block.text as string);
  return { response, value };
}

async function receipt(client: Client, name: string, args: Record<string, unknown>) {
  const result = await call(client, name, args);
  assert.ok(result.value && typeof result.value === 'object' && 'phase' in result.value);
  return { ...result, value: result.value as CommandReceipt };
}

async function post(endpoint: TeamMcpEndpoint, bearerToken = endpoint.bearerToken, url = endpoint.url) {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'test-read', method: 'tools/call',
      params: { name: 'task_list', arguments: {} } }),
  });
}

test('real HTTP MCP mutations share the real Team receipt/files; reads create no command ledger entries', async (t) => {
  const f = fixture(t);
  const endpoint = await f.endpoint();
  const client = await connect(t, endpoint);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'task_create'));
  assert.ok(listed.tools.some((tool) => tool.name === 'command_lookup'));
  const args = { commandId: 'stable-create', subject: 'Task via actual MCP', owner: 'alice' };
  const first = await receipt(client, 'task_create', args);
  assert.equal(first.value.phase, 'completed');
  assert.equal(first.value.principalId, 'alice-session');
  const taskId = first.value.effects.taskId;
  const before = f.taskBytes(taskId);
  assert.deepEqual((await receipt(client, 'task_create', args)).value, first.value);
  assert.equal(f.taskBytes(taskId), before);
  assert.equal(f.human.listTasks().length, 1);
  const conflict = await call(client, 'task_create', { ...args, subject: 'Changed intent must conflict' });
  assert.equal(conflict.response.isError, true);
  assert.deepEqual(conflict.value, { error: { code: 'conflict' } });
  assert.equal(f.taskBytes(taskId), before);
  const commandsBeforeRead = f.commands();
  assert.deepEqual((await call(client, 'command_lookup', { commandId: 'stable-create' })).value, first.value);
  assert.equal((await call(client, 'command_lookup', { commandId: 'never-dispatched' })).value, null);
  assert.equal(((await call(client, 'task_get', { taskId })).value as { id: string }).id, taskId);
  assert.equal(((await call(client, 'task_list')).value as unknown[]).length, 1);
  assert.deepEqual(f.commands(), commandsBeforeRead);
  const second = await receipt(client, 'task_create', { ...args, commandId: 'independent-intent' });
  assert.notEqual(second.value.effects.taskId, taskId);
  assert.equal(f.human.listTasks().length, 2, 'same text with distinct stable IDs is not deduplicated');
  assert.ok(!JSON.stringify(client.getServerVersion()).includes(endpoint.bearerToken));
  assert.ok(!client.getInstructions()?.includes(endpoint.bearerToken));
});

test('captured actor drives lifecycle/comment/assignment; wrong actor cannot start another member task', async (t) => {
  const f = fixture(t);
  const alice = await connect(t, await f.endpoint());
  const created = await receipt(alice, 'task_create', {
    commandId: 'life-create', subject: 'Owner-scoped lifecycle', owner: 'alice',
  });
  const taskId = created.value.effects.taskId;
  const bobBinding = { ...f.delivery, memberId: 'bob-id' };
  f.current(bobBinding);
  const bob = await connect(t, await f.endpoint('bob-session', bobBinding));
  const before = f.taskBytes(taskId);
  const wrongActor = await receipt(bob, 'task_start', { commandId: 'bob-wrong-start', taskId });
  assert.equal(wrongActor.response.isError, true);
  assert.equal(wrongActor.value.phase, 'rejected');
  assert.equal(f.taskBytes(taskId), before);
  f.current(f.delivery);
  assert.equal((await receipt(alice, 'task_start', { commandId: 'alice-start', taskId })).value.phase, 'completed');
  const comment = { commandId: 'alice-comment', taskId, text: 'Actual comment with reference',
    taskRefs: [{ taskId, displayId: '1234abcd', teamName: f.binding.teamName }] };
  await receipt(alice, 'task_add_comment', comment);
  await receipt(alice, 'task_add_comment', comment);
  const taskAfter = f.human.getTask(taskId);
  assert.equal((taskAfter.comments as unknown[]).length, 1);
  assert.equal((taskAfter.comments as { author: string }[])[0]?.author, 'alice');
  assert.equal((await receipt(alice, 'task_complete', { commandId: 'alice-complete', taskId })).value.phase, 'completed');
  await receipt(alice, 'task_update', { commandId: 'alice-update', taskId, description: '' });
  await receipt(alice, 'task_set_owner', { commandId: 'alice-handoff', taskId, owner: 'bob' });
  assert.equal(f.human.getTask(taskId).owner, 'bob');
});

test('message_send persists authenticated sender and exact IDs once; native delivery remains pending', async (t) => {
  const f = fixture(t);
  const client = await connect(t, await f.endpoint());
  const message = { commandId: 'to-bob', to: 'bob', text: 'Persisted for Bob' };
  const sent = await receipt(client, 'message_send', message);
  assert.equal(sent.value.phase, 'completed');
  await receipt(client, 'message_send', message);
  const delivered = f.inbox('bob').filter((row) => row.messageId === sent.value.effects.messageId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.from, 'alice');
  assert.equal(f.alice.pendingDeliveries().length, 1);
  assert.equal(f.alice.pendingDeliveries()[0]?.phase, 'pending');
  const reply = await receipt(client, 'message_send', { commandId: 'reply-human', to: 'user', text: 'Visible reply' });
  assert.equal(reply.value.phase, 'completed');
  assert.equal(f.inbox('user')[0]?.from, 'alice');
  assert.equal(f.alice.pendingDeliveries().length, 1, 'human inbox does not create a native input');
});

test('strict schemas reject authority overrides, missing command IDs and unsupported groups before effects', async (t) => {
  const f = fixture(t);
  const client = await connect(t, await f.endpoint());
  for (const key of ['teamName', 'claudeDir', 'from', 'actor', 'backendId', 'teamId', 'runId', 'memberId',
    'generation', 'principalId', 'controlUrl']) {
    const attempted = await call(client, 'task_create', {
      commandId: `forged-${key}`, subject: 'must not appear in errors', [key]: '/private/SECRET-path',
    });
    assert.equal(attempted.response.isError, true);
    assert.deepEqual(attempted.value, { error: { code: 'invalid' } });
  }
  assert.deepEqual((await call(client, 'task_create', { subject: 'No identity' })).value,
    { error: { code: 'invalid' } });
  assert.deepEqual((await call(client, 'review_approve', { commandId: 'not-implemented' })).value,
    { error: { code: 'unsupported' } });
  assert.deepEqual((await call(client, 'TaskList')).value, { error: { code: 'unsupported' } },
    'native task namespace has no equivalent product inventory alias');
  assert.equal(f.human.listTasks().length, 0);
  assert.deepEqual(f.commands(), []);
  assert.equal(Object.keys(TEAM_MCP_CATALOG_DISPOSITION).length, 10);
  for (const group of ['team', 'lead', 'kanban', 'review', 'process', 'runtime', 'workSync', 'crossTeam'] as const)
    assert.ok(TEAM_MCP_CATALOG_DISPOSITION[group].startsWith('pending-'));
});

test('actual MCP HTTP authentication rejects wrong/missing bearer and cross-endpoint capabilities', async (t) => {
  const f = fixture(t);
  const a = await f.endpoint();
  const b = await f.endpoint();
  await connect(t, a);
  const denied = new Client({ name: 'TEST-wrong-bearer', version: '1' });
  t.after(() => denied.close());
  await assert.rejects(denied.connect(new StreamableHTTPClientTransport(new URL(a.url), {
    requestInit: { headers: { authorization: 'Bearer incorrect' } },
  }) as Transport));
  for (const token of ['', 'incorrect', b.bearerToken]) {
    const response = await post(a, token);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: 'forbidden' } });
  }
  const health = await fetch(new URL('/health', a.url));
  assert.equal(health.status, 404, 'localhost/health is not authorization');
  assert.equal((await post(a, a.bearerToken, new URL('/mcp/guessed-route', a.url).href)).status, 404);
  assert.equal(f.alice.listTasks().length, 0, 'Team read grant still exists independently');
  assert.deepEqual(f.commands(), []);
});

test('run/member/generation/backend scope, expiry and endpoint revocation are independent of Team grants', async (t) => {
  const f = fixture(t);
  const endpoint = await f.endpoint();
  const client = await connect(t, endpoint);
  for (const key of ['backendId', 'teamId', 'teamName', 'runId', 'memberId', 'generation'] as const) {
    f.current({ ...f.delivery, [key]: 'different-current-binding' });
    await assert.rejects(client.callTool({ name: 'task_list', arguments: {} }));
    assert.equal((await post(endpoint)).status, 401, key);
    assert.equal(f.alice.listTasks().length, 0);
  }
  f.current(f.delivery);
  f.now(2000);
  assert.equal((await post(endpoint)).status, 401, 'expiry is enforced without Team revocation');
  f.now(1000);
  assert.equal((await post(endpoint)).status, 200);
  endpoint.revoke();
  assert.equal((await post(endpoint)).status, 401);
  assert.equal(f.alice.listTasks().length, 0);
  await endpoint.close();
  await endpoint.close();
  await assert.rejects(post(endpoint));
});

test('revoked current Team grants deny completed replay/lookup/read/new intent on the same authenticated HTTP capability', async (t) => {
  const f = fixture(t);
  const client = await connect(t, await f.endpoint());
  const args = { commandId: 'before-revoke', subject: 'Protected result', owner: 'alice' };
  const created = await receipt(client, 'task_create', args);
  const before = f.taskBytes(created.value.effects.taskId);
  f.human.revoke('alice-session');
  for (const [tool, payload] of [
    ['task_create', args], ['task_create', { ...args, commandId: 'after-revoke' }],
    ['command_lookup', { commandId: args.commandId }], ['task_list', {}],
  ] as const) {
    const denied = await call(client, tool, payload);
    assert.equal(denied.response.isError, true);
    assert.deepEqual(denied.value, { error: { code: 'forbidden' } });
  }
  assert.equal(f.taskBytes(created.value.effects.taskId), before);
  assert.equal(f.commands().length, 1);
});

test('generation is checked again at tool dispatch after authenticated request/body admission', async (t) => {
  const f = fixture(t);
  let checks = 0;
  const endpoint = await startTeamMcpEndpoint({
    connection: f.alice, binding: f.delivery, expiresAtMs: Date.now() + 60_000,
    isCurrentBinding: () => ++checks < 3,
  });
  t.after(() => endpoint.close());
  // Request authentication and parsed-body admission still succeed. Generation
  // changes before the actual SDK tool handler gets to its owner use case. Use
  // one POST so background SDK GET/initialized requests cannot advance the clock.
  const response = await fetch(endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.bearerToken}`,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'generation-race', method: 'tools/call',
      params: { name: 'task_create', arguments: {
        commandId: 'stale-at-tool-dispatch', subject: 'Must not mutate after generation changes',
      } } }),
  });
  assert.equal(response.status, 200);
  const denied = await response.json() as { result: { isError: boolean; structuredContent: unknown } };
  assert.equal(denied.result.isError, true);
  assert.deepEqual(denied.result.structuredContent, { error: { code: 'forbidden' } });
  assert.equal(f.alice.listTasks().length, 0);
  assert.deepEqual(f.commands(), []);
});

test('unexpected owner errors are redacted and request bytes are bounded before SDK parsing', async (t) => {
  const f = fixture(t);
  const connection = { ...f.alice,
    execute: () => { throw new Error('SECRET-provider-token /private/credentials actual raw payload'); },
  };
  const endpoint = await f.endpoint('alice-session', f.delivery, connection);
  const client = await connect(t, endpoint);
  const result = await call(client, 'task_create', { commandId: 'failed', subject: 'No raw exception' });
  assert.equal(result.response.isError, true);
  assert.deepEqual(result.value, { error: { code: 'internal' } });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'bounded-read', method: 'tools/call',
    params: { name: 'task_list', arguments: {} } }).padEnd(64 * 1024, ' ');
  const options = { method: 'POST', headers: { authorization: `Bearer ${endpoint.bearerToken}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' } };
  const atLimit = await fetch(endpoint.url, { ...options, body });
  assert.equal(atLimit.status, 200);
  await atLimit.arrayBuffer();
  const response = await fetch(endpoint.url, { ...options, body: body + ' ' });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: { code: 'request-limit' } });
  assert.deepEqual(f.commands(), []);
});
