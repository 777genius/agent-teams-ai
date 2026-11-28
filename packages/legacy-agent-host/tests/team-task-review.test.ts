import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import type { TestContext } from 'node:test';
import type { CommandReceipt, TeamCommand } from '../dist/team/contracts.js';

class InterruptedReview extends TaskEffectPlan {
  interrupted = false;
  beforePublish?: () => void;
  override publish(receipt: CommandReceipt): void {
    const effect = this.beforePublish;
    delete this.beforePublish;
    effect?.();
    super.publish(receipt);
  }
  protected override afterPublish(_index: number, path: string): void {
    if (this.interrupted && path.startsWith('tasks/')) {
      this.interrupted = false;
      throw new Error('TEST review publication interrupted');
    }
  }
}

function fixture(t: TestContext, reviewFlowDefaultsDirectory?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-review' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const plan = new InterruptedReview(root, binding.teamName, store, reviewFlowDefaultsDirectory);
  const options = {
    root,
    binding,
    store,
    ...(reviewFlowDefaultsDirectory ? { reviewFlowDefaultsDirectory } : {}),
    members: ['lead', 'alice', 'bob'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'lead' ? ('lead' as const) : ('member' as const),
    })),
    grants: ['user', 'lead', 'alice', 'bob'].map((name) => ({
      principalId: name,
      memberName: name,
      permissions: ['read', 'task.write', 'message.write'] as (
        | 'read'
        | 'task.write'
        | 'message.write'
      )[],
    })),
  };
  const owner = createFilesystemTeamOwner({ ...options, taskMutations: plan });
  const human = owner.connect('user');
  const taskId = human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'Review workflow', owner: 'bob' },
  }).effects.taskId;
  owner.connect('bob').execute({
    commandId: 'TEST-complete',
    operation: 'task.lifecycle',
    payload: { taskId, action: 'complete' },
  });
  const inbox = (name: string) =>
    readFileSync(join(root, 'teams', binding.teamName, 'inboxes', `${name}.json`), 'utf8');
  return {
    owner,
    human,
    plan,
    root,
    binding,
    taskId,
    inbox,
    reopen: () => createFilesystemTeamOwner(options),
    taskBytes: () => readFileSync(join(root, 'tasks', binding.teamName, `${taskId}.json`), 'utf8'),
  };
}

function externalDefaults(t: TestContext, reviewFlow = 'human_approval') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-review-defaults-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'review-flow-defaults.json');
  writeFileSync(path, JSON.stringify({ reviewFlow, reviewFlowPrompt: 'Captured app default' }));
  return { directory, path };
}

test('Host enforces captured app defaults, cycle-bound MCP completion and separate human acceptance', (t) => {
  const defaults = externalDefaults(t), beforeDefaults = readFileSync(defaults.path, 'utf8');
  const f = fixture(t, defaults.directory), reviewer = f.owner.connect('alice');
  assert.deepEqual(f.human.readQueries!.getReviewFlowSettings(), { settings: null });
  assert.equal((reviewer.readQueries!.getKanbanState() as { reviewFlow: string }).reviewFlow, 'human_approval');
  assert.throws(() => reviewer.execute({ commandId: 'TEST-forged-settings', operation: 'task.board.review-flow',
    payload: { settings: { reviewFlow: 'agent_approval', reviewFlowPrompt: '' } } }),
    (error) => error instanceof TeamOwnerError && error.code === 'forbidden');
  f.human.execute({ commandId: 'TEST-human-request', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'request', reviewer: 'alice' } });
  const tools = createTeamMcpTools(reviewer);
  const start = reviewer.execute({ commandId: 'TEST-cycle-start', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'start' } }).result as { reviewRequestId: string };
  assert.equal(typeof start.reviewRequestId, 'string');
  assert.equal(tools.call('review_approve', { commandId: 'TEST-agent-final', taskId: f.taskId }).isError, true);
  assert.equal(tools.call('review_complete', { commandId: 'TEST-stale-cycle', taskId: f.taskId,
    expectedReviewRequestId: 'TEST-old-cycle' }).isError, true);
  assert.notEqual(tools.call('review_complete', { commandId: 'TEST-current-cycle', taskId: f.taskId,
    expectedReviewRequestId: start.reviewRequestId }).isError, true);
  assert.equal(f.human.getTask(f.taskId).reviewState, 'reviewed');
  const bytes = f.taskBytes();
  assert.notEqual(tools.call('review_complete', { commandId: 'TEST-current-cycle', taskId: f.taskId,
    expectedReviewRequestId: start.reviewRequestId }).isError, true);
  assert.equal(f.taskBytes(), bytes, 'lost acknowledgement cannot replay the completed cycle');
  const reopened = f.reopen().connect('user');
  assert.equal(reopened.execute({ commandId: 'TEST-human-final', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'approve' } }).phase, 'completed');
  assert.equal(reopened.getTask(f.taskId).reviewState, 'approved');
  assert.equal((reopened.getTask(f.taskId).historyEvents as { type: string; actor?: string }[])
    .filter(event => event.type === 'human_approved' && event.actor === 'user').length, 1);
  assert.deepEqual(reopened.readQueries!.getReviewFlowSettings(), { settings: null });
  assert.equal(readFileSync(defaults.path, 'utf8'), beforeDefaults);
  assert.equal(existsSync(join(f.root, 'review-flow-defaults.json')), false, 'global defaults never become an owner-local copy');
});

test('Host team override drives Lead sign-off and can return to app defaults without copying them', (t) => {
  const defaults = externalDefaults(t, 'agent_approval'), f = fixture(t, defaults.directory);
  const settings = { reviewFlow: 'lead_then_human', reviewFlowPrompt: 'Lead checks the result' } as const;
  const override: TeamCommand = { commandId: 'TEST-team-settings', operation: 'task.board.review-flow', payload: { settings } };
  assert.equal(f.human.execute(override).phase, 'completed');
  assert.deepEqual(f.reopen().connect('user').readQueries!.getReviewFlowSettings(), { settings });
  f.human.execute({ commandId: 'TEST-lead-review-request', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'request', reviewer: 'alice' } });
  const reviewer = f.owner.connect('alice');
  const first = reviewer.execute({ commandId: 'TEST-first-review-start', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'start' } }).result as { reviewRequestId: string };
  assert.equal(reviewer.execute({ commandId: 'TEST-first-review-complete', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'complete', expectedReviewRequestId: first.reviewRequestId } }).phase, 'completed');
  const history = f.human.getTask(f.taskId).historyEvents as { id: string; type: string; stage?: string; reviewer?: string }[];
  const leadCycle = history.filter(event => event.type === 'review_requested').at(-1)!;
  assert.equal(leadCycle.stage, 'lead_signoff');
  assert.equal(leadCycle.reviewer, 'lead');
  assert.equal(f.human.getTask(f.taskId).reviewState, 'review');
  assert.equal(f.owner.connect('lead').execute({ commandId: 'TEST-lead-signoff-complete', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'complete', expectedReviewRequestId: leadCycle.id } }).phase, 'completed');
  assert.equal(f.human.getTask(f.taskId).reviewState, 'reviewed');
  assert.equal(f.human.execute({ commandId: 'TEST-lead-human-final', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'approve' } }).phase, 'completed');
  assert.equal(f.human.execute({ commandId: 'TEST-remove-override', operation: 'task.board.review-flow',
    payload: { settings: null } }).phase, 'completed');
  assert.deepEqual(f.human.readQueries!.getReviewFlowSettings(), { settings: null });
  assert.equal((f.human.readQueries!.getKanbanState() as { reviewFlow: string }).reviewFlow, 'agent_approval');
});

test('changed app defaults hold a prepared human decision before task publication and after reopen', async (t) => {
  const defaults = externalDefaults(t), f = fixture(t, defaults.directory), before = f.taskBytes();
  f.plan.beforePublish = () => writeFileSync(defaults.path, JSON.stringify({ reviewFlow: 'lead_then_human' }));
  const command: TeamCommand = { commandId: 'TEST-default-race', operation: 'task.review',
    payload: { taskId: f.taskId, action: 'approve' } };
  assert.throws(() => f.human.execute(command), (error) => error instanceof TeamOwnerError && error.code === 'hold');
  assert.equal(f.taskBytes(), before);
  const recovered = await f.reopen().resumeTaskCommands();
  assert.equal(recovered.some(result => result.outcome === 'completed'), false);
  assert.equal(f.taskBytes(), before, 'recovery cannot apply the decision under a different app policy');
});

test('captured task review tools preserve review/fix cycles and reject actor or action overrides', (t) => {
  const f = fixture(t);
  const tools = createTeamMcpTools(f.human);
  const call = (name: string, commandId: string, fields: object = {}) => {
    const result = tools.call(name, { commandId, taskId: f.taskId, ...fields });
    assert.notEqual(result.isError, true);
  };
  call('review_request', 'TEST-request', { reviewer: 'alice' });
  const requested = f.inbox('alice');
  call('review_request', 'TEST-request', { reviewer: 'alice' });
  assert.equal(f.inbox('alice'), requested);
  const wrong = f.owner.connect('bob').execute({
    commandId: 'TEST-wrong-reviewer',
    operation: 'task.review',
    payload: { taskId: f.taskId, action: 'approve' },
  });
  assert.equal(wrong.phase, 'rejected');
  assert.throws(() =>
    tools.call('review_approve', { commandId: 'TEST-forged', taskId: f.taskId, from: 'lead' })
  );
  assert.throws(() =>
    f.human.execute({
      commandId: 'TEST-fields',
      operation: 'task.review',
      payload: { taskId: f.taskId, action: 'start', reviewer: 'lead' },
    } as unknown as TeamCommand)
  );
  call('review_start', 'TEST-review-start');
  call('review_request_changes', 'TEST-changes', {
    comment: 'Fix the edge case',
    taskRefs: [{ taskId: f.taskId, displayId: '1', teamName: 'test-review' }],
  });
  assert.equal(f.human.getTask(f.taskId).status, 'pending');
  assert.equal(f.human.getTask(f.taskId).reviewState, 'needsFix');
  f.owner.connect('bob').execute({
    commandId: 'TEST-fix-start',
    operation: 'task.lifecycle',
    payload: { taskId: f.taskId, action: 'start' },
  });
  f.owner.connect('bob').execute({
    commandId: 'TEST-fix-complete',
    operation: 'task.lifecycle',
    payload: { taskId: f.taskId, action: 'complete' },
  });
  call('review_request', 'TEST-request-again', { reviewer: 'alice' });
  call('review_approve', 'TEST-approve', { note: 'Accepted', notifyOwner: true });
  assert.equal(f.human.getTask(f.taskId).reviewState, 'approved');
  const approved = f.taskBytes(),
    notifications = f.inbox('bob');
  call('review_approve', 'TEST-approve', { note: 'Accepted', notifyOwner: true });
  assert.equal(f.taskBytes(), approved);
  assert.equal(f.inbox('bob'), notifications);
  const history = f.human.getTask(f.taskId).historyEvents as { type: string; actor?: string }[];
  assert.ok(
    history.filter((row) => row.type.startsWith('review_')).every((row) => row.actor === 'user')
  );
});

test('crashed task review resumes the prepared notification without repeating canonical policy', async (t) => {
  const f = fixture(t);
  const command: TeamCommand = {
    commandId: 'TEST-review-crash',
    operation: 'task.review',
    payload: { taskId: f.taskId, action: 'request', reviewer: 'alice' },
  };
  f.plan.interrupted = true;
  assert.throws(
    () => f.human.execute(command),
    (error) => error instanceof TeamOwnerError && error.code === 'hold'
  );
  const task = f.taskBytes();
  const reopened = f.reopen();
  assert.deepEqual(await reopened.resumeTaskCommands(), [
    { commandId: command.commandId, outcome: 'completed' },
  ]);
  assert.equal(f.taskBytes(), task);
  const inbox = f.inbox('alice');
  assert.equal(
    (JSON.parse(inbox) as { summary: string }[]).filter((row) =>
      row.summary.startsWith('Review request')
    ).length,
    1
  );
  assert.equal(reopened.connect('user').execute(command).phase, 'completed');
  assert.equal(f.inbox('alice'), inbox);
});

// Examples in the actual staged notification must be invocable on the strict captured tools.
test('Host reviewer notifications carry cycle-bound actionable MCP arguments without actor selectors', (t) => {
  const f = fixture(t);
  const request = (commandId: string) =>
    f.human.execute({
      commandId,
      operation: 'task.review',
      payload: { taskId: f.taskId, action: 'request', reviewer: 'alice' },
    });
  const examples = (): Record<string, unknown>[] => {
    const rows = JSON.parse(f.inbox('alice')) as { text: string; summary: string }[];
    const message = rows.filter((row) => row.summary.startsWith('Review request')).at(-1)!;
    const values = message.text
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(values.length, 3);
    assert.ok(
      values.every(
        (value) =>
          typeof value.commandId === 'string' &&
          value.taskId === f.taskId &&
          !('teamName' in value) &&
          !('from' in value)
      )
    );
    return values;
  };
  request('TEST-notification-request');
  const first = examples();
  const wrongTools = createTeamMcpTools(f.owner.connect('bob'));
  assert.equal(wrongTools.call('review_start', { ...first[0], commandId: 'TEST-wrong-sample-actor' }).isError, true);
  const reviewerTools = createTeamMcpTools(f.owner.connect('alice'));
  assert.notEqual(reviewerTools.call('review_start', first[0]).isError, true);
  assert.notEqual(reviewerTools.call('review_request_changes', first[2]).isError, true);
  f.owner
    .connect('bob')
    .execute({
      commandId: 'TEST-notification-fix',
      operation: 'task.lifecycle',
      payload: { taskId: f.taskId, action: 'start' },
    });
  f.owner
    .connect('bob')
    .execute({
      commandId: 'TEST-notification-complete',
      operation: 'task.lifecycle',
      payload: { taskId: f.taskId, action: 'complete' },
    });
  request('TEST-notification-request-again');
  const second = examples();
  assert.ok(second.every((value, index) => value.commandId !== first[index]!.commandId));
  assert.notEqual(reviewerTools.call('review_approve', second[1]).isError, true);
  assert.equal(f.human.getTask(f.taskId).reviewState, 'approved');
});


test('one human Disapprove preserves completed work and recovers its original publication once', async (t) => {
  const f = fixture(t);
  f.human.execute({ commandId: 'TEST-disapprove-request', operation: 'task.review', payload: { taskId: f.taskId, action: 'request' } });
  f.human.execute({ commandId: 'TEST-disapprove-approve', operation: 'task.review', payload: { taskId: f.taskId, action: 'approve', notifyOwner: true } });
  const before = f.human.getTask(f.taskId), bytes = f.taskBytes(), inbox = f.inbox('bob');
  const direct = f.human.execute({ commandId: 'TEST-disapprove-direct-clear', operation: 'task.board.clear', payload: { taskId: f.taskId } });
  assert.equal(direct.phase, 'rejected', 'generic approved guard remains closed');
  assert.equal(f.taskBytes(), bytes);
  const command: TeamCommand = { commandId: 'TEST-disapprove-original', operation: 'task.review', payload: { taskId: f.taskId, action: 'disapprove' } };
  assert.throws(() => f.owner.connect('bob').execute(command), (error) => error instanceof TeamOwnerError && error.code === 'forbidden');
  assert.throws(() => f.human.execute({ ...command, payload: { ...command.payload, from: 'user' } } as unknown as TeamCommand));
  assert.equal(f.taskBytes(), bytes);
  f.plan.interrupted = true;
  assert.throws(() => f.human.execute(command), (error) => error instanceof TeamOwnerError && error.code === 'hold');
  const recovered = f.reopen();
  assert.deepEqual(await recovered.resumeTaskCommands(), [{ commandId: command.commandId, outcome: 'completed' }]);
  const human = recovered.connect('user'), after = human.getTask(f.taskId);
  assert.equal(after.status, 'completed');
  assert.equal(after.reviewState, 'none');
  assert.equal(after.owner, before.owner);
  assert.deepEqual(after.workIntervals, before.workIntervals);
  const oldHistory = before.historyEvents as unknown[], history = after.historyEvents as { type: string; from?: string; to?: string; actor?: string }[];
  assert.deepEqual(history.slice(0, -1), oldHistory);
  assert.equal(history.length, oldHistory.length + 1);
  assert.equal(history.at(-1)!.type, 'review_disapproved');
  assert.equal(history.at(-1)!.actor, 'user');
  assert.equal(human.execute(command).phase, 'completed');
  assert.deepEqual(human.getTask(f.taskId), after);
  assert.equal(f.inbox('bob'), inbox, 'approval removal sends no duplicate completion/approval notification');
  assert.equal(human.execute({ ...command, commandId: 'TEST-disapprove-new-intent' }).phase, 'rejected');
  assert.equal(human.execute({ commandId: 'TEST-disapprove-next-review', operation: 'task.review', payload: { taskId: f.taskId, action: 'request' } }).phase, 'completed');
});
