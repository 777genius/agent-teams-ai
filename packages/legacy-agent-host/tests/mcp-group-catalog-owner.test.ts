import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createGroupMcpTools } from '../dist/mcp/groupChatTools.js';
import { formatToolResult } from '../dist/mcp/toolDefinition.js';
import { pageGroupCatalog } from '../dist/group-chats/pageGroupCatalog.js';

test('canonical retained GroupCommands catalog reaches native MCP in complete signed pages', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-group-catalog-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-groups' };
  const members = ['lead', 'alice', 'bob'].map(name => ({
    memberId: name, name, role: name === 'lead' ? ('lead' as const) : ('member' as const),
    delivery: { ...binding, memberId: name, runId: 'TEST-run', generation: '1' },
  }));
  const owner = createFilesystemTeamOwner({ root, binding, members,
    grants: [{ principalId: 'alice', memberName: 'alice', permissions: ['read'] }] });
  const groups = Array.from({ length: 1100 }, (_, index) => ({
    id: index.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001',
    name: 'TEST retained ' + index + ' ' + 'x'.repeat(75),
    createdAt: '2026-11-28T00:00:00.000Z',
    membership: { kind: 'fixed', memberNames: ['alice', 'bob'] },
    archivedAt: index % 2 ? '2026-11-28T01:00:00.000Z' : null,
  }));
  const path = join(root, 'teams', binding.teamName, 'group-chats.json');
  writeFileSync(path, JSON.stringify({ version: 1, groups }), { mode: 0o600 });
  const originalBytes = readFileSync(path, 'utf8');
  const runtime = {
    async getRun(name: string) {
      return {
      provider: 'host' as const, protocolVersion: 1 as const,
      groupReactionProtocolVersion: 1 as const,
      binding: members.find(row => row.name === name)!.delivery,
      runKey: 'TEST-' + name,
      isCurrent: async () => true,
      };
    },
  };
  const service = owner.groupCommands('alice', runtime);
  const guard = { before() {}, inside() {} };
  const source = await service.read('list', {}, guard);
  assert.ok(Array.isArray(source));
  assert.equal(source.length, 1100);
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > 256 * 1024);
  const privateKey = 'TEST-ephemeral-port-key';
  const port = {
    list: async (cursor?: string) => {
      const rows = await service.read('list', {}, guard);
      return pageGroupCatalog({ rows, key: privateKey,
        principalId: 'alice', binding: binding.teamId,
        ...(cursor === undefined ? {} : { cursor }) });
    },
    lookup: (_id: string) => undefined,
    execute: async () => { throw new Error('Read-only TEST port'); },
  };
  const tool = createGroupMcpTools(port).find(row => row.definition.name === 'group_chat_list');
  assert.ok(tool);
  const rebuilt: unknown[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const value = await tool.invoke(cursor ? { cursor } : {}) as {
      kind: string; groups: unknown[]; revision: string; nextCursor: string | null;
    };
    const formatted = formatToolResult(value, false);
    assert.equal(formatted.isError, undefined);
    assert.equal(value.kind, 'group-catalog-page');
    assert.ok(value.groups.length);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 240 * 1024);
    rebuilt.push(...value.groups);
    if (!pages) {
      assert.ok(value.nextCursor);
      const changed = structuredClone(groups);
      changed.pop();
      writeFileSync(path, JSON.stringify({ version: 1, groups: changed }));
      await assert.rejects(port.list(value.nextCursor!), { code: 'hold' });
      writeFileSync(path, originalBytes);
    }
    cursor = value.nextCursor ?? undefined;
    assert.ok(++pages < 128);
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(rebuilt, source);
  assert.equal(readFileSync(path, 'utf8'), originalBytes);
});
