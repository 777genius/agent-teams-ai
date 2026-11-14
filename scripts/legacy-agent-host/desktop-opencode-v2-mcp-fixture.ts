/** TEST-only seed and finite oracle for the existing Launch MCP controls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { record } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { startCapturedMcpModel } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-v2-mcp/model.ts';
import { reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';

import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { McpTurn } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-v2-mcp/model.ts';

export const DESKTOP_MCP_MEMBERS = [
  { memberId: 'TEST-mcp-allowed', name: 'mcp-allowed', turn: 'ALLOW' },
  { memberId: 'TEST-mcp-app-only', name: 'mcp-app-only', turn: 'APP_ONLY' },
] as const;
const readJson = (path: string) => {
  const bytes = readFileSync(path, 'utf8');
  assert.ok(Buffer.byteLength(bytes) <= 2_000_000, 'bounded original TEST file');
  return record(JSON.parse(bytes));
};
export function desktopCapturedMcpPaths(root: string) {
  return {
    description: join(root, 'captured-mcp-fixture.json'),
    catalog: join(root, 'home', 'TEST-mcp-catalog.json'),
    actorLog: join(root, 'workspace', 'TEST-mcp-selected.ndjson'),
    excludedLog: join(root, 'workspace', 'TEST-mcp-excluded.ndjson'),
    effect: join(root, 'workspace', 'TEST-mcp-effect.json'),
    excludedEffect: join(root, 'workspace', 'TEST-mcp-excluded-effect.json'),
  };
}
export function readDesktopCapturedMcpEvents(root: string): Record<string, unknown>[] {
  const path = desktopCapturedMcpPaths(root).actorLog;
  let bytes: string;
  try { bytes = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  assert.ok(Buffer.byteLength(bytes) <= 32 * 1024, 'finite original native MCP actor events');
  const rows = bytes.trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
  assert.ok(rows.length <= 32);
  return rows;
}
export function readDesktopCapturedMcpDescription(root: string) {
  const value = readJson(desktopCapturedMcpPaths(root).description);
  assert.match(String(value.nonce), /^[a-f0-9-]{36}$/);
  assert.match(String(value.catalogSha256), /^[a-f0-9]{64}$/);
  assert.deepEqual(value.members, DESKTOP_MCP_MEMBERS);
  return { nonce: String(value.nonce), catalogSha256: String(value.catalogSha256) };
}

/** Runs before the existing canonical Team seed. Policies are chosen later only through the UI. */
export async function prepareDesktopCapturedMcpRecipes(options: {
  profile: TeamHostProfile; root: string; node: string; nonce: string;
}) {
  const { profile, root, node, nonce } = options;
  assert.match(nonce, /^[a-f0-9-]{36}$/);
  assert.ok(profile.runtime && profile.runtime.members.length === 1 && profile.teams.length === 1);
  const lead = profile.runtime.members[0]!;
  assert.ok(lead.provider === 'opencode' && lead.nativeGeneration === 'v2' &&
    lead.protocolRevision === '2.1.4' && lead.embedded && lead.memberId === 'alice-id');
  assert.equal(lead.mcpCatalogSource, undefined, 'lead has no external catalog');
  const team = profile.teams[0]!;
  assert.equal(team.members[0]?.role, 'lead');
  const paths = desktopCapturedMcpPaths(root);
  const actor = await realpath(join(import.meta.dirname,
    '../../packages/legacy-agent-host/tests/fixtures/native-opencode-v2-mcp/server.mjs'));
  const server = (kind: 'selected' | 'excluded') => ({
    type: 'stdio', command: node,
    args: [actor, kind === 'selected' ? paths.actorLog : paths.excludedLog,
      kind === 'selected' ? paths.effect : paths.excludedEffect, nonce, kind],
    env: { TEST_MCP_NONCE: nonce },
  });
  await writeFile(paths.catalog, JSON.stringify({ mcpServers: {
    'TEST.selected': server('selected'), 'TEST.excluded': server('excluded'),
  } }), { mode: 0o600, flag: 'wx' });
  for (const selected of DESKTOP_MCP_MEMBERS) {
    const member = { ...structuredClone(lead), memberId: selected.memberId,
      principalId: selected.name + '-session', sessionId: 'TEST-native-' + selected.name,
      configRevision: 'TEST-mcp-config-' + selected.name, endpoint: await reserveMixedOpenCodeEndpoint(),
      mcpCatalogSource: { claudeConfigPath: paths.catalog } };
    profile.runtime.members.push(member);
    team.members.push({ memberId: member.memberId, name: selected.name, role: 'member',
      delivery: { ...team.binding, runId: team.scope.runId,
        memberId: member.memberId, generation: String(member.generation) } });
    team.grants.push({ principalId: member.principalId, memberName: selected.name,
      permissions: ['read', 'task.write', 'message.write'] });
  }
  await writeFile(paths.description, JSON.stringify({
    nonce, catalogSha256: await fileHash(paths.catalog), members: DESKTOP_MCP_MEMBERS,
  }), { mode: 0o600, flag: 'wx' });
}

/** No ordinary inference is sent to the lead; probes retain the existing exact no-tool shape. */
export async function startDesktopCapturedMcpModel(root: () => string) {
  const nonce = randomUUID();
  const model = await startCapturedMcpModel({
    nonce, allowModelProbes: true,
    originalInstance: () => {
      const started = readDesktopCapturedMcpEvents(root()).filter(row => row.event === 'started');
      assert.equal(started.length, 1);
      return String(started[0]!.instanceId);
    },
    principalId: (turn: McpTurn) => {
      const state = readJson(join(root(), 'hoststore/teams/test-desktop-backend/.host-owner/state.json'));
      assert.ok(Array.isArray(state.runtimeCaptures) && state.runtimeCaptures.length === 1);
      const members = record(state.runtimeCaptures[0]).members;
      assert.ok(Array.isArray(members) && members.length === 3);
      const expected = DESKTOP_MCP_MEMBERS.find(row => row.turn === turn)!;
      const selected = members.map(record).filter(row => row.memberId === expected.memberId);
      assert.equal(selected.length, 1);
      assert.match(String(selected[0]!.principalId), /^agent:/);
      return String(selected[0]!.principalId);
    },
  });
  return { ...model, nonce };
}
