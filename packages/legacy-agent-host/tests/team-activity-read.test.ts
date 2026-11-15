import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { readTeamActivity, summarizeTeamActivity } from '../dist/composition/readTeamActivity.js';
import type { TeamActivityReadOptions } from '../dist/composition/readTeamActivity.js';
import type { TeamGrant } from '../dist/team/contracts.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type {
  RuntimeActivityEvent,
  RuntimeActivitySnapshot,
} from '../dist/runtime/activityContracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../dist/runtime/identity.js';
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
          latest: {
            text: [],
            tools: [],
            usage: [],
            compaction: null,
            interactions: [],
            subagents: [],
          },
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
  return { root, owner, connection, options, events, push, taskId, intent, record };
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
test('cold thinking and member stderr retain their exact scope without changing message, usage or preview counts', (t) => {
  const f = fixture(t);
  const thought = {
    kind: 'thinking',
    messageRef: 'TEST-message',
    block: 0,
    text: 'TEST thought',
    phase: 'snapshot',
  };
  f.push({ ...thought, privateNative: 'PRIVATE-not-projected' });
  f.push({ ...thought, text: 'TEST final thought', phase: 'complete' });
  f.push({
    kind: 'text',
    messageRef: 'TEST-message',
    block: 1,
    text: 'TEST answer',
    phase: 'complete',
  });
  f.push({ ...thought, messageRef: 'TEST-thinking-only', phase: 'complete' });
  f.push({
    kind: 'subagent',
    phase: 'fact',
    childId: `child-${'a'.repeat(64)}`,
    parentToolRef: `tool-${'b'.repeat(64)}`,
    fact: { ...thought, messageRef: 'TEST-child', phase: 'complete' },
  });
  f.push({ kind: 'usage', inputTokens: 3, outputTokens: 2, cumulativeCostUsd: 0.01 });
  const stderr = { kind: 'process-output', stream: 'stderr', text: 'TEST captured stderr' };
  f.events.push({
    sequence: 7,
    eventId: 'TEST-stderr',
    data: { ...stderr, privateNative: 'PRIVATE-not-projected' },
  });
  // A retained JSON fixture enters the existing journal under its member fence.
  // It does not add an unsupported thinking Event to the currently pinned SPI producer.
  const store = new FileRuntimeStore(f.root),
    binding = normalizeBinding(f.intent.binding),
    key = runtimeDigest(binding);
  const body = {
    schemaVersion: 1 as const,
    binding,
    sequence: f.events.length,
    writerIncarnation: 'TEST-incarnation',
    stateDigest: runtimeDigest(f.record),
    events: f.events.map((event) => ({ ...event, eventId: `${key}:${event.sequence}` })),
  };
  store.fenced(binding, () => store.writeActivity({ ...body, digest: runtimeDigest(body) }));
  const cold = new FileRuntimeStore(f.root);
  const retained = cold.fenced(binding, () => cold.readActivity(binding));
  assert.ok(retained);
  f.events.splice(0, f.events.length, ...retained.events);
  f.options.runtime.readCapturedSession = () => ({ record: f.record, attached: false });
  const logs = readTeamActivity(f.options, { taskId: f.taskId }),
    log = logs[0]!;
  assert.equal(log.memberId, 'alice');
  assert.equal(log.taskId, f.taskId);
  assert.equal(log.messageCount, 2);
  assert.equal(log.isOngoing, false);
  assert.deepEqual(
    log.events.map((event) => event.data.kind),
    ['thinking', 'thinking', 'text', 'thinking', 'subagent', 'usage']
  );
  assert.deepEqual(log.events[0]!.data, thought);
  assert.equal(log.lastOutputPreview, 'TEST answer');
  assert.equal(JSON.stringify(log).includes('PRIVATE-'), false);
  const memberLog = readTeamActivity(f.options, { memberName: 'alice' })[0]!;
  assert.deepEqual(memberLog.events.slice(0, -1), log.events);
  assert.deepEqual(memberLog.events.at(-1), { eventId: `${key}:7`, sequence: 7, data: stderr });
  assert.equal(memberLog.messageCount, log.messageCount);
  assert.equal(memberLog.lastOutputPreview, 'TEST answer');
  const stats = summarizeTeamActivity('alice', logs);
  assert.equal(stats.observedMessages, 2);
  assert.equal(stats.inputTokens, 3);
  assert.equal(stats.outputTokens, 2);
  assert.equal(stats.costUsd, 0.01);
  const { computedAt: _taskClock, ...taskStats } = stats;
  const { computedAt: _memberClock, ...memberStats } = summarizeTeamActivity('alice', [memberLog]);
  assert.deepEqual(memberStats, taskStats);
  // Even a malformed retained diagnostic cannot borrow a legitimate task input.
  f.push(stderr);
  assert.deepEqual(readTeamActivity(f.options, { taskId: f.taskId })[0]!.events, log.events);
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
  f.events.push({
    ...f.events[1]!,
    sequence: 3,
    eventId: 'TEST-foreign-thinking',
    data: {
      kind: 'thinking',
      messageRef: 'FOREIGN',
      block: 0,
      text: 'must not leak either',
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
