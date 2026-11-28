import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { digest } from '../dist/team/identity.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { CommandReceipt, DeliveryAdmission, DeliveryIntent, TeamCommand, TeamRuntimeDeliveryPort } from '../dist/team/contracts.js';
import type { TeamInputPreflight } from '../dist/team/ports.js';
import type { TestContext } from 'node:test';

class InterruptedStore extends TeamOwnerStore {
  failPhase: CommandReceipt['phase'] | undefined;
  override write(name: string, value: unknown): void {
    super.write(name, value);
    const receipt = value as Partial<CommandReceipt>;
    if (this.failPhase === receipt.phase && receipt.command?.operation === 'task.update') {
      this.failPhase = undefined;
      throw new Error('TEST interrupted edit receipt');
    }
  }
}

class InterruptedPlan extends TaskEffectPlan {
  failTask = false;
  protected override afterPublish(_index: number, path: string): void {
    if (this.failTask && path.startsWith('tasks/')) {
      this.failTask = false;
      throw new Error('TEST interrupted edit before inbox publication');
    }
  }
}

interface InboxRow {
  text: string;
  messageId: string;
  timestamp: string;
  from: string;
}

function fixture(t: TestContext, settings: { live?: boolean; lead?: boolean; inputPreflight?: TeamInputPreflight } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-notice-parity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-notices' };
  const store = new InterruptedStore(root, binding.teamName);
  const plan = new InterruptedPlan(root, binding.teamName, store);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    taskMutations: plan,
    ...(settings.inputPreflight ? { inputPreflight: settings.inputPreflight } : {}),
    members: ['Lead', 'alice', 'bob'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'Lead' && settings.lead !== false ? 'lead' : 'member',
      ...(settings.live === false
        ? {}
        : {
            delivery: { ...binding, runId: 'TEST-run', memberId: `${name}-id`, generation: '1' },
          }),
    })),
    grants: ['user', 'Lead', 'alice', 'bob'].map((name) => ({
      principalId: name,
      memberName: name,
      permissions: ['read', 'task.write', 'message.write', 'admin'],
    })),
  };
  const owner = createFilesystemTeamOwner(options),
    human = owner.connect('user');
  const taskId = human.execute({
    commandId: 'TEST-initial',
    operation: 'task.create',
    payload: { subject: 'Original task', description: 'Original details', owner: 'alice' },
  }).effects.taskId;
  const inboxPath = (name: string) =>
    join(root, 'teams', binding.teamName, 'inboxes', `${name}.json`);
  const inbox = (name: string): InboxRow[] =>
    existsSync(inboxPath(name))
      ? (JSON.parse(readFileSync(inboxPath(name), 'utf8')) as InboxRow[])
      : [];
  const edit: TeamCommand = {
    commandId: 'TEST-edit',
    operation: 'task.update',
    payload: { taskId, subject: 'Corrected task', description: '' },
  };
  const reopen = () => {
    const { taskMutations: _plan, ...reopened } = options;
    return createFilesystemTeamOwner(reopened);
  };
  return {
    root,
    binding,
    store,
    plan,
    options,
    owner,
    human,
    taskId,
    inboxPath,
    inbox,
    edit,
    reopen,
  };
}

const hold = (error: unknown) => error instanceof TeamOwnerError && error.code === 'hold';

test('task byte refusal preserves title, board, inboxes and task plan before publication', t => {
  let limit = 256 * 1024;
  const seen: Parameters<TeamInputPreflight>[0][] = [];
  const f = fixture(t, { inputPreflight(input) {
    seen.push(structuredClone(input)); return Buffer.byteLength(input.content) <= limit;
  } });
  const original = f.human.getTask(f.taskId);
  const before = f.store.productFingerprint(f.binding.teamName);
  const plans = f.store.list('task-plans').length, obligations = f.store.list('task-obligations').length;
  limit = 64 * 1024;
  const receipt = f.human.execute({ commandId: 'TEST-large-title', operation: 'task.update',
    payload: { taskId: f.taskId, subject: '界'.repeat(30_000) } });
  t.diagnostic(JSON.stringify({ phase: receipt.phase,
    productChanged: f.store.productFingerprint(f.binding.teamName) !== before,
    planCreated: f.plan.load(receipt) !== undefined }));
  assert.equal(receipt.phase, 'rejected');
  assert.deepEqual(f.human.getTask(f.taskId), original);
  assert.equal(f.store.productFingerprint(f.binding.teamName), before);
  assert.equal(f.plan.load(receipt), undefined);
  assert.equal(f.store.list('task-plans').length, plans);
  assert.equal(f.store.list('task-obligations').length, obligations);
  assert.ok(seen.some(input => input.binding.memberId === 'Lead-id' && Buffer.byteLength(input.content) > limit));
  assert.equal(readdirSync(f.root, { encoding: 'utf8', recursive: true }).some(name => name.endsWith('.stage')), false);
});

for (const kind of ['start', 'comment', 'answer'] as const) {
  test(`oversized ${kind} notification leaves the original task and every inbox unchanged`, t => {
    let limit = 256 * 1024;
    const seen: Parameters<TeamInputPreflight>[0][] = [];
    const f = fixture(t, { inputPreflight(input) {
      seen.push(structuredClone(input)); return Buffer.byteLength(input.content) <= limit;
    } });
    const text = '界'.repeat(30_000);
    if (kind === 'start') f.human.execute({ commandId: 'TEST-start-details', operation: 'task.update',
      payload: { taskId: f.taskId, description: text } });
    if (kind === 'answer') f.human.execute({ commandId: 'TEST-answer-question', operation: 'task.clarification',
      payload: { taskId: f.taskId, value: 'user' } });
    const original = f.human.getTask(f.taskId);
    const command: TeamCommand = kind === 'start'
      ? { commandId: 'TEST-large-start', operation: 'task.start', payload: { taskId: f.taskId, notification: 'user' } }
      : { commandId: 'TEST-large-' + kind, operation: 'task.comment', payload: { taskId: f.taskId, text,
        ...(kind === 'answer' ? { answerClarificationRequestId: String(original.clarificationRequestId) } : {}) } };
    const before = f.store.productFingerprint(f.binding.teamName);
    const plans = f.store.list('task-plans').length, obligations = f.store.list('task-obligations').length;
    seen.length = 0; limit = 64 * 1024;
    const receipt = f.human.execute(command);
    assert.equal(receipt.phase, 'rejected');
    assert.deepEqual(f.human.getTask(f.taskId), original);
    assert.equal(f.store.productFingerprint(f.binding.teamName), before);
    assert.equal(f.plan.load(receipt), undefined);
    assert.equal(f.store.list('task-plans').length, plans);
    assert.equal(f.store.list('task-obligations').length, obligations);
    assert.ok(seen.some(input => input.binding.memberId === 'alice-id' && Buffer.byteLength(input.content) > limit));
    assert.equal(readdirSync(f.root, { encoding: 'utf8', recursive: true }).some(name => name.endsWith('.stage')), false);
  });
}

test('a later oversized reassignment recipient rejects the whole canonical notification batch', t => {
  let enforce = false;
  const seen: string[] = [];
  const f = fixture(t, { inputPreflight(input) {
    if (enforce) seen.push(input.binding.memberId);
    return Buffer.byteLength(input.content) <= (enforce && input.binding.memberId === 'bob-id' ? 64 * 1024 : 256 * 1024);
  } });
  f.owner.connect('alice').execute({ commandId: 'TEST-agent-long-title', operation: 'task.update',
    payload: { taskId: f.taskId, subject: '界'.repeat(30_000) } });
  const before = f.store.productFingerprint(f.binding.teamName);
  enforce = true;
  const receipt = f.human.execute({ commandId: 'TEST-batch-overflow', operation: 'task.assign',
    payload: { taskId: f.taskId, owner: 'bob' } });
  assert.equal(receipt.phase, 'rejected');
  assert.equal(f.store.productFingerprint(f.binding.teamName), before);
  assert.equal(f.human.getTask(f.taskId).owner, 'alice');
  assert.equal(f.plan.load(receipt), undefined);
  assert.ok(seen.indexOf('alice-id') >= 0 && seen.indexOf('alice-id') < seen.indexOf('bob-id'));
  assert.equal(readdirSync(f.root, { encoding: 'utf8', recursive: true }).some(name => name.endsWith('.stage')), false);
});

test('preflight authority errors stay held and do not become known Task policy rejections', t => {
  let changed = false;
  const f = fixture(t, { inputPreflight() {
    if (changed) throw new TeamOwnerError('forbidden'); return true;
  } });
  const before = f.store.productFingerprint(f.binding.teamName);
  changed = true;
  assert.throws(() => f.human.execute(f.edit), hold);
  const receipt = f.human.lookup(f.edit.commandId)!;
  assert.equal(receipt.phase, 'held'); assert.equal(f.plan.load(receipt), undefined);
  assert.equal(f.store.productFingerprint(f.binding.teamName), before);
  assert.equal(readdirSync(f.root, { encoding: 'utf8', recursive: true }).some(name => name.endsWith('.stage')), false);
});

test('large non-notifying fields and offline members keep their existing product behavior', t => {
  const text = '界'.repeat(30_000);
  const live = fixture(t, { inputPreflight: input => Buffer.byteLength(input.content) <= 64 * 1024 });
  assert.equal(live.human.execute({ commandId: 'TEST-long-description', operation: 'task.update',
    payload: { taskId: live.taskId, description: text } }).phase, 'completed');
  assert.equal(live.human.getTask(live.taskId).description, text);
  const offline = fixture(t, { live: false, inputPreflight() { assert.fail('offline inbox is product-only'); } });
  assert.equal(offline.human.execute({ commandId: 'TEST-offline-title', operation: 'task.update',
    payload: { taskId: offline.taskId, subject: text } }).phase, 'completed');
  assert.equal(offline.human.getTask(offline.taskId).subject, text);
  assert.deepEqual(offline.human.pendingDeliveries(), []);
});

for (const stage of ['before-lookup', 'before-cancel', 'before-lookup-proof', 'before-cancel-proof'] as const) {
  test(`loaded task notifications remain held ${stage} without publishing retraction effects`, async t => {
    let enforce = false;
    const f = fixture(t, { inputPreflight(input) {
      return Buffer.byteLength(input.content) <= (enforce && input.binding.memberId === 'bob-id' ? 64 * 1024 : 256 * 1024);
    } });
    f.human.execute({ commandId: 'TEST-long-dependent', operation: 'task.create',
      payload: { subject: '界'.repeat(30_000), owner: 'bob', blockedBy: [f.taskId] } });
    const command: TeamCommand = { commandId: 'TEST-delete-blocker', operation: 'task.lifecycle',
      payload: { taskId: f.taskId, action: 'delete' } };
    assert.throws(() => f.human.execute(command), hold);
    const receipt = f.human.lookup(command.commandId)!;
    const plan = f.plan.load(receipt)!;
    assert.ok(plan.notifications.some(row => row.member === 'bob' && Buffer.byteLength(row.content) > 64 * 1024));
    const key = `task-obligations/${digest(command.commandId)}.json`;
    const original = f.store.read<{ retractions: { intent: DeliveryIntent }[] }>(key)!;
    assert.ok(original.retractions.length > 0, 'real deletion combines original cancellation and a dependent wakeup');
    const before = f.store.productFingerprint(f.binding.teamName);
    const obligations = JSON.stringify(original), planBytes = JSON.stringify(plan);
    const outbox = JSON.stringify(f.store.list('outbox'));
    let lookups = 0, cancellations = 0;
    const gate = Promise.withResolvers<DeliveryAdmission>();
    const cancelled = (intent: DeliveryIntent): DeliveryAdmission => {
      const { backendId, teamId, runId, memberId, generation } = intent.binding;
      return { inputId: intent.inputId, outcome: 'not_admitted', receipt: {
        schemaVersion: 1, inputId: intent.inputId, binding: { backendId, teamId, runId, memberId, generation },
        fingerprint: deliveryFingerprint(intent), operationRef: 'TEST-' + intent.inputId, phase: 'cancelled',
      } };
    };
    const port: TeamRuntimeDeliveryPort = {
      fingerprintDelivery: deliveryFingerprint,
      async admitDelivery() { assert.fail('task recovery cannot admit a replacement input'); },
      async lookupDelivery(intent) {
        lookups++;
        return stage === 'before-cancel-proof' ? { inputId: intent.inputId, outcome: 'unknown' } : gate.promise;
      },
      async cancelDelivery() { cancellations++; return gate.promise; },
    };
    if (stage === 'before-lookup') enforce = true;
    const resumed = f.owner.resumeTaskCommands(port);
    if (stage !== 'before-lookup') {
      const entered = () => stage === 'before-cancel-proof' ? cancellations === 1 : lookups === 1;
      const deadline = performance.now() + 2000;
      try {
        while (!entered() && performance.now() < deadline) await new Promise<void>(done => setImmediate(done));
        assert.ok(entered(), 'the original controlled Runtime boundary was reached');
        enforce = true;
      } finally {
        const intent = original.retractions[0]!.intent;
        gate.resolve(stage === 'before-cancel' ? { inputId: intent.inputId, outcome: 'unknown' } : cancelled(intent));
      }
    }
    assert.deepEqual(await resumed, [{ commandId: command.commandId, outcome: 'held' }]);
    assert.equal(lookups, stage === 'before-lookup' ? 0 : 1);
    assert.equal(cancellations, stage === 'before-cancel-proof' ? 1 : 0);
    assert.equal(f.store.productFingerprint(f.binding.teamName), before);
    assert.equal(JSON.stringify(f.store.read(key)), obligations);
    assert.equal(JSON.stringify(f.plan.load(receipt)), planBytes);
    assert.equal(JSON.stringify(f.store.list('outbox')), outbox);
    assert.equal(f.human.lookup(command.commandId)!.phase, 'held');
  });
}

/** The examples are consumed as tool inputs, not only checked for familiar text. */
function examples(text: string): { name: string; args: Record<string, unknown> }[] {
  const found = [
    ...text.matchAll(
      /\b(task_get|task_start|task_add_comment|task_complete|message_send|group_chat_list|group_chat_create|group_chat_send|group_chat_react)\s+(\{[^\n]*\})/g
    ),
  ];
  assert.ok(found.length, 'The notice must include concrete tool examples');
  return found.map((match) => ({
    name: match[1]!,
    args: JSON.parse(match[2]!) as Record<string, unknown>,
  }));
}

for (const kind of ['assignment', 'comment', 'dependency'] as const) {
  test(`${kind} wakeup examples execute through the captured Host MCP schemas`, (t) => {
    const f = fixture(t);
    let member = 'alice';
    if (kind === 'comment')
      f.human.execute({
        commandId: 'TEST-comment',
        operation: 'task.comment',
        payload: { taskId: f.taskId, text: 'Please check the acceptance criteria.' },
      });
    if (kind === 'dependency') {
      member = 'bob';
      f.human.execute({
        commandId: 'TEST-blocked',
        operation: 'task.create',
        payload: { subject: 'Dependent task', owner: member, blockedBy: [f.taskId] },
      });
      f.human.execute({
        commandId: 'TEST-complete-blocker',
        operation: 'task.lifecycle',
        payload: { taskId: f.taskId, action: 'complete' },
      });
    }
    const notice = f.inbox(member).at(-1)!;
    assert.doesNotMatch(notice.text, /SendMessage|teamName:|from:|actor:/);
    const tools = createTeamMcpTools(f.owner.connect(member));
    const calls = examples(notice.text);
    assert.ok(
      calls.some((call) => call.name === (kind === 'comment' ? 'task_add_comment' : 'task_get'))
    );
    if (kind === 'assignment') assert.ok(calls.some((call) => call.name === 'message_send'));
    for (const [index, call] of calls.entries()) {
      assert.equal(Object.hasOwn(call.args, 'teamName'), false);
      assert.equal(Object.hasOwn(call.args, 'actor'), false);
      assert.equal(Object.hasOwn(call.args, 'from'), false);
      if (call.name !== 'task_get') {
        assert.equal(
          typeof call.args.commandId,
          'string',
          'Every write advertises an idempotency key'
        );
        call.args.commandId = `TEST-example-${kind}-${index}`;
      }
      if (call.name === 'message_send') call.args.to = 'Lead';
      const result = tools.call(call.name, call.args);
      assert.notEqual(result.isError, true, `${call.name} example must be executable`);
      assert.deepEqual(
        tools.call(call.name, call.args),
        result,
        'Retry retains the original result'
      );
    }
  });
}

test('lead and member group briefings use captured group tool schemas', async (t) => {
  const f = fixture(t);
  const accepted: string[] = [];
  const tools = createTeamMcpTools({
    ...f.owner.connect('alice'),
    groups: {
      async list() {
        accepted.push('list');
        return [];
      },
      async execute(_id, request) {
        accepted.push(request.operation);
        return request;
      },
      lookup() {
        return null;
      },
    },
  });
  const leadQueries = f.owner.connect('Lead').readQueries;
  const memberQueries = f.owner.connect('alice').readQueries;
  assert.ok(leadQueries);
  assert.ok(memberQueries?.memberBriefing);
  const lead = await leadQueries.leadBriefing();
  const member = await memberQueries.memberBriefing({
    includeActiveProcesses: false,
  });
  for (const briefing of [lead, member]) {
    assert.doesNotMatch(briefing, /group_chat_(?:list|react)\(teamName, from/);
    const calls = examples(briefing).filter((call) => call.name.startsWith('group_chat_'));
    assert.equal(
      calls.length,
      4,
      'Create, list, send and acknowledge must all match the captured tools'
    );
    for (const [index, call] of calls.entries()) {
      if (call.name !== 'group_chat_list') call.args.commandId = `TEST-group-example-${index}`;
      if (call.args.groupChatId) call.args.groupChatId = '10000000-0000-4000-8000-000000000001';
      if (call.args.messageId) call.args.messageId = '20000000-0000-4000-8000-000000000001';
      assert.notEqual((await tools.callAsync(call.name, call.args)).isError, true);
    }
  }
  assert.deepEqual(accepted.sort(), [
    'create.agent',
    'create.agent',
    'list',
    'list',
    'reaction.ack',
    'reaction.ack',
    'send',
    'send',
  ]);
});

test('human task edits notify the live canonical lead once with retained receipt identity', (t) => {
  const f = fixture(t);
  const receipt = f.human.execute(f.edit);
  assert.equal(receipt.phase, 'completed');
  const messages = f.inbox('Lead');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.messageId, receipt.effects.messageId);
  assert.equal(messages[0]!.timestamp, receipt.createdAt);
  assert.equal(messages[0]!.from, 'user');
  assert.match(messages[0]!.text, /title, description/);
  assert.match(messages[0]!.text, /Corrected task/);
  assert.equal(f.human.getTask(f.taskId).description, '');
  const delivery = f.human.pendingDeliveries().filter((row) => row.commandId === f.edit.commandId);
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0]!.binding.memberId, 'Lead-id');
  assert.equal(delivery[0]!.messageId, receipt.effects.messageId);
  const bytes = readFileSync(f.inboxPath('Lead'), 'utf8');
  assert.deepEqual(f.reopen().connect('user').execute(f.edit), receipt);
  assert.equal(readFileSync(f.inboxPath('Lead'), 'utf8'), bytes);
});

test('human edit by an existing short task ref retains canonical task resolution and notice', (t) => {
  const f = fixture(t);
  const task = f.human.getTask(f.taskId);
  const displayId = task.displayId;
  assert.ok(typeof displayId === 'string' && displayId.length > 0);
  const receipt = f.human.execute({
    commandId: 'TEST-short-edit',
    operation: 'task.update',
    payload: { taskId: displayId, subject: 'Edited by short ref' },
  });
  assert.equal(receipt.phase, 'completed');
  assert.equal(f.human.getTask(f.taskId).subject, 'Edited by short ref');
  assert.equal(f.inbox('Lead')[0]!.messageId, receipt.effects.messageId);
});

for (const mode of ['agent', 'offline', 'missing-lead'] as const) {
  test(`${mode} edit preserves task changes without a synthetic lead wakeup`, (t) => {
    const f = fixture(t, { live: mode !== 'offline', lead: mode !== 'missing-lead' });
    const writer = mode === 'agent' ? f.owner.connect('alice') : f.human;
    assert.equal(writer.execute(f.edit).phase, 'completed');
    assert.equal(f.human.getTask(f.taskId).subject, 'Corrected task');
    assert.equal(f.inbox('Lead').length, 0);
    assert.equal(
      f.human.pendingDeliveries().filter((row) => row.commandId === f.edit.commandId).length,
      0
    );
  });
}

for (const fault of ['task-before-inbox', 'lost-ack'] as const) {
  test(`task edit ${fault} recovery publishes only the original notice and delivery`, async (t) => {
    const f = fixture(t);
    if (fault === 'task-before-inbox') f.plan.failTask = true;
    else f.store.failPhase = 'completed';
    assert.throws(() => f.human.execute(f.edit), hold);
    const original = f.human.lookup(f.edit.commandId)!;
    assert.equal(f.human.getTask(f.taskId).subject, 'Corrected task');
    if (fault === 'task-before-inbox') assert.equal(f.inbox('Lead').length, 0);
    const reopened = f.reopen();
    assert.deepEqual(await reopened.resumeTaskCommands(), [
      { commandId: f.edit.commandId, outcome: 'completed' },
    ]);
    const receipt = reopened.connect('user').execute(f.edit);
    assert.equal(receipt.phase, 'completed');
    assert.equal(f.inbox('Lead').length, 1);
    assert.equal(f.inbox('Lead')[0]!.messageId, original.effects.messageId);
    assert.equal(f.inbox('Lead')[0]!.timestamp, original.createdAt);
    assert.equal(
      reopened
        .connect('user')
        .pendingDeliveries()
        .filter((row) => row.commandId === f.edit.commandId).length,
      1
    );
  });
}

for (const change of ['stopped', 'replacement'] as const) {
  test(`prepared edit notice cannot wake a ${change} Team delivery`, async (t) => {
    const f = fixture(t);
    f.plan.failTask = true;
    assert.throws(() => f.human.execute(f.edit), hold);
    const state = f.store.read<{ members: { delivery?: { generation: string } }[] }>('state.json')!;
    for (const member of state.members) {
      if (change === 'stopped') delete member.delivery;
      else if (member.delivery) member.delivery.generation = 'replacement';
    }
    f.store.write('state.json', state);
    const reopened = f.reopen();
    assert.deepEqual(await reopened.resumeTaskCommands(), [
      { commandId: f.edit.commandId, outcome: 'held' },
    ]);
    assert.equal(f.inbox('Lead').length, 0);
    assert.equal(
      reopened
        .connect('user')
        .pendingDeliveries()
        .filter((row) => row.commandId === f.edit.commandId).length,
      0
    );
  });
}

for (const change of ['lead', 'missing-lead', 'description'] as const) {
  test(`unplanned prepared edit holds after original ${change} snapshot changes`, (t) => {
    const f = fixture(t);
    f.store.failPhase = 'prepared';
    assert.throws(() => f.human.execute(f.edit), /TEST interrupted edit receipt/);
    assert.equal(f.human.lookup(f.edit.commandId)?.phase, 'prepared');
    const path =
      change === 'description'
        ? join(f.root, 'tasks', f.binding.teamName, `${f.taskId}.json`)
        : join(f.root, 'teams', f.binding.teamName, 'config.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      description?: string;
      members?: { name: string; agentType: string }[];
    };
    if (change === 'description') value.description = 'A newer edit must not be overwritten';
    else
      for (const member of value.members!)
        member.agentType =
          change === 'lead' && member.name === 'bob' ? 'team-lead' : 'general-purpose';
    writeFileSync(path, JSON.stringify(value));
    const bytes = readFileSync(path, 'utf8');
    assert.throws(() => f.reopen().connect('user').execute(f.edit), hold);
    assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.equal(f.inbox('Lead').length, 0);
    assert.equal(f.inbox('bob').length, 0);
  });
}

test('unchanged prepared edit can still finish against its original live lead', (t) => {
  const f = fixture(t);
  f.store.failPhase = 'prepared';
  assert.throws(() => f.human.execute(f.edit), /TEST interrupted edit receipt/);
  const original = f.human.lookup(f.edit.commandId)!;
  const receipt = f.reopen().connect('user').execute(f.edit);
  assert.equal(receipt.phase, 'completed');
  assert.equal(f.inbox('Lead')[0]!.messageId, original.effects.messageId);
});
