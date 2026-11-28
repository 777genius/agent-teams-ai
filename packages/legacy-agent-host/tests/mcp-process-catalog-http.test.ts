import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { startTeamMcpEndpoint } from '../dist/mcp/index.js';
import { digest } from '../dist/team/identity.js';
import type { TeamMcpConnection } from '../dist/mcp/index.js';
import type { TeamProcessRow, TeamProcessView } from '../dist/process/registeredProcessContracts.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const rows = Array.from({ length: 100 }, (_, index) => ({
  id: 'TEST-http-process-' + index,
  pid: 2000 + index,
  label: 'TEST retained process',
  registeredAt: '2026-11-28T00:00:00.000Z',
  processRef: 'p1:TEST:' + index.toString(16).padStart(64, '0'),
  command: 'x'.repeat(4096),
  observation: 'metadata-stopped' as const,
  canTerminate: false,
}));

test('real authenticated HTTP MCP reconstructs the catalog and confirms unregister across cold replay', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-process-mcp-http-')));
  const clients: Client[] = [];
  const endpoints: Awaited<ReturnType<typeof startTeamMcpEndpoint>>[] = [];
  t.after(async () => {
    const closedClients = await Promise.allSettled(clients.map(client => client.close()));
    const closedEndpoints = await Promise.allSettled(endpoints.map(endpoint => endpoint.close()));
    rmSync(root, { recursive: true, force: true });
    for (const closed of [...closedClients, ...closedEndpoints])
      assert.equal(closed.status, 'fulfilled', 'every TEST HTTP resource closes');
  });
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-process-mcp' };
  const delivery = { ...binding, runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
  const owner = createFilesystemTeamOwner({
    root, binding,
    members: [{ memberId: 'TEST-lead', name: 'lead', role: 'lead' },
      { memberId: 'TEST-member', name: 'alice', role: 'member', delivery }],
    grants: [{ principalId: 'alice', memberName: 'alice',
      permissions: ['read', 'process.write'] }],
  });
  const registrar = owner.processCommands('alice', { registrar: () => delivery });
  for (const [index, row] of rows.entries()) {
    assert.equal(registrar.register('TEST-register-' + index, {
      pid: row.pid, label: row.label, command: row.command,
      port: 10000 + index, url: 'http://127.0.0.1:' + (10000 + index),
    }).phase, 'completed');
  }
  const originalPort = owner.processCommands('alice');
  const expected = originalPort.list();
  assert.equal(expected.length, rows.length);
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 256 * 1024);
  let reads = 0;
  const processPort: NonNullable<TeamMcpConnection['process']> = {
    list: () => { reads++; return originalPort.list(); },
    register: async () => { throw new Error('Unexpected native register'); },
    metadata: async (commandId, operation, selector) => originalPort.metadata(commandId, operation, selector),
    lookup: commandId => originalPort.lookup(commandId),
  };
  async function connect(capturedOwner: typeof owner, process: NonNullable<TeamMcpConnection['process']>) {
    const endpoint = await startTeamMcpEndpoint({
      connection: { ...capturedOwner.connect('alice'), process },
      binding: delivery, expiresAtMs: 10_000,
      now: () => 1000,
      isCurrentBinding: () => true,
    });
    endpoints.push(endpoint);
    const client = new Client({ name: 'TEST-process-page-reader', version: '1' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { authorization: 'Bearer ' + endpoint.bearerToken } },
    });
    await client.connect(transport as Transport);
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const response = CallToolResultSchema.parse(await client.callTool({
      name, arguments: args,
    }));
    const item = response.content[0];
    assert.ok(item?.type === 'text');
    assert.ok(Buffer.byteLength(item.text) <= 256 * 1024);
    return { response, value: JSON.parse(item.text) as unknown };
  }
  async function completeCatalog(client: Client, expectedRows: TeamProcessView[]) {
    const collected: unknown[] = [], cursors = new Set<string>();
    let cursor: string | undefined, revision: string | undefined, count = 0;
    do {
      const { response, value } = await call(client, 'process_list', cursor === undefined ? {} : { cursor });
      assert.notEqual(response.isError, true);
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      const page = value as { kind: string; processes: unknown[]; total: number;
        revision: string; nextCursor: string | null };
      assert.equal(page.kind, 'process-catalog-page');
      assert.equal(page.total, expectedRows.length);
      assert.match(page.revision, /^[a-f0-9]{64}$/);
      if (revision !== undefined) assert.equal(page.revision, revision);
      revision = page.revision;
      assert.ok(Array.isArray(page.processes) && page.processes.length > 0);
      collected.push(...page.processes);
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) {
        assert.equal(cursors.has(cursor), false);
        cursors.add(cursor);
      }
      assert.ok(++count < 128);
    } while (cursor);
    assert.ok(count > 1);
    assert.deepEqual(collected, expectedRows);
    return count;
  }
  const client = await connect(owner, processPort);
  const initialPages = await completeCatalog(client, expected);
  assert.equal(reads, initialPages, 'every continuation uses original authenticated process port');

  const registryPath = join(root, 'teams', binding.teamName, 'processes.json');
  const canonical = createRequire(import.meta.url)('agent-teams-controller/src/internal/processStore.js') as {
    unregisterProcess(paths: { processesPath: string }, selector: { id: string } | { pid: number }): TeamProcessRow[];
  };
  const unregister = canonical.unregisterProcess;
  let removals = 0;
  t.mock.method(canonical, 'unregisterProcess', (paths: { processesPath: string }, selector: { id: string } | { pid: number }) => {
    assert.equal(paths.processesPath, registryPath);
    removals++;
    return unregister(paths, selector);
  });
  const commandId = 'TEST-http-unregister', args = { commandId, id: expected[0]!.id };
  const acknowledgement = { commandId, operation: 'unregister', phase: 'completed',
    state: { phase: 'completed', native: 'not-requested' }, resultOmitted: true };
  const removed = await call(client, 'process_unregister', args);
  assert.notEqual(removed.response.isError, true);
  assert.deepEqual(removed.value, acknowledgement);
  assert.equal(removals, 1, 'the actual canonical policy performs the original removal once');
  const receiptPath = join(root, 'teams', binding.teamName, '.host-owner', 'commands', digest(commandId) + '.json');
  const receiptBytes = readFileSync(receiptPath), registryBytes = readFileSync(registryPath);
  const receipt = JSON.parse(receiptBytes.toString('utf8')) as { phase: string; selected: { id: string }[] };
  assert.equal(receipt.phase, 'completed');
  assert.deepEqual(receipt.selected.map(row => row.id), [expected[0]!.id]);
  const remaining = expected.slice(1);
  await completeCatalog(client, remaining);
  const cold = createFilesystemTeamOwner({ root, binding, members: [], grants: [] });
  const coldClient = await connect(cold, cold.processCommands('alice'));
  for (const current of [client, coldClient]) {
    for (const [name, arguments_] of [
      ['process_lookup', { commandId }], ['process_unregister', args],
    ] as const) {
      const repeated = await call(current, name, arguments_);
      assert.notEqual(repeated.response.isError, true);
      assert.deepEqual(repeated.value, acknowledgement);
    }
    const conflict = await call(current, 'process_unregister', { commandId, id: remaining[0]!.id });
    assert.equal(conflict.response.isError, true);
    assert.equal(readFileSync(receiptPath).equals(receiptBytes), true, 'the original receipt is unchanged');
    assert.equal(readFileSync(registryPath).equals(registryBytes), true, 'replay and lookup cannot change the registry');
    assert.equal(removals, 1, 'no second canonical removal, including the conflicting selector');
  }
  await completeCatalog(coldClient, remaining);
});
