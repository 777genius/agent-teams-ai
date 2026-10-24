import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { readTeamActivity, summarizeTeamActivity } from '../dist/composition/readTeamActivity.js';
import type { TeamActivityReadOptions } from '../dist/composition/readTeamActivity.js';
import type { TeamGrant } from '../dist/team/contracts.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type {
  RuntimeActivityEvent,
  RuntimeActivitySnapshot,
} from '../dist/runtime/activityContracts.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-activity-read-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-activity' };
  const members = ['lead', 'alice'].map((name) => ({
    name,
    memberId: name,
    role: name === 'lead' ? ('lead' as const) : ('member' as const),
    delivery: { ...binding, runId: 'TEST-run', memberId: name, generation: '1' },
  }));
  const grants: TeamGrant[] = [
    {
      principalId: 'human',
      memberName: 'user',
      permissions: ['read', 'task.write', 'message.write', 'admin'],
    },
  ];
  const owner = createFilesystemTeamOwner({ root, binding, members, grants }),
    connection = owner.connect('human');
  const team: HostedTeam = {
    owner,
    connection,
    definition: {
      binding,
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: binding.teamId,
        runId: 'TEST-run',
        memberId: 'human',
        generation: '1',
      },
      members,
      grants,
    },
  };
  const created = connection.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST task', owner: 'alice' },
  });
  const taskId = created.effects.taskId!;
  connection.execute({
    commandId: 'TEST-start',
    operation: 'task.start',
    payload: { taskId, notification: 'user' },
  });
  const intent = connection.pendingDeliveries().find((row) => row.commandId === 'TEST-start')!;
  assert.ok(intent);
  const record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding: intent.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-incarnation',
    config: null,
    openFingerprint: null,
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    interactions: [],
    inputs: [
      {
        intent,
        fingerprint: deliveryFingerprint(intent),
        operationRef: 'TEST-operation',
        phase: 'consumed',
      },
    ],
  };
  const events: RuntimeActivityEvent[] = [];
  const push = (data: RuntimeActivityEvent['data']) =>
    events.push({
      sequence: events.length + 1,
      eventId: `TEST-event-${events.length}`,
      inputId: intent.inputId,
      operationRef: 'TEST-operation',
      data,
    });
  const cursor = { resource: 'a'.repeat(64), hostIncarnation: 'TEST-incarnation', sequence: 0 };
  const options: TeamActivityReadOptions = {
    team,
    principalId: 'human',
    entries: [{ team, binding: intent.binding }],
    taskCause: (raw) => owner.readTaskInputCause('human', raw),
    assertCurrent() {},
    runtime: {
      readCapturedSession() {
        return { record, attached: true };
      },
      readActivitySnapshot() {
        return {
          binding: intent.binding,
          cursor: { ...cursor, sequence: events.length },
          retainedFrom: 1,
          events: [],
          hasMore: false,
          state: null,
          latest: { text: [], tools: [], usage: [], compaction: null, interactions: [], subagents: [] },
        } satisfies RuntimeActivitySnapshot;
      },
      readActivityFeed(_binding, from) {
        const rows = events.filter((event) => event.sequence > from.sequence).slice(0, 64);
        return {
          binding: intent.binding,
          cursor: { ...cursor, sequence: rows.at(-1)?.sequence ?? from.sequence },
          retainedFrom: 1,
          events: rows,
          hasMore: false,
        };
      },
    },
  };
  return { owner, connection, options, events, push, taskId, intent, record };
}
test('actual normalized content/tool/usage/compaction facts remain scoped to original task after reassignment', (t) => {
  const f = fixture(t);
  f.push({ kind: 'text', messageRef: 'TEST-message', block: 0, text: 'first', phase: 'snapshot' });
  f.push({
    kind: 'text',
    messageRef: 'TEST-message',
    block: 0,
    text: 'final answer',
    phase: 'complete',
  });
  f.push({
    kind: 'tool',
    messageRef: 'TEST-message',
    toolRef: 'TEST-tool',
    name: 'Read',
    input: { file_path: 'TEST-file' },
  });
  f.push({ kind: 'tool-result', toolRef: 'TEST-tool', content: 'TEST bytes', isError: false });
  f.push({ kind: 'usage', inputTokens: 11, outputTokens: 7, cumulativeCostUsd: 0.02 });
  f.push({ kind: 'compaction', sourceRef: 'TEST-compact', reason: 'automatic' });
  f.push({ kind: 'usage', inputTokens: 11, outputTokens: 7, cumulativeCostUsd: 0.02 });
  f.push({
    kind: 'subagent',
    phase: 'usage',
    childId: `child-${'a'.repeat(64)}`,
    parentToolRef: `tool-${'b'.repeat(64)}`,
    childTotalTokens: 999,
    childToolUses: 8,
    childDurationMs: 100,
  });
  f.connection.execute({
    commandId: 'TEST-reassign',
    operation: 'task.assign',
    payload: { taskId: f.taskId, owner: 'lead' },
  });
  assert.throws(() => f.owner.lookupTaskStartCause('human', f.intent));
  const logs = readTeamActivity(f.options, { taskId: f.taskId });
  assert.equal(logs[0]!.memberName, 'alice', 'never infer actor from current Task owner');
  assert.equal(logs[0]!.events.length, 8);
  assert.equal(logs[0]!.events.at(-1)!.data.kind, 'subagent');
  assert.equal(logs[0]!.startTime, null);
  assert.equal(logs[0]!.durationMs, null);
  const stats = summarizeTeamActivity('alice', logs);
  assert.equal(stats.observedMessages, 1);
  assert.deepEqual({ ...stats.toolUsage }, { Read: 1 });
  assert.equal(stats.inputTokens, 11);
  assert.equal(stats.outputTokens, 7);
  assert.equal(stats.costUsd, 0.02, 'duplicate cumulative reports are not double-counted');
  assert.equal(stats.compactions, 1);
  f.connection.revoke('human');
  assert.throws(() => readTeamActivity(f.options, { taskId: f.taskId }), { code: 'forbidden' });
  assert.throws(() => f.owner.readTaskInputCause('human', f.intent), { code: 'forbidden' });
});
test('unknown usage stays unknown; foreign operation/input cannot borrow task scope; finite page cap is visible', (t) => {
  const f = fixture(t);
  f.push({
    kind: 'text',
    messageRef: 'TEST-message',
    block: 0,
    text: 'actual answer',
    phase: 'complete',
  });
  f.events.push({
    sequence: 2,
    eventId: 'TEST-foreign',
    inputId: f.intent.inputId,
    operationRef: 'FOREIGN-operation',
    data: {
      kind: 'text',
      messageRef: 'FOREIGN',
      block: 0,
      text: 'must not leak',
      phase: 'complete',
    },
  });
  const logs = readTeamActivity(f.options, { taskId: f.taskId });
  assert.equal(logs[0]!.events.length, 1);
  assert.ok(logs[0]!.gaps.includes('unattributed input'));
  const stats = summarizeTeamActivity('alice', logs);
  assert.equal(stats.inputTokens, null);
  assert.equal(stats.outputTokens, null);
  assert.equal(stats.costUsd, null);
  for (let index = 0; index < 300; index++) f.push({ kind: 'diagnostic', code: 'TEST' });
  const capped = readTeamActivity(f.options, { memberName: 'alice' });
  assert.ok(capped[0]!.events.length <= 256);
  assert.ok(capped[0]!.gaps.includes('bounded activity page limit'));
  assert.throws(() => readTeamActivity(f.options, { memberName: 'alice', taskId: f.taskId }));
});

test('unattributed usage cannot be added to per-input token totals', () => {
  const stats = summarizeTeamActivity('alice', [
    {
      kind: 'host_activity',
      sessionId: 'TEST',
      memberId: 'alice',
      memberName: 'alice',
      generation: '1',
      description: 'TEST',
      startTime: null,
      durationMs: null,
      messageCount: 0,
      isOngoing: false,
      gaps: [],
      events: [
        {
          eventId: 'TEST-input-usage',
          sequence: 1,
          inputId: 'TEST-input',
          data: { kind: 'usage', inputTokens: 7, outputTokens: 3 },
        },
        {
          eventId: 'TEST-unbound-usage',
          sequence: 2,
          data: { kind: 'usage', inputTokens: 7, outputTokens: 3 },
        },
      ],
    },
  ]);
  assert.equal(stats.inputTokens, null);
  assert.equal(stats.outputTokens, null);
  assert.ok(stats.gaps.includes('token usage has no retained input attribution'));
});

test('large retained facts produce a partial bounded log rather than losing the entire selection', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++)
    f.push({
      kind: 'text',
      messageRef: `TEST-large-${i}`,
      block: 0,
      text: 'x'.repeat(24 * 1024),
      phase: 'complete',
    });
  const logs = readTeamActivity(f.options, { taskId: f.taskId });
  assert.ok(logs[0]!.events.length > 0);
  assert.ok(logs[0]!.events.length < 12);
  assert.ok(logs[0]!.gaps.includes('bounded activity projection limit'));
});
