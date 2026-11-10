import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { bindTaskToolEvidence } from '../dist/evidence/bindTaskToolEvidence.js';
import { digest } from '../dist/team/identity.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import type { TestContext } from 'node:test';
import type { DeliveryIntent } from '../dist/team/contracts.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { NativeToolCaptureIdentity } from '../dist/evidence/bindTaskToolEvidence.js';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-evidence-cause-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-cause' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const options = {
    root,
    binding,
    store,
    members: ['lead', 'worker'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'lead' ? ('lead' as const) : ('member' as const),
      delivery: { ...binding, runId: 'TEST-run', memberId: `${name}-id`, generation: '1' },
    })),
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'] as const,
      },
      ...['lead', 'worker'].map((name) => ({
        principalId: `${name}-principal`,
        memberName: name,
        permissions: ['read', 'task.write', 'message.write'] as const,
      })),
    ].map((grant) => ({ ...grant, permissions: [...grant.permissions] })),
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  const created = human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST cause', owner: 'worker' },
  });
  const start = human.execute({
    commandId: 'TEST-start',
    operation: 'task.start',
    payload: { taskId: created.effects.taskId.slice(0, 8), notification: 'user' },
  });
  const intent = human.pendingDeliveries().find((row) => row.commandId === start.commandId)!;
  assert.ok(intent);
  const config = {
    tenantId: 'TEST-backend',
    projectId: 'TEST-project',
    sessionId: 'TEST-logical-session',
    generation: 1,
    configRevision: 'TEST-config',
    requiredCapabilities: ['session.conversation'],
  };
  const stat = statSync(root);
  const captured = {
    binding: {
      backendId: intent.binding.backendId,
      teamId: intent.binding.teamId,
      memberId: intent.binding.memberId,
      runId: intent.binding.runId,
      generation: intent.binding.generation,
    },
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-incarnation',
    config,
    workspace: { path: root, identity: digest({ dev: stat.dev, ino: stat.ino }) },
  };
  const request: NativeToolCaptureIdentity = {
    phase: 'before',
    sessionRef: 'TEST-native-session',
    toolUseId: 'TEST-tool',
    toolName: 'Edit',
    inputId: intent.inputId,
    operationRef: 'TEST-operation',
    signal: new AbortController().signal,
  };
  const record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding: captured.binding,
    profileId: captured.profileId,
    config,
    openFingerprint: runtimeDigest({ profileId: captured.profileId, config }),
    hostIncarnation: captured.hostIncarnation,
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    sessionRef: request.sessionRef,
    inputs: [
      {
        intent,
        fingerprint: deliveryFingerprint(intent),
        operationRef: request.operationRef!,
        phase: 'claimed',
      },
    ],
    interactions: [],
  };
  const bind = (native = request, snapshot = record) =>
    bindTaskToolEvidence({
      captured,
      request: native,
      readRuntime: () => ({ record: snapshot, attached: true }),
      lookupTaskCause: (input) => owner.lookupTaskStartCause('human', input),
      assertCurrent() {},
    });
  return {
    root,
    store,
    owner,
    human,
    options,
    created,
    start,
    intent,
    captured,
    request,
    record,
    bind,
  };
}

// A generated task.start effect ID, current in_progress task or fuzzy prompt match cannot replace the original canonical Task decision.
test('Task cause comes from the exact persisted start notification and remains deterministic after cold owner reopen', (t) => {
  const f = fixture(t);
  const cause = f.owner.lookupTaskStartCause('human', f.intent)!;
  assert.equal(cause.taskId, f.created.effects.taskId);
  assert.notEqual(cause.taskId, f.start.effects.taskId);
  assert.equal(cause.taskStartCommandId, f.start.commandId);
  assert.equal(cause.messageId, f.start.effects.messageId);
  assert.equal(cause.inputId, f.intent.deliveryId);
  assert.deepEqual(
    createFilesystemTeamOwner(f.options).lookupTaskStartCause('human', f.intent),
    cause
  );
  assert.equal(
    'lookupTaskStartCause' in f.human,
    false,
    'private attribution is not a tool/public connection capability'
  );
  assert.equal(Object.isFrozen(cause), true);
  assert.equal(Object.isFrozen(cause.binding), true);
});

// Generic messages containing task IDs and inline lifecycle commands do not acquire causal task ownership.
test('generic DM and inline task lifecycle lack attribution even when an actual Task is in progress', (t) => {
  const f = fixture(t);
  const sent = f.human.execute({
    commandId: 'TEST-dm',
    operation: 'message.send',
    payload: { to: 'worker', text: `Work on ${f.created.effects.taskId}` },
  });
  const dm = f.human.pendingDeliveries().find((row) => row.commandId === sent.commandId)!;
  assert.equal(f.owner.lookupTaskStartCause('human', dm), null);
  const record = structuredClone(f.record);
  record.inputs[0]!.intent = dm;
  record.inputs[0]!.fingerprint = deliveryFingerprint(dm);
  assert.deepEqual(f.bind({ ...f.request, inputId: dm.inputId }, record), {
    kind: 'gap',
    reason: 'unattributed',
  });
  const created = f.human.execute({
    commandId: 'TEST-create-inline',
    operation: 'task.create',
    payload: { subject: 'TEST inline', owner: 'worker' },
  });
  f.human.execute({
    commandId: 'TEST-inline-start',
    operation: 'task.lifecycle',
    payload: { taskId: created.effects.taskId, action: 'start' },
  });
  assert.equal(
    f.human.pendingDeliveries().some((row) => row.commandId === 'TEST-inline-start'),
    false
  );
  assert.deepEqual(f.bind({ ...f.request, phase: 'gap' }), { kind: 'gap', reason: 'native-gap' });
  const initial = structuredClone(f.record);
  initial.inputs = [];
  assert.deepEqual(f.bind(f.request, initial), { kind: 'gap', reason: 'input' });
});

// Stale member/run selection, revoked authority and altered original plans must fail closed rather than scan for another live Task.
test('Task lookup rejects altered obligations, notification receipts, stale bindings, retraction and revoked authority', (t) => {
  const f = fixture(t);
  const path = `task-obligations/${digest(f.start.commandId)}.json`;
  const original = f.store.read<{
    fingerprint: string;
    deliveries: DeliveryIntent[];
    retractions: [];
  }>(path)!;
  const corrupt = structuredClone(original);
  corrupt.deliveries[0]!.messageId = 'TEST-foreign';
  f.store.write(path, corrupt);
  assert.deepEqual(f.bind(), { kind: 'gap', reason: 'authority' });
  f.store.write(path, original);
  const planPath = `task-plans/${digest(f.start.commandId)}.json`;
  const plan = f.store.read<{ notifications: { messageId: string }[] }>(planPath)!;
  const altered = structuredClone(plan);
  altered.notifications[0]!.messageId = 'TEST-different-message';
  f.store.write(planPath, altered);
  assert.deepEqual(f.bind(), { kind: 'gap', reason: 'storage' });
  f.store.write(planPath, plan);
  assert.throws(() =>
    f.owner.lookupTaskStartCause('human', {
      ...f.intent,
      binding: { ...f.intent.binding, runId: 'TEST-other-run' },
    })
  );
  assert.throws(() =>
    f.owner.lookupTaskStartCause('human', {
      ...f.intent,
      binding: { ...f.intent.binding, memberId: 'lead-id' },
    })
  );
  f.store.write('task-obligations/TEST-retraction.json', {
    fingerprint: 'TEST',
    deliveries: [],
    retractions: [{ intent: f.intent }],
  });
  assert.deepEqual(f.bind(), { kind: 'gap', reason: 'authority' });
});

test('Task lookup requires the current reading principal and original sender grant revision', (t) => {
  const f = fixture(t);
  assert.throws(() => f.owner.lookupTaskStartCause('foreign', f.intent));
  const state = f.store.read<{
    grants: { principalId: string; revoked?: boolean; revision?: number }[];
  }>('state.json')!;
  state.grants.find((grant) => grant.principalId === 'human')!.revision = 2;
  f.store.write('state.json', state);
  assert.deepEqual(f.bind(), { kind: 'gap', reason: 'authority' });
});

// One exact native input binds before/after to one immutable window; unknown handoff may retain ownership without completion proof.
test('tool evidence binds exact session/input/operation/workspace and marks uncertain handoff provenance', (t) => {
  const f = fixture(t);
  const before = f.bind();
  assert.equal(before.kind, 'bound');
  if (before.kind !== 'bound') return;
  const after = f.bind({ ...f.request, phase: 'after' });
  assert.equal(after.kind, 'bound');
  if (after.kind !== 'bound') return;
  assert.equal(before.binding.windowId, after.binding.windowId);
  assert.deepEqual(before.binding.workspace, f.captured.workspace);
  assert.equal(before.binding.binding.memberId, 'worker-id');
  assert.equal(before.binding.binding.runId, 'TEST-run');
  assert.equal(before.binding.provenance.reviewableComplete, false);
  assert.equal(Object.isFrozen(before.binding), true);
  assert.equal(Object.isFrozen(before.binding.workspace), true);
  const unknown = structuredClone(f.record);
  unknown.inputs[0]!.phase = 'unknown';
  const uncertain = f.bind(f.request, unknown);
  assert.equal(uncertain.kind, 'bound');
  if (uncertain.kind === 'bound') {
    assert.equal(uncertain.binding.provenance.outcome, 'unknown');
    assert.equal(uncertain.binding.provenance.reviewableComplete, false);
    assert.equal(uncertain.binding.windowId, before.binding.windowId);
  }
});

// Two in-progress Tasks on the same member/session must retain separate original input windows.
test('separate exact Task inputs never share a window or inherit a tool-supplied workspace', (t) => {
  const f = fixture(t);
  const first = f.bind();
  assert.equal(first.kind, 'bound');
  const created = f.human.execute({
    commandId: 'TEST-create-second',
    operation: 'task.create',
    payload: { subject: 'TEST second task', owner: 'worker' },
  });
  const started = f.human.execute({
    commandId: 'TEST-start-second',
    operation: 'task.start',
    payload: { taskId: created.effects.taskId, notification: 'user' },
  });
  const intent = f.human
    .pendingDeliveries()
    .find((entry) => entry.commandId === started.commandId)!;
  const second = structuredClone(f.record);
  second.inputs = [
    {
      intent,
      fingerprint: deliveryFingerprint(intent),
      operationRef: 'TEST-second-operation',
      phase: 'consumed',
    },
  ];
  const request = Object.assign(
    { ...f.request, inputId: intent.inputId, operationRef: 'TEST-second-operation' },
    { toolInput: { file_path: '/TEST/arbitrary-tool-workspace' } }
  );
  const result = f.bind(request, second);
  assert.equal(result.kind, 'bound');
  if (first.kind === 'bound' && result.kind === 'bound') {
    assert.ok('taskId' in result.binding);
    assert.equal(result.binding.taskId, created.effects.taskId);
    assert.notEqual(result.binding.windowId, first.binding.windowId);
    assert.equal(result.binding.workspace.path, f.root);
  }
});

// A stale callback must not inherit a new session, operation, generation or workspace by coincidence.
test('mismatched Runtime records and unhanded/retracted inputs produce explicit evidence gaps', (t) => {
  const f = fixture(t);
  for (const change of [
    (record: RuntimeSessionRecord) => {
      record.sessionRef = 'TEST-other-session';
    },
    (record: RuntimeSessionRecord) => {
      record.hostIncarnation = 'TEST-prior-host';
    },
    (record: RuntimeSessionRecord) => {
      record.binding.generation = '2';
    },
    (record: RuntimeSessionRecord) => {
      record.config = { ...record.config!, configRevision: 'TEST-other-config' };
    },
    (record: RuntimeSessionRecord) => {
      record.inputs[0]!.operationRef = 'TEST-other-operation';
    },
    (record: RuntimeSessionRecord) => {
      record.inputs[0]!.fingerprint = 'TEST-corrupt';
    },
    (record: RuntimeSessionRecord) => {
      record.inputs[0]!.phase = 'admitted';
    },
    (record: RuntimeSessionRecord) => {
      record.inputs[0]!.phase = 'not-sent';
    },
    (record: RuntimeSessionRecord) => {
      record.inputs[0]!.phase = 'terminal';
      record.inputs[0]!.terminal = 'cancelled';
    },
  ]) {
    const record = structuredClone(f.record);
    change(record);
    assert.equal(f.bind(f.request, record).kind, 'gap');
  }
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(f.bind({ ...f.request, signal: cancelled.signal }), {
    kind: 'gap',
    reason: 'aborted',
  });
});

test('assigned immediate Create supplies only its original canonical user-start cause across cold reopen', (t) => {
  const f = fixture(t);
  const created = f.human.execute({
    commandId: 'TEST-immediate-create-cause',
    operation: 'task.create',
    payload: {
      subject: 'TEST actual immediate cause',
      owner: 'worker',
      prompt: 'TEST prompt is content, not attribution',
      startImmediately: true,
    },
  });
  const intent = f.human.pendingDeliveries().find((row) => row.commandId === created.commandId)!;
  assert.ok(intent);
  const cause = f.owner.lookupTaskStartCause('human', intent)!;
  assert.equal(cause.taskId, created.effects.taskId);
  assert.equal(cause.taskStartCommandId, created.commandId);
  assert.equal(cause.messageId, created.effects.messageId);
  assert.deepEqual(
    createFilesystemTeamOwner(f.options).lookupTaskStartCause('human', intent),
    cause
  );
  assert.throws(() =>
    f.owner.connect('worker-principal').execute({
      commandId: 'TEST-agent-user-start',
      operation: 'task.create',
      payload: {
        subject: 'TEST forbidden user start',
        owner: 'worker',
        startImmediately: true,
      },
    })
  );
});
