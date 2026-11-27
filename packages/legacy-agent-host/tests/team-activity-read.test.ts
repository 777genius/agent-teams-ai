import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { readTeamActivity, summarizeTeamActivity } from '../dist/composition/readTeamActivity.js';
import { readEntryActivitySources, readRuntimeActivitySources } from '../dist/composition/runtimeActivitySources.js';
import { captureHostCostCommand } from '../dist/team/hostCostCommand.js';
import type { TeamActivityReadOptions } from '../dist/composition/readTeamActivity.js';
import type { TeamGrant } from '../dist/team/contracts.js';
import type { HostedTeam, MemberEntry } from '../dist/composition/MemberEntry.js';
import type { RetainedNativeLaunch } from '../dist/composition/createRuntimeNativeMemberCreation.js';
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
    entries: [{ team, binding: intent.binding, provider: 'claude' }],
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

test('native last-request reports never become Codex totals, including an old persisted journal', t => {
  const f = fixture(t);
  f.push({ kind: 'usage', inputTokens: 10000, outputTokens: 100, cumulativeCostUsd: 0.02 });
  f.push({ kind: 'usage', inputTokens: 20000, outputTokens: 200, cumulativeCostUsd: 0.05 });
  f.push({ kind: 'text', messageRef: 'TEST-result', block: 0, text: 'answer', phase: 'complete' });
  const verify = () => {
    for (const provider of ['claude', 'codex', undefined] as const) {
      f.options.entries = [{ team: f.options.team, binding: f.intent.binding,
        ...(provider ? { provider } : {}) }];
      const logs = readTeamActivity(f.options, { memberName: 'alice' });
      const stats = summarizeTeamActivity('alice', logs, f.options.entries);
      assert.equal(stats.observedMessages, 1);
      assert.equal(stats.costUsd, 0.05, 'independent cumulative cost is retained');
      if (provider === 'claude') {
        assert.equal(stats.inputTokens, 20000);
        assert.equal(stats.outputTokens, 200);
        assert.deepEqual(stats.gaps, []);
      } else {
        assert.equal(stats.inputTokens, null);
        assert.equal(stats.outputTokens, null);
        assert.ok(stats.gaps.some(reason => reason.includes(provider === 'codex'
          ? 'only the last request' : 'retained provider is unknown')));
        if (provider === 'codex') {
          const cost = captureHostCostCommand({ binding: normalizeBinding(f.intent.binding), stats, now: 1000 });
          assert.equal(cost.partial, true);
          assert.equal(cost.inputTokens, null);
          assert.equal(cost.outputTokens, null);
          assert.match(cost.text, /Input tokens reported: not reported/u);
          assert.match(cost.text, /not a full session total/u);
        }
      }
    }
  };
  verify();
  const binding = normalizeBinding(f.intent.binding), key = runtimeDigest(binding);
  const body = {
    schemaVersion: 1 as const, binding, sequence: f.events.length,
    writerIncarnation: 'TEST-incarnation', stateDigest: runtimeDigest(f.record),
    events: f.events.map(event => ({ ...event, eventId: `${key}:${event.sequence}` })),
  };
  const store = new FileRuntimeStore(f.root);
  store.fenced(binding, () => store.writeActivity({ ...body, digest: runtimeDigest(body) }));
  const cold = new FileRuntimeStore(f.root);
  const retained = cold.fenced(binding, () => cold.readActivity(binding));
  assert.ok(retained);
  f.events.splice(0, f.events.length, ...retained.events);
  f.options.runtime.readCapturedSession = () => ({ record: f.record, attached: false });
  verify();
});

test('original provider classification survives live replacements without borrowing the current provider', t => {
  const f = fixture(t);
  const entry = (provider: 'claude' | 'codex', generation: number): MemberEntry => {
    const binding = normalizeBinding({ ...f.intent.binding, generation: String(generation) });
    const common = {
      cwd: f.root, environment: { HOME: f.root, CODEX_HOME: f.root },
      executable: { path: f.root, sha256: 'a'.repeat(64) },
      teamId: binding.teamId, memberId: binding.memberId, principalId: 'human',
      sessionId: `TEST-session-${generation}`, generation, configRevision: 'TEST-revision',
      model: 'TEST-model', accountBinding: 'TEST-account',
      limits: { queuedInputs: 8, inputBytes: 4096, outputBytes: 4096,
        outputEvents: 256, pendingInteractions: 8, timeoutMs: 1000 },
    };
    const profile: MemberEntry['profile'] = provider === 'codex'
      ? { ...common, provider, protocolRevision: '0.169.0',
        nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } }
      : { ...common, provider, nativeTools: [], autoAllowedTools: [], nativeOptions: {} };
    return { binding, team: f.options.team, profile, baseProfile: profile,
      delivery: { ...binding, teamName: f.options.team.definition.binding.teamName },
      config: { tenantId: 'TEST-owner', projectId: 'TEST-project', sessionId: profile.sessionId,
        generation, configRevision: profile.configRevision, requiredCapabilities: [] } };
  };
  const original = entry('claude', 1), codex = entry('codex', 2), current = entry('claude', 3);
  const member = (value: MemberEntry) => ({
    memberId: value.binding.memberId, binding: value.binding,
    configurationDigest: runtimeDigest(value.profile), baseConfigurationDigest: runtimeDigest(value.baseProfile),
    runtimeGeneration: value.profile.generation, configRevision: value.config.configRevision,
    contextDigest: 'b'.repeat(64), skipped: false, timeoutMs: 1000,
  });
  // The launch owner has already validated these immutable source/target edges.
  const launch = { readActivityLineage: () => ({
    launchId: current.binding.runId, member: member(current), recordRequired: true,
    restorations: [], actions: [], liveSelections: [
      { source: member(original), member: member(codex), sourceRecordRequired: true },
      { source: member(codex), member: member(current), sourceRecordRequired: true },
    ],
  }) } as unknown as RetainedNativeLaunch['launch'];
  const launches = new Map([[runtimeDigest({ teamId: current.binding.teamId, launchId: current.binding.runId }),
    { team: f.options.team, launch, entries: [current] }]]);
  for (const entries of [[original, codex, current], [current, codex, original]]) {
    const sources = readRuntimeActivitySources(entries, launches, current.binding.teamId);
    const providers = new Map(sources.map(source => [source.binding.generation, source.provider]));
    assert.deepEqual(Object.fromEntries(providers), { 1: 'claude', 2: 'codex', 3: 'claude' });
    assert.equal(sources.length, 3, 'repeated lineage reads merge original providers once');
    const log = readTeamActivity(f.options, { memberName: 'alice' })[0]!;
    for (const value of entries) {
      const stats = summarizeTeamActivity('alice', [{ ...log, generation: value.binding.generation,
        sessionId: `host-activity-${runtimeDigest(value.binding)}`, events: [{
          eventId: 'TEST-usage', sequence: 1, inputId: 'TEST-input',
          data: { kind: 'usage', inputTokens: 17, outputTokens: 9, cumulativeCostUsd: 0.03 },
        }], gaps: [] }], sources);
      assert.equal(stats.inputTokens, value.profile.provider === 'codex' ? null : 17);
      assert.equal(stats.outputTokens, value.profile.provider === 'codex' ? null : 9);
      assert.equal(stats.costUsd, 0.03);
    }
  }
  for (const value of [codex, current]) {
    const currentSession = readEntryActivitySources(value, launches, true);
    assert.equal(currentSession.length, 1, '/cost cannot borrow a replaced native session');
    assert.equal(currentSession[0]!.provider, value.profile.provider);
  }
  const incomplete = readRuntimeActivitySources([current], launches, current.binding.teamId);
  assert.equal(incomplete.find(source => source.binding.generation === '1')!.provider, undefined);
  assert.equal(incomplete.find(source => source.binding.generation === '2')!.provider, undefined);
  assert.equal(incomplete.find(source => source.binding.generation === '3')!.provider, 'claude');
});

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
  const stats = summarizeTeamActivity('alice', logs, f.options.entries);
  assert.equal(stats.observedMessages, 1);
  assert.deepEqual({ ...stats.toolUsage }, { Read: 1 });
  assert.equal(stats.inputTokens, 11);
  assert.equal(stats.outputTokens, 7);
  assert.equal(stats.costUsd, 0.02, 'duplicate cumulative reports are not double-counted');
  assert.equal(stats.compactions, 1);
  const snapshot = f.options.runtime.readActivitySnapshot.bind(f.options.runtime);
  f.options.runtime.readActivitySnapshot = binding => ({ ...snapshot(binding),
    logProjection: { thinking: [], stderr: [], truncated: true } });
  const unchanged = readTeamActivity(f.options, { taskId: f.taskId });
  assert.deepEqual(unchanged, logs, 'internal schedule-log trimming does not enter Team Logs');
  const { computedAt: _originalClock, ...originalStats } = stats;
  const { computedAt: _unchangedClock, ...unchangedStats } = summarizeTeamActivity('alice', unchanged, f.options.entries);
  assert.deepEqual(unchangedStats, originalStats, 'retained Stats cost stays known');
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
  const stats = summarizeTeamActivity('alice', logs, f.options.entries);
  assert.equal(stats.observedMessages, 2);
  assert.equal(stats.inputTokens, 3);
  assert.equal(stats.outputTokens, 2);
  assert.equal(stats.costUsd, 0.01);
  const { computedAt: _taskClock, ...taskStats } = stats;
  const { computedAt: _memberClock, ...memberStats } = summarizeTeamActivity('alice', [memberLog], f.options.entries);
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
  const stats = summarizeTeamActivity('alice', logs, f.options.entries);
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


test('retained thinking keeps original task and child identities without duplicating messages or inventing usage', (t) => {
  const f = fixture(t);
  const thinking = {
    kind: 'thinking', messageRef: 'TEST-message', block: 1, text: 'partial thought', phase: 'snapshot',
  };
  f.push(thinking);
  f.push({ ...thinking, text: 'complete thought', phase: 'complete' });
  const first = readTeamActivity(f.options, { memberName: 'alice' })[0]!;
  assert.deepEqual(first.events.map((event) => event.data.kind), ['thinking', 'thinking']);
  assert.equal(first.messageCount, 1);
  assert.equal(first.lastOutputPreview, undefined, 'thinking is not ordinary conversation output');
  f.push({ kind: 'text', messageRef: 'TEST-message', block: 2, text: 'answer', phase: 'complete' });
  f.push({ ...thinking, messageRef: 'TEST-thinking-only', text: 'another thought', phase: 'complete' });
  for (const child of ['a', 'c']) f.push({
    kind: 'subagent', phase: 'fact', childId: 'child-' + child.repeat(64),
    parentToolRef: 'tool-' + 'b'.repeat(64), fact: { ...thinking, phase: 'complete' },
  });
  const logs = readTeamActivity(f.options, { taskId: f.taskId });
  assert.deepEqual(logs[0]!.events.map((event) => event.eventId), f.events.map((event) => event.eventId));
  assert.deepEqual(logs[0]!.events.slice(-2).map((event) => event.data.childId), [
    'child-' + 'a'.repeat(64), 'child-' + 'c'.repeat(64),
  ]);
  assert.equal(logs[0]!.messageCount, 2, 'output and thinking share a message; child messages stay separate');
  assert.equal(logs[0]!.lastOutputPreview, 'answer');
  const stats = summarizeTeamActivity('alice', logs, f.options.entries);
  assert.equal(stats.observedMessages, 2);
  assert.equal(stats.inputTokens, null);
  assert.equal(stats.outputTokens, null);
  assert.equal(stats.costUsd, null);
  const recovered = readTeamActivity({
    ...f.options,
    runtime: { ...f.options.runtime, readCapturedSession: () => ({ record: f.record, attached: false }) },
  }, { taskId: f.taskId });
  assert.deepEqual(recovered[0]!.events, logs[0]!.events);
  assert.equal(recovered[0]!.isOngoing, false);
  f.push({ ...thinking, text: 'PRIVATE-foreign thought' });
  f.events.at(-1)!.operationRef = 'foreign-operation';
  const refused = readTeamActivity(f.options, { taskId: f.taskId });
  assert.equal(refused[0]!.events.length, 6);
  assert.ok(refused[0]!.gaps.includes('unattributed input'));
  assert.ok(!JSON.stringify(refused).includes('PRIVATE-'));
  f.connection.revoke('human');
  assert.throws(() => readTeamActivity(f.options, { memberName: 'alice' }), { code: 'forbidden' });
});
