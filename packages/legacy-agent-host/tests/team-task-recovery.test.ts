import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { digest } from '../dist/team/identity.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type {
  DeliveryAdmission,
  DeliveryIntent,
  TeamCommand,
  TeamRuntimeDeliveryPort,
} from '../dist/team/contracts.js';
import type { TestContext } from 'node:test';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';

class InterruptedPlan extends TaskEffectPlan {
  fail: ((path: string) => boolean) | undefined;
  protected override afterPublish(_index: number, path: string): void {
    if (this.fail?.(path)) {
      this.fail = undefined;
      throw new Error('TEST interrupted product publication');
    }
  }
}

function fixture(t: TestContext, makeStore?: (root: string) => TeamOwnerStore) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-plan-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const store = makeStore?.(root) ?? new TeamOwnerStore(root, binding.teamName);
  const plan = new InterruptedPlan(root, binding.teamName, store);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    taskMutations: plan,
    members: ['lead', 'alice', 'bob'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'lead' ? 'lead' : 'member',
      delivery: { ...binding, runId: 'TEST-run', memberId: `${name}-id`, generation: '1' },
    })),
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      ...['lead', 'alice', 'bob'].map((name) => ({
        principalId: `${name}-session`,
        memberName: name,
        permissions: ['read', 'task.write', 'message.write'] as (
          | 'read'
          | 'task.write'
          | 'message.write'
        )[],
      })),
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const human = owner.connect('human');
  const taskPath = (id: string) => join(root, 'tasks', binding.teamName, `${id}.json`);
  const inboxPath = (name: string) =>
    join(root, 'teams', binding.teamName, 'inboxes', `${name}.json`);
  const create = (commandId: string, ownerName = 'alice', blockedBy?: string[]): TeamCommand => ({
    commandId,
    operation: 'task.create',
    payload: { subject: commandId, owner: ownerName, ...(blockedBy ? { blockedBy } : {}) },
  });
  const reopen = () => {
    const { taskMutations: _plan, ...reopened } = options;
    return createFilesystemTeamOwner(reopened);
  };
  return { root, store, plan, options, owner, human, create, taskPath, inboxPath, reopen };
}

const hold = (error: unknown) => error instanceof TeamOwnerError && error.code === 'hold';

function proof(
  intent: DeliveryIntent,
  phase: string,
  outcome: DeliveryAdmission['outcome']
): DeliveryAdmission {
  const { backendId, teamId, runId, memberId, generation } = intent.binding;
  return {
    inputId: intent.inputId,
    outcome,
    receipt: {
      schemaVersion: 1,
      inputId: intent.inputId,
      binding: { backendId, teamId, runId, memberId, generation },
      fingerprint: deliveryFingerprint(intent),
      operationRef: `TEST-${intent.inputId}`,
      phase,
    },
  };
}

function runtime(
  f: ReturnType<typeof fixture>,
  phase = 'cancelled'
): TeamRuntimeDeliveryPort & { cancellations: string[] } {
  const cancellations: string[] = [];
  return {
    fingerprintDelivery: deliveryFingerprint,
    cancellations,
    async admitDelivery(intent) {
      assert.ok(f.owner.authorizeDeliveryIntent(intent, 'admit'));
      return proof(intent, 'admitted', 'admitted');
    },
    async lookupDelivery(intent) {
      assert.ok(f.owner.authorizeDeliveryIntent(intent, 'read'));
      return { inputId: intent.inputId, outcome: 'not_admitted' };
    },
    async cancelDelivery(intent) {
      assert.ok(f.owner.authorizeDeliveryIntent(intent, 'control'));
      cancellations.push(intent.inputId);
      const value =
        phase === 'cancelled'
          ? proof(intent, phase, 'not_admitted')
          : phase === 'not-sent'
            ? proof(intent, phase, 'admitted')
            : { inputId: intent.inputId, outcome: 'unknown' as const };
      // Real TEST durable cancellation evidence; restart may lose the response but never changes the ID.
      writeFileSync(join(f.root, `TEST-cancel-${intent.inputId}.json`), JSON.stringify(value));
      return value;
    },
  };
}

test('crash after task publication resumes original assignment notification and outbox without canonical replay', async (t) => {
  const f = fixture(t);
  f.plan.fail = (path) => path.startsWith('tasks/');
  const command = f.create('create-interrupted');
  assert.throws(() => f.human.execute(command), hold);
  const receipt = f.human.lookup(command.commandId)!;
  const originalTask = readFileSync(f.taskPath(receipt.effects.taskId), 'utf8');
  assert.throws(() => readFileSync(f.inboxPath('alice')));
  const prepared = f.store.read<{ notifications: { messageId: string }[] }>(
    `task-plans/${digest(command.commandId)}.json`
  )!;
  const reopened = f.reopen();
  assert.deepEqual(await reopened.resumeTaskCommands(), [
    { commandId: command.commandId, outcome: 'completed' },
  ]);
  assert.equal(readFileSync(f.taskPath(receipt.effects.taskId), 'utf8'), originalTask);
  const inbox = JSON.parse(readFileSync(f.inboxPath('alice'), 'utf8')) as { messageId: string }[];
  assert.deepEqual(
    inbox.map((row) => row.messageId),
    prepared.notifications.map((row) => row.messageId)
  );
  const intents = reopened.connect('human').pendingDeliveries();
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.messageId, inbox[0]?.messageId);
  const bytes = readFileSync(f.inboxPath('alice'), 'utf8');
  assert.equal(reopened.connect('human').execute(command).phase, 'completed');
  assert.equal(readFileSync(f.inboxPath('alice'), 'utf8'), bytes);
});

test('partial dependency notifications recover exact comments and notification IDs once', async (t) => {
  const f = fixture(t);
  const blocker = f.human.execute(f.create('blocker'));
  const a = f.human.execute(f.create('dependent-A', 'alice', [blocker.effects.taskId]));
  const b = f.human.execute(f.create('dependent-B', 'bob', [blocker.effects.taskId]));
  const command: TeamCommand = {
    commandId: 'complete-blocker',
    operation: 'task.lifecycle',
    payload: { taskId: blocker.effects.taskId, action: 'complete' },
  };
  f.plan.fail = (path) => path.endsWith('/inboxes/alice.json');
  assert.throws(() => f.human.execute(command), hold);
  const firstInbox = readFileSync(f.inboxPath('alice'), 'utf8');
  const firstTask = readFileSync(f.taskPath(a.effects.taskId), 'utf8');
  const reopened = f.reopen();
  assert.equal((await reopened.resumeTaskCommands())[0]?.outcome, 'completed');
  assert.equal(readFileSync(f.inboxPath('alice'), 'utf8'), firstInbox);
  assert.equal(readFileSync(f.taskPath(a.effects.taskId), 'utf8'), firstTask);
  for (const id of [a.effects.taskId, b.effects.taskId]) {
    const task = reopened.connect('human').getTask(id);
    const comments = task.comments as { id: string }[];
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.id, `dep-resolved-${blocker.effects.taskId}-${id}`);
  }
  assert.equal((JSON.parse(readFileSync(f.inboxPath('bob'), 'utf8')) as unknown[]).length, 1);
  assert.equal(reopened.connect('human').pendingDeliveries().length, 3);
});

for (const changed of ['source', 'replaced', 'stage', 'authority', 'recipient'] as const) {
  test(`prepared Task recovery HOLD preserves newer evidence after ${changed} change`, async (t) => {
    const f = fixture(t);
    f.plan.fail = (path) => path.startsWith('tasks/');
    const command = f.create(`change-${changed}`);
    assert.throws(() => f.human.execute(command), hold);
    const receipt = f.human.lookup(command.commandId)!;
    const path = f.taskPath(receipt.effects.taskId);
    const plan = f.store.read<{ writes: { path: string; stage: string }[] }>(
      `task-plans/${digest(command.commandId)}.json`
    )!;
    if (changed === 'source')
      writeFileSync(
        path,
        JSON.stringify({
          ...JSON.parse(readFileSync(path, 'utf8')),
          status: 'deleted',
          deletedAt: 'TEST-newer-tombstone',
        })
      );
    if (changed === 'replaced') {
      renameSync(path, `${path}.old`);
      writeFileSync(path, readFileSync(`${path}.old`));
    }
    if (changed === 'stage') {
      const pending = plan.writes.find((write) => write.path.includes('/inboxes/'))!;
      writeFileSync(join(f.root, pending.stage), '[]');
    }
    if (changed === 'authority') f.human.revoke('human');
    if (changed === 'recipient') {
      const state = f.store.read<{ members: { name: string; delivery: { generation: string } }[] }>(
        'state.json'
      )!;
      state.members.find((member) => member.name === 'alice')!.delivery.generation = '2';
      f.store.write('state.json', state);
    }
    const before = readFileSync(path, 'utf8');
    assert.equal((await f.reopen().resumeTaskCommands())[0]?.outcome, 'held');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.throws(() => readFileSync(f.inboxPath('alice')));
  });
}

test('Task delete publishes only after exact Runtime cancellation, UNKNOWN preserves original inbox and task', async (t) => {
  for (const phase of ['unknown', 'cancelled', 'not-sent']) {
    const f = fixture(t);
    const created = f.human.execute(f.create(`delete-${phase}`));
    const intent = f.human.pendingDeliveries()[0]!;
    const inboxBefore = readFileSync(f.inboxPath('alice'), 'utf8');
    const taskBefore = readFileSync(f.taskPath(created.effects.taskId), 'utf8');
    const command: TeamCommand = {
      commandId: `delete-${phase}`,
      operation: 'task.lifecycle',
      payload: { taskId: created.effects.taskId, action: 'delete' },
    };
    command.commandId += '-command';
    assert.throws(() => f.human.execute(command), hold);
    assert.equal(f.owner.authorizeDeliveryIntent(intent, 'dispatch'), false);
    const port = runtime(f, phase);
    const result = await f.owner.resumeTaskCommands(port);
    assert.deepEqual(port.cancellations, [intent.inputId]);
    if (phase === 'unknown') {
      assert.equal(result[0]?.outcome, 'held');
      assert.equal(readFileSync(f.inboxPath('alice'), 'utf8'), inboxBefore);
      assert.equal(readFileSync(f.taskPath(created.effects.taskId), 'utf8'), taskBefore);
    } else {
      assert.equal(result[0]?.outcome, 'completed');
      assert.equal(f.human.getTask(created.effects.taskId).status, 'deleted');
      assert.deepEqual(JSON.parse(readFileSync(f.inboxPath('alice'), 'utf8')), []);
      assert.equal(
        f.store.read<DeliveryIntent>(`outbox/${intent.deliveryId}.json`)?.phase,
        phase === 'not-sent' ? 'admitted' : 'not_admitted'
      );
      assert.equal(f.owner.authorizeDeliveryIntent(intent, 'dispatch'), false);
    }
  }
});

test('Runtime control checks captured current principal grants and exact binding after revocation', (t) => {
  const f = fixture(t);
  const binding = f.options.members.find((member) => member.name === 'alice')!.delivery!;
  assert.equal(f.owner.authorizeRuntimeAccess('human', binding, 'control'), true);
  assert.equal(f.owner.authorizeRuntimeAccess('alice-session', binding, 'control'), true);
  assert.equal(f.owner.authorizeRuntimeAccess('bob-session', binding, 'control'), false);
  assert.equal(
    f.owner.authorizeRuntimeAccess('human', { ...binding, generation: '2' }, 'read'),
    false
  );
  f.human.revoke('alice-session');
  assert.equal(f.owner.authorizeRuntimeAccess('alice-session', binding, 'control'), false);
  assert.equal(f.owner.authorizeRuntimeAccess('human', binding, 'control'), true);
});

class FailPlanOnce extends TeamOwnerStore {
  fail = true;
  override write(name: string, value: unknown): void {
    if (this.fail && name.startsWith('task-plans/')) {
      this.fail = false;
      throw new Error('TEST crash before durable Task plan');
    }
    super.write(name, value);
  }
}

test('crash before durable Task plan can prepare again only with proven unchanged product preimage', async (t) => {
  const f = fixture(t, (root) => new FailPlanOnce(root, 'test-team'));
  const command = f.create('before-plan');
  assert.throws(() => f.human.execute(command), hold);
  const receipt = f.human.lookup(command.commandId)!;
  assert.throws(() => readFileSync(f.taskPath(receipt.effects.taskId)));
  assert.equal((await f.reopen().resumeTaskCommands())[0]?.outcome, 'completed');
  assert.equal(f.human.getTask(receipt.effects.taskId).status, 'pending');
});

class ChangeSourceDuringPrepare extends TeamOwnerStore {
  override write(name: string, value: unknown): void {
    if (name.startsWith('task-plans/')) {
      const path = join(this.root, 'teams', 'test-team', 'config.json');
      writeFileSync(
        path,
        JSON.stringify({
          ...JSON.parse(readFileSync(path, 'utf8')),
          description: 'TEST concurrent product edit',
        })
      );
    }
    super.write(name, value);
  }
}

test('source change while detached canonical policy prepares is detected before live Task publication', async (t) => {
  const f = fixture(t, (root) => new ChangeSourceDuringPrepare(root, 'test-team'));
  const command = f.create('concurrent-source');
  assert.throws(() => f.human.execute(command), hold);
  const receipt = f.human.lookup(command.commandId)!;
  assert.throws(() => readFileSync(f.taskPath(receipt.effects.taskId)));
  assert.equal((await f.reopen().resumeTaskCommands())[0]?.outcome, 'held');
  assert.throws(() => readFileSync(f.taskPath(receipt.effects.taskId)));
});

class FailRetractionProjection extends TeamOwnerStore {
  armed = false;
  override write(name: string, value: unknown): void {
    if (
      this.armed &&
      name.startsWith('outbox/') &&
      (value as DeliveryIntent).phase === 'not_admitted'
    ) {
      this.armed = false;
      throw new Error('TEST lost cancellation projection');
    }
    super.write(name, value);
  }
}

test('persisted cancellation evidence is revalidated after crash before inbox retraction publication', async (t) => {
  const f = fixture(t, (root) => new FailRetractionProjection(root, 'test-team'));
  const created = f.human.execute(f.create('proof-source'));
  const command: TeamCommand = {
    commandId: 'delete-proof-source',
    operation: 'task.lifecycle',
    payload: { taskId: created.effects.taskId, action: 'delete' },
  };
  assert.throws(() => f.human.execute(command), hold);
  const before = readFileSync(f.inboxPath('alice'), 'utf8');
  (f.store as FailRetractionProjection).armed = true;
  assert.equal((await f.owner.resumeTaskCommands(runtime(f)))[0]?.outcome, 'held');
  const key = `task-obligations/${digest(command.commandId)}.json`;
  const obligations = f.store.read<{
    retractions: { proof: { receipt: { binding: { runId: string } } } }[];
  }>(key)!;
  obligations.retractions[0]!.proof.receipt.binding.runId = 'TEST-wrong-run';
  f.store.write(key, obligations);
  assert.equal((await f.reopen().resumeTaskCommands(runtime(f)))[0]?.outcome, 'held');
  assert.equal(readFileSync(f.inboxPath('alice'), 'utf8'), before);
  assert.equal(f.human.getTask(created.effects.taskId).status, 'pending');
});

test('settled Task assignment retracts product inbox after real Runtime terminal and reopen without resubmit', async (t) => {
  const f = fixture(t);
  let team = f.owner;
  const created = f.human.execute({
    commandId: 'terminal-create',
    operation: 'task.create',
    payload: { subject: 'Terminal assignment' },
  });
  f.human.execute({
    commandId: 'terminal-assign',
    operation: 'task.assign',
    payload: { taskId: created.effects.taskId, owner: 'alice' },
  });
  const intent = f.human.pendingDeliveries()[0]!;
  assert.equal(f.human.pendingDeliveries().length, 1);
  const inputs: Input[] = [];
  let emit!: (event: Event) => void;
  const terminalEvent = new Promise<Event>((resolve) => {
    emit = resolve;
  });
  const session: Session = {
    sessionRef: 'TEST-terminal-session',
    async submit(input) {
      inputs.push(input);
      return {
        ok: true,
        value: {
          inputId: input.inputId,
          operationRef: input.operationRef,
          delivery: 'client-consumed',
          providerAcceptance: 'unknown',
        },
      };
    },
    observe: async function* () {
      yield await terminalEvent;
    },
    async checkReadiness() {
      return { ok: true, value: undefined };
    },
    checkpoint() {
      return { ok: false, code: 'unsupported' };
    },
    async respondToInteraction() {
      return { ok: true, value: undefined };
    },
    async interrupt() {
      return { ok: true, value: { requested: true, terminal: 'unconfirmed' } };
    },
    async close() {
      return { logicallyClosed: true, cleanup: 'confirmed' };
    },
  };
  let opens = 0;
  const runtimeRoot = join(f.root, 'TEST-runtime');
  const makeRuntime = (hostIncarnation: string) =>
    new RuntimeOwner({
      store: new FileRuntimeStore(runtimeRoot),
      profileId: 'TEST-profile',
      hostIncarnation,
      driverFactory: {
        async open() {
          opens++;
          return { driver: session, capabilities: ['tools'] };
        },
      },
      authorize: (binding, action, original) =>
        original
          ? team.authorizeDeliveryIntent(original, action)
          : team.authorizeMemberBinding(binding, action),
      canDispatch: (binding, original) =>
        team.authorizeMemberBinding(binding, 'dispatch') &&
        team.authorizeDeliveryIntent(original!, 'dispatch'),
    });
  const runtime = makeRuntime('TEST-first-host');
  await runtime.openSession({
    binding: intent.binding,
    config: {
      tenantId: 'TEST-backend',
      projectId: 'TEST-project',
      sessionId: session.sessionRef,
      generation: 1,
      configRevision: 'TEST-config',
      requiredCapabilities: ['tools'],
    },
  });
  assert.equal((await team.resumeDeliveries(runtime))[0]?.outcome, 'admitted');
  await runtime.dispatchNext(intent.binding);
  assert.equal(inputs.length, 1);
  const submitted = inputs[0]!;
  emit({
    kind: 'result',
    sessionRef: session.sessionRef,
    inputId: submitted.inputId,
    operationRef: submitted.operationRef,
    outcome: 'succeeded',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    (await runtime.lookupDelivery(intent)).receipt &&
      runtime.readSession(intent.binding).record?.inputs[0]?.phase,
    'terminal'
  );
  const command: TeamCommand = {
    commandId: 'terminal-delete',
    operation: 'task.lifecycle',
    payload: { taskId: created.effects.taskId, action: 'delete' },
  };
  assert.throws(() => f.human.execute(command), hold);
  team = f.reopen();
  const reopenedRuntime = makeRuntime('TEST-reopened-host');
  let cancellations = 0;
  const port: TeamRuntimeDeliveryPort = {
    admitDelivery: (original) => reopenedRuntime.admitDelivery(original),
    lookupDelivery: (original) => reopenedRuntime.lookupDelivery(original),
    fingerprintDelivery: (original) => reopenedRuntime.fingerprintDelivery(original),
    async cancelDelivery(original) {
      cancellations++;
      return reopenedRuntime.cancelDelivery(original);
    },
  };
  assert.deepEqual(await team.resumeTaskCommands(port), [
    { commandId: command.commandId, outcome: 'completed' },
  ]);
  assert.equal(team.connect('human').getTask(created.effects.taskId).status, 'deleted');
  assert.deepEqual(JSON.parse(readFileSync(f.inboxPath('alice'), 'utf8')), []);
  const original = f.store.read<DeliveryIntent>(`outbox/${intent.deliveryId}.json`)!;
  assert.equal(original.phase, 'admitted');
  assert.equal((original.runtimeReceipt as { phase: string }).phase, 'terminal');
  assert.equal(cancellations, 0, 'settled native work is not labelled cancelled or unsent');
  assert.equal(inputs.length, 1);
  assert.equal(opens, 1);
  assert.equal(team.connect('human').execute(command).phase, 'completed');
  assert.deepEqual(await team.resumeTaskCommands(port), []);
  assert.equal(inputs.length, 1);
});

test('stale held Task plan cannot deny independent Message Runtime lookup or cancellation', async (t) => {
  const f = fixture(t);
  f.plan.fail = (path) => path.startsWith('tasks/');
  const taskCommand = f.create('stale-unrelated');
  assert.throws(() => f.human.execute(taskCommand), hold);
  const held = f.human.lookup(taskCommand.commandId)!;
  const taskPath = f.taskPath(held.effects.taskId);
  writeFileSync(
    taskPath,
    JSON.stringify({
      ...JSON.parse(readFileSync(taskPath, 'utf8')),
      description: 'TEST newer source',
    })
  );
  f.human.execute({
    commandId: 'independent-message',
    operation: 'message.send',
    payload: { to: 'alice', text: 'Independent queued message' },
  });
  const intent = f.human
    .pendingDeliveries()
    .find((entry) => entry.commandId === 'independent-message')!;
  const runtime = new RuntimeOwner({
    store: new FileRuntimeStore(join(f.root, 'TEST-independent-runtime')),
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    driverFactory: {
      async open() {
        throw new Error('TEST must not open a provider');
      },
    },
    authorize: (_binding, action, original) =>
      !!original && f.owner.authorizeDeliveryIntent(original, action),
  });
  assert.equal((await runtime.admitDelivery(intent)).outcome, 'admitted');
  assert.equal((await runtime.lookupDelivery(intent)).outcome, 'admitted');
  const cancelled = await runtime.cancelDelivery(intent);
  assert.equal(cancelled.outcome, 'not_admitted');
  assert.equal((cancelled.receipt as { phase: string }).phase, 'cancelled');
  assert.equal((await f.owner.resumeTaskCommands(runtime))[0]?.outcome, 'held');
  assert.equal(f.human.lookup(taskCommand.commandId)?.phase, 'held');
});

class FailInitialObligations extends TeamOwnerStore {
  fail = true;
  override write(name: string, value: unknown): void {
    if (this.fail && name.startsWith('task-obligations/')) {
      this.fail = false;
      throw new Error('TEST crash after Task plan before recipient obligations');
    }
    super.write(name, value);
  }
}

test('crash after Task plan before obligations retains original recipient generation and HOLDs replacement', async (t) => {
  const f = fixture(t, (root) => new FailInitialObligations(root, 'test-team'));
  const command = f.create('captured-plan-recipient');
  assert.throws(() => f.human.execute(command), hold);
  const receipt = f.human.lookup(command.commandId)!;
  assert.ok(f.store.read(`task-plans/${digest(command.commandId)}.json`));
  assert.equal(f.store.read(`task-obligations/${digest(command.commandId)}.json`), undefined);
  assert.equal(
    receipt.taskRecipients?.find((member) => member.name === 'alice')?.delivery?.generation,
    '1'
  );
  const state = f.store.read<{ members: { name: string; delivery: { generation: string } }[] }>(
    'state.json'
  )!;
  state.members.find((member) => member.name === 'alice')!.delivery.generation = '2';
  f.store.write('state.json', state);
  let runtimeCalls = 0;
  const port: TeamRuntimeDeliveryPort = {
    fingerprintDelivery: deliveryFingerprint,
    async lookupDelivery() {
      runtimeCalls++;
      throw new Error('TEST no replacement lookup');
    },
    async admitDelivery() {
      runtimeCalls++;
      throw new Error('TEST no replacement admission');
    },
  };
  const reopened = f.reopen();
  assert.equal((await reopened.resumeTaskCommands(port))[0]?.outcome, 'held');
  assert.deepEqual(reopened.connect('human').pendingDeliveries(), []);
  assert.deepEqual(await reopened.resumeDeliveries(port), []);
  assert.equal(runtimeCalls, 0);
  assert.throws(() => readFileSync(f.taskPath(receipt.effects.taskId)));
  assert.throws(() => readFileSync(f.inboxPath('alice')));
  const obligations = f.store.read<{ deliveries: DeliveryIntent[] }>(
    `task-obligations/${digest(command.commandId)}.json`
  )!;
  assert.equal(obligations.deliveries[0]?.binding.generation, '1');
});

test('partial assigned immediate creation recovers exact task, related backlink, prompt and user-start cause without replay', async (t) => {
  const f = fixture(t);
  const base = f.human.execute({
    commandId: 'TEST-related-base',
    operation: 'task.create',
    payload: { subject: 'TEST related base' },
  });
  const command: TeamCommand = {
    commandId: 'TEST-create-rich-start',
    operation: 'task.create',
    payload: {
      subject: 'TEST rich start',
      owner: 'alice',
      related: [base.effects.taskId],
      prompt: 'TEST retained instructions',
      startImmediately: true,
      promptTaskRefs: [{ taskId: base.effects.taskId, displayId: '1', teamName: 'test-team' }],
    },
  };
  f.plan.fail = (path) => path.startsWith('tasks/');
  assert.throws(() => f.human.execute(command), hold);
  const original = f.human.lookup(command.commandId)!;
  const prepared = f.store.read<{ notifications: { messageId: string }[] }>(
    `task-plans/${digest(command.commandId)}.json`
  )!;
  assert.deepEqual(
    prepared.notifications.map((row) => row.messageId),
    [original.effects.messageId]
  );
  const reopened = f.reopen();
  assert.deepEqual(await reopened.resumeTaskCommands(), [
    { commandId: command.commandId, outcome: 'completed' },
  ]);
  const human = reopened.connect('human');
  const task = human.getTask(original.effects.taskId);
  assert.equal(task.status, 'in_progress');
  assert.equal(task.prompt, 'TEST retained instructions');
  assert.deepEqual(human.getTask(base.effects.taskId).related, [original.effects.taskId]);
  const rows = JSON.parse(readFileSync(f.inboxPath('alice'), 'utf8')) as { messageId: string }[];
  assert.equal(rows.filter((row) => row.messageId === original.effects.messageId).length, 1);
  const intent = human.pendingDeliveries().find((row) => row.commandId === command.commandId)!;
  assert.ok(intent);
  const cause = reopened.lookupTaskStartCause('human', intent)!;
  assert.equal(cause.taskId, original.effects.taskId);
  assert.equal(cause.taskStartCommandId, command.commandId);
  const before = readFileSync(f.inboxPath('alice'), 'utf8');
  assert.equal(human.execute(command).phase, 'completed');
  assert.equal(readFileSync(f.inboxPath('alice'), 'utf8'), before);
});
