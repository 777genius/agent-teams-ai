import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { startTeamMcpEndpoint } from '../dist/mcp/index.js';
import type { TeamMcpConnection } from '../dist/mcp/index.js';
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

test('real authenticated HTTP MCP process_list reconstructs oversized retained metadata', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-process-mcp-http-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
    }).phase, 'completed');
  }
  const expected = owner.processCommands('alice').list();
  assert.equal(expected.length, rows.length);
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 256 * 1024);
  let reads = 0;
  const native = {
    list: () => { reads++; return owner.processCommands('alice').list(); },
    register: async () => { throw new Error('Unexpected native register'); },
    metadata: async () => { throw new Error('Unexpected metadata effect'); },
    lookup: () => null,
  } as unknown as TeamMcpConnection['process'];
  const endpoint = await startTeamMcpEndpoint({
    connection: { ...owner.connect('alice'), process: native },
    binding: delivery, expiresAtMs: 10_000,
    now: () => 1000,
    isCurrentBinding: () => true,
  });
  t.after(() => endpoint.close());
  const client = new Client({ name: 'TEST-process-page-reader', version: '1' });
  t.after(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: 'Bearer ' + endpoint.bearerToken } },
  });
  await client.connect(transport as Transport);
  const collected: unknown[] = [];
  let cursor: string | undefined;
  let count = 0;
  do {
    const response = await client.callTool({
      name: 'process_list',
      arguments: cursor === undefined ? {} : { cursor },
    });
    const item = response.content[0];
    assert.ok(item?.type === 'text');
    const result = JSON.parse(item.text) as {
      kind: string; processes: unknown[]; total: number; nextCursor: string | null;
    };
    assert.equal(result.kind, 'process-catalog-page');
    assert.equal(result.total, rows.length);
    assert.ok(Buffer.byteLength(item.text) <= 256 * 1024);
    collected.push(...result.processes);
    cursor = result.nextCursor ?? undefined;
    assert.ok(++count < 128);
  } while (cursor);
  assert.ok(count > 1);
  assert.equal(reads, count, 'every continuation uses original authenticated process port');
  assert.deepEqual(collected, expected);
});
