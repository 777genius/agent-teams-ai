import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { claudeSubagentActivity } from '../dist/composition/claudeSubagentActivity.js';
import { ClaudeSubagentLogProjection } from '../dist/adapters/providers/ClaudeSubagentLogProjection.js';
import type { Event } from '@agent-teams/provider-session-contracts';

for (const count of [1, 2]) test(`canonical solo DO policy authorizes original persisted input with ${count} roster member(s)`, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-ordinary-child-policy-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-ordinary-child' };
  const members = Array.from({ length: count }, (_, index) => ({ memberId: `member-${index}`, name: `agent-${index}`, role: index === 0 ? 'lead' as const : 'member' as const, delivery: { ...binding, runId: 'TEST-run', memberId: `member-${index}`, generation: '1' } }));
  const owner = createFilesystemTeamOwner({ root, binding, members, grants: [
    { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'admin'] },
    { principalId: 'agent', memberName: 'agent-0', permissions: ['read', 'message.write'] },
  ] });
  const human = owner.connect('human');
  for (const mode of ['do', 'ask', 'delegate'] as const) {
    human.execute({ commandId: `TEST-${mode}`, operation: 'message.send', payload: { to: 'agent-0', text: 'TEST no model-selected authority', actionMode: mode, messageId: `TEST-${mode}` } });
    const intent = human.pendingDeliveries().find(row => row.commandId === `TEST-${mode}`); assert.ok(intent);
    assert.equal(owner.allowsOrdinarySubagent('agent', intent), count === 1 && mode === 'do');
  }
  const original = human.pendingDeliveries().find(row => row.commandId === 'TEST-do'); assert.ok(original);
  if (count === 1) assert.throws(() => owner.allowsOrdinarySubagent('agent', { ...original, content: 'TEST replacement bytes' }), /forbidden|hold/, 'altered input cannot borrow the original action mode');
  else assert.equal(owner.allowsOrdinarySubagent('agent', { ...original, content: 'TEST replacement bytes' }), false);
  if (count === 1) { human.revoke('human'); assert.throws(() => owner.allowsOrdinarySubagent('agent', original), /forbidden|hold/); }
});

test('child logs use digest aliases and separate counters; parent Agent metadata cannot leak native child IDs or duplicate usage', () => {
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
  const base = { sessionRef: 'native-session-private', inputId: 'input-A', operationRef: 'op-A', parentToolRef: 'native-parent-private', childRef: 'native-child-private', signal: new AbortController().signal };
  const projection = claudeSubagentActivity(binding, { ...base, phase: 'fact', fact: { kind: 'tool', messageRef: 'native-message-private', toolRef: 'native-tool-private', name: 'Write', input: { file_path: '/TEST/child.txt', content: 'TEST actual child input' } } });
  assert.equal(projection.data.kind, 'subagent'); assert.equal(projection.inputId, 'input-A'); assert.equal(projection.operationRef, 'op-A');
  assert.match(String(projection.data.childId), /^child-[a-f0-9]{64}$/); assert.match(String(projection.data.parentToolRef), /^tool-[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(projection), /native-(?:session|parent|child|message|tool)-private/);
  const usage = claudeSubagentActivity(binding, { ...base, phase: 'usage', totalTokens: 45, toolUses: 2, durationMs: 500 });
  assert.equal(usage.data.childTotalTokens, 45); assert.equal(usage.data.inputTokens, undefined); assert.equal(usage.data.outputTokens, undefined); assert.equal(usage.data.cumulativeCostUsd, undefined);
  const parent = new ClaudeSubagentLogProjection(binding);
  const tool = parent.project({ sessionRef: base.sessionRef, inputId: base.inputId, operationRef: base.operationRef, kind: 'tool', messageRef: 'root-message', toolRef: base.parentToolRef, name: 'Agent', input: {} });
  assert.ok(tool.kind === 'tool'); assert.equal(tool.toolRef, projection.data.parentToolRef);
  const result = parent.project({ sessionRef: base.sessionRef, kind: 'tool-result', toolRef: base.parentToolRef, content: 'actual report\nagentId: native-child-private\n<usage>999</usage>', isError: false });
  assert.ok(result.kind === 'tool-result'); assert.equal(result.toolRef, tool.toolRef); assert.deepEqual(result.content, { scope: 'ordinary-subagent', outcome: 'returned', transcript: 'child-activity' });
  assert.doesNotMatch(JSON.stringify(result), /native-child-private|999|actual report/);
  const root: Event = { sessionRef: base.sessionRef, kind: 'usage', inputTokens: 11, outputTokens: 7, cumulativeCostUsd: 0.02 };
  assert.equal(parent.project(root), root, 'root billed usage is unchanged and child cumulative totals are separate');
});
