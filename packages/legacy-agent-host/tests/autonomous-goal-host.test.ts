import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import { digest } from '../dist/team/identity.js';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('baseline: original human intake, native task MCP, paired settlement and cold replay share the real Host', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  const command = { operation: 'message.send', payload: {
    to: 'lead', text: 'TEST implement the requested small change', actionMode: 'delegate',
  } };
  const receipt = success<CommandReceipt>(await f.rpc('team.execute', command, 'TEST-baseline-intake'));
  assert.equal(receipt.phase, 'completed');
  await eventually(() => f.session().submits.length === 1, 'original user message reaches the lead');
  const original = f.session().submits[0]!;
  assert.equal(original.inputId, receipt.effects.deliveryId);
  assert.equal(f.runtime('lead')?.inputs[0]?.operationRef, original.operationRef);

  const create = { commandId: 'TEST-baseline-task', subject: 'TEST exact delegated work', owner: 'worker' };
  const task = await f.tool('lead', 'task_create', create) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  assert.equal(task.principalId, 'lead-session');
  const taskId = task.effects.taskId;
  assert.equal(typeof taskId, 'string');
  assert.deepEqual(await f.tool('lead', 'task_create', create), task, 'original MCP command replays once');
  await eventually(() => f.session('worker').submits.length === 1,
    'the original assignment notification reaches the teammate');
  const started = await f.tool('worker', 'task_start', { commandId: 'TEST-baseline-start', taskId }) as CommandReceipt;
  assert.equal(started.phase, 'completed');
  const taskView = success<{ owner: string; status: string }>(await f.rpc('team.task.get', { taskId }));
  assert.equal(taskView.owner, 'worker');
  assert.equal(taskView.status, 'in_progress');
  const taskPath = join(f.root, 'tasks', 'test-goal-team', `${taskId}.json`);
  const taskBytes = readFileSync(taskPath);

  f.session().emit({ sessionRef: f.session().sessionRef, inputId: original.inputId,
    operationRef: original.operationRef, kind: 'text', messageRef: 'TEST-baseline-reply',
    block: 0, phase: 'complete', text: 'TEST delegated the requested change' });
  f.session().finish(0);
  f.session('worker').finish(0);
  await eventually(() => f.runtime('lead')?.inputs[0]?.terminal === 'succeeded',
    'the original paired native result is durably terminal');
  await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'succeeded',
    'the teammate original native result is durably terminal');
  const page = success<{ messages: { text: string; messageId?: string; source?: string }[] }>(
    await f.rpc('team.messages.page', {}));
  const reply = page.messages.filter(row => row.source === 'lead_session');
  assert.equal(reply.length, 1);
  assert.equal(reply[0]!.text, 'TEST delegated the requested change');
  assert.deepEqual(success(await f.rpc('team.execute', command, 'TEST-baseline-intake')), receipt);
  assert.equal(f.session().submits.length, 1, 'ordinary non-opt-in turn does not invent a continuation');

  const opens = f.opens();
  await f.restart();
  assert.deepEqual(success(await f.rpc('team.execute', command, 'TEST-baseline-intake')), receipt);
  assert.deepEqual(readFileSync(taskPath), taskBytes, 'cold original replay does not rewrite the task');
  const cold = success<typeof page>(await f.rpc('team.messages.page', {}));
  assert.deepEqual(cold.messages.filter(row => row.source === 'lead_session'), reply);
  assert.equal(f.opens(), opens, 'cold read and receipt replay allocate no native session');
  assert.equal(f.session().submits.length, 1);
});

test('task-free goal proposal returns before its own turn settles and publishes one original result', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  const command = { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST answer this bounded research question', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } };
  const receipt = success<CommandReceipt>(await f.rpc('team.execute', command, 'TEST-research-intake'));
  await eventually(() => f.session().submits.length === 1, 'original opted-in intake reaches lead');
  const originalGoal = f.goal();
  assert.ok(originalGoal);
  assert.equal(originalGoal.disposition, 'active');
  assert.deepEqual(originalGoal.debits, {}, 'human intake is not an automatic attempt');
  assert.deepEqual(success(await f.rpc('team.execute', command, 'TEST-research-intake')), receipt);
  assert.equal(f.goal()!.goalId, originalGoal.goalId, 'lost intake ACK cannot create another goal');

  const request = { commandId: 'TEST-research-final', result: 'TEST bounded research result',
    evidence: 'TEST explanation tied to the original question' };
  const proposal = await f.tool('lead', 'goal_propose', request) as GoalStatus;
  assert.equal(proposal.disposition, 'finalizing');
  assert.equal(f.runtime('lead')!.inputs[0]!.phase, 'consumed',
    'proposal returns while its own original native turn is still active');
  assert.equal(f.goal()!.published, undefined);
  const proposedId = f.goal()!.proposal!.resultMessageId;
  const repeated = await f.tool('lead', 'goal_propose', request) as GoalStatus;
  assert.equal(repeated.goalId, proposal.goalId);
  assert.equal(f.goal()!.proposal!.resultMessageId, proposedId);

  f.session().finish(0);
  await eventually(() => f.goal()?.published === true, 'only native settlement permits final acceptance/publication');
  const final = success<{ autonomousGoal: GoalStatus }>(await f.rpc('team.snapshot', {})).autonomousGoal;
  assert.equal(final.disposition, 'accepted');
  assert.equal(final.resultMessageId, proposedId);
  assert.equal(final.attemptsUsed, 0);
  assert.equal(f.session().submits.length, 1, 'acceptance/publication requires no extra model turn');
  const page = success<{ messages: { messageId?: string; text: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.deepEqual(page.messages.filter(row => row.messageId === proposedId).map(row => row.text), [request.result]);
  const opens = f.opens();
  await f.restart();
  const cold = success<typeof page>(await f.rpc('team.messages.page', {}));
  assert.equal(cold.messages.filter(row => row.messageId === proposedId).length, 1);
  assert.equal(f.opens(), opens);
  assert.deepEqual(success(await f.rpc('team.execute', command, 'TEST-research-intake')), receipt);
  assert.equal(f.goal()!.published, true);
});

test('Stop before native settlement suppresses automatic continuation while ordinary user chat still works', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST bounded work that has not completed', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 3 } } }, 'TEST-stop-intake'));
  await eventually(() => f.session().submits.length === 1, 'original goal input is active');
  const goal = f.goal()!;
  const control = { goalId: goal.goalId, expectedRevision: goal.revision, action: 'stop' };
  const stopped = success<GoalStatus>(await f.rpc('team.goal.control', control, 'TEST-stop-control'));
  assert.equal(stopped.disposition, 'stopped');
  assert.deepEqual(success(await f.rpc('team.goal.control', control, 'TEST-stop-control')), stopped);
  f.session().finish(0);
  await eventually(() => f.runtime('lead')?.inputs[0]?.terminal === 'succeeded', 'original in-flight turn settles after Stop');
  assert.equal(f.goal()!.disposition, 'stopped');
  assert.equal(f.session().submits.length, 1);
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST separate ordinary user question', actionMode: 'ask' } }, 'TEST-ordinary-after-stop'));
  await eventually(() => f.session().submits.length === 2, 'ordinary user input is not stranded by the stopped goal');
  assert.equal(f.session().submits[1]!.content.includes('TEST separate ordinary user question'), true);
  f.session().finish(1);
  await eventually(() => f.runtime('lead')?.inputs[1]?.terminal === 'succeeded', 'ordinary user turn settles');
  assert.equal(f.goal()!.disposition, 'stopped');
  assert.deepEqual(f.goal()!.debits, {});
  await f.restart();
  assert.equal(f.goal()!.disposition, 'stopped');
  assert.equal(f.session().submits.length, 2);
});

test('delegated goal continues the same task for more than two verified productive turns and publishes after both members settle', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  const unrelated = success<CommandReceipt>(await f.rpc('team.execute', {
    operation: 'task.create', payload: { subject: 'TEST unrelated backlog remains pending' },
  }, 'TEST-unrelated-backlog'));
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST delegate and finish the concrete artifact', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 24 } } }, 'TEST-productive-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead receives the objective');
  const created = await f.tool('lead', 'task_create', { commandId: 'TEST-productive-task',
    subject: 'TEST build the artifact in several productive turns', owner: 'worker' }) as CommandReceipt;
  assert.equal(created.phase, 'completed');
  assert.equal(created.goal?.goalId, f.goal()!.goalId, 'scope comes from the original active native input');
  const taskId = created.effects.taskId;
  await eventually(() => f.session('worker').submits.length === 1, 'actual assignment reaches the teammate');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: 'TEST-productive-start', taskId,
  }) as CommandReceipt).phase, 'completed');
  assert.deepEqual(await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-too-early', result: 'TEST incomplete work is not final',
  }), { error: { code: 'hold' } });

  // Continue the same scoped task across distinct original native inputs.
  f.session('worker').finish(0);
  await eventually(() => f.session('worker').submits.length === 2,
    'settled assigned work receives one automatic goal continuation');
  for (let index = 1; index <= 3; index++) {
    await f.captureWrite('worker', index, `TEST verified artifact revision ${index}\n`);
    const task = success<{ status: string }>(await f.rpc('team.task.get', { taskId }));
    assert.equal(task.status, 'in_progress', 'status stays unchanged across productive turns');
    f.session('worker').finish(index);
    await eventually(() => f.session('worker').submits.length === index + 2,
      `verified original artifact ${index} permits the next native input without user Continue`);
  }
  const history = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands')
    .flatMap(receipt => receipt.goal?.continuation?.target.memberId === 'worker-id'
      ? [receipt.goal.continuation] : []));
  assert.equal(history.length, 4);
  assert.equal(history.every(row => row.reason === 'productive'), true,
    'actual capture hashes, not task text or timestamps, replenish productive work');
  assert.equal(new Set(history.map(row => row.evidenceFingerprint)).size, 4);
  assert.equal(f.session().submits.length, 1, 'busy lead does not block independent worker continuation');

  assert.equal((await f.tool('worker', 'task_complete', {
    commandId: 'TEST-productive-complete', taskId,
  }) as CommandReceipt).phase, 'completed');
  const proposal = await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-productive-final', result: 'TEST completed the verified artifact',
    evidence: 'TEST worker-artifact.txt contains verified artifact revision 3',
  }) as GoalStatus;
  assert.equal(proposal.disposition, 'finalizing');
  f.session().finish(0);
  await eventually(() => f.runtime('lead')!.inputs[0]!.terminal === 'succeeded', 'lead proposal turn settles');
  assert.equal(f.goal()!.disposition, 'finalizing', 'worker completion flag does not substitute for native quiescence');
  assert.notEqual(f.goal()!.published, true);
  f.session('worker').finish(4);
  await eventually(() => f.goal()?.published === true, 'exact lead and worker original turns settle before final publication');
  assert.equal(f.goal()!.disposition, 'accepted');
  assert.equal(Object.keys(f.goal()!.debits).length, f.session('worker').submits.length,
    'each automatic assignment/continuation has one shared-budget witness');
  assert.equal(success<{ status: string }>(await f.rpc('team.task.get', {
    taskId: unrelated.effects.taskId,
  })).status, 'pending', 'unrelated backlog does not block this objective');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
  const submissions = f.session('worker').submits.length + f.session().submits.length;
  for (let read = 0; read < 3; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session('worker').submits.length + f.session().submits.length, submissions,
    'completed passive reads make zero additional model calls');
});

test('last charged attempt starts once, exhausted reads stay passive, and explicit extension preserves original debit', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  const intake = { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST bounded task-free work', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 1 } } };
  const original = success<CommandReceipt>(await f.rpc('team.execute', intake, 'TEST-budget-intake'));
  await eventually(() => f.session().submits.length === 1, 'original intake consumes no automatic budget');
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2, 'the last valid charged input actually starts');
  const debit = structuredClone(f.goal()!.debits);
  assert.equal(Object.keys(debit).length, 1);
  assert.ok(debit[f.session().submits[1]!.inputId]);
  assert.deepEqual(success(await f.rpc('team.execute', intake, 'TEST-budget-intake')), original);
  assert.deepEqual(f.goal()!.debits, debit, 'lost intake ACK does not charge again');
  f.session().finish(1);
  await eventually(() => f.runtime('lead')!.inputs[1]!.terminal === 'succeeded', 'last charged input settles');
  for (let read = 0; read < 3; read++) {
    const snapshot = success<{ autonomousGoal: GoalStatus }>(await f.rpc('team.snapshot', {}));
    assert.equal(snapshot.autonomousGoal.reason, 'attempt-limit-reached');
  }
  assert.equal(f.session().submits.length, 2, 'budget-exhausted reads make no model call');
  const goal = f.goal()!;
  const control = { goalId: goal.goalId, expectedRevision: goal.revision, action: 'extend', attemptLimit: 2 };
  const extended = success<GoalStatus>(await f.rpc('team.goal.control', control, 'TEST-budget-extend'));
  assert.equal(extended.attemptLimit, 2);
  assert.equal(extended.attemptsUsed, 1);
  assert.deepEqual(success(await f.rpc('team.goal.control', control, 'TEST-budget-extend')), extended);
  await eventually(() => f.session().submits.length === 3, 'explicit extension permits one new original input');
  assert.equal(Object.keys(f.goal()!.debits).length, 2);
  assert.deepEqual(f.goal()!.debits[Object.keys(debit)[0]!], Object.values(debit)[0]);
  const proposal = await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-budget-final', result: 'TEST verified result at the exact attempt limit',
  }) as GoalStatus;
  assert.equal(proposal.disposition, 'finalizing');
  f.session().finish(2);
  await eventually(() => f.goal()?.published === true, 'already charged last turn may finalize without a new attempt');
  assert.equal(f.session().submits.length, 3);
  assert.equal(Object.keys(f.goal()!.debits).length, 2);
});

test('uncertain native submit keeps its charged original and never resubmits after reads or cold restart', async t => {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST work with a lost native handoff acknowledgement', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-unknown-intake'));
  await eventually(() => f.session().submits.length === 1, 'original user input starts');
  f.session().submitAction = async () => { throw new Error('TEST unknown native handoff'); };
  f.session().finish(0);
  await eventually(() => f.runtime('lead')?.inputs[1]?.phase === 'unknown', 'actual Runtime preserves uncertain submit');
  const original = structuredClone(f.runtime('lead')!.inputs[1]!);
  assert.equal(f.session().submits.length, 2);
  assert.equal(Object.keys(f.goal()!.debits).length, 1);
  assert.ok(f.goal()!.debits[original.intent.inputId]);
  for (let read = 0; read < 3; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session().submits.length, 2, 'passive reads cannot retry an uncertain external effect');
  assert.notEqual(f.goal()!.published, true);
  const opens = f.opens();
  await f.restart();
  assert.equal(f.runtime('lead')!.inputs[1]!.phase, 'unknown');
  assert.equal(f.runtime('lead')!.inputs[1]!.operationRef, original.operationRef);
  assert.equal(f.opens(), opens, 'restart does not allocate a replacement native session');
  assert.equal(f.session().submits.length, 2);
  assert.equal(Object.keys(f.goal()!.debits).length, 1);
  assert.notEqual(f.goal()!.published, true);
});

test('an unchanged artifact and model progress text cannot replenish the two finite recovery turns', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST task-free artifact with a bounded stalled branch', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-stalled-intake'));
  await eventually(() => f.session().submits.length === 1, 'original input starts');
  await f.captureWrite('lead', 0, 'TEST one actual verified change\n');
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2, 'first verified progress permits continuation');
  for (let index = 1; index <= 2; index++) {
    await f.captureWrite('lead', index, 'TEST one actual verified change\n');
    const input = f.session().submits[index]!;
    f.session().emit({ sessionRef: f.session().sessionRef, inputId: input.inputId,
      operationRef: input.operationRef, kind: 'text', messageRef: `TEST-stall-report-${index}`,
      block: 0, phase: 'complete', text: 'TEST claimed progress without any changed artifact' });
    f.session().finish(index);
    await eventually(() => f.session().submits.length === index + 2,
      `only bounded recovery ${index} is allowed without new proof`);
  }
  f.session().finish(3);
  await eventually(() => /two recovery attempts/u.test(f.goal()?.reason ?? ''),
    'exhausted unchanged obligation exposes the exact stalled reason');
  const history = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands')
    .flatMap(receipt => receipt.goal?.continuation ? [receipt.goal.continuation] : []))
    .sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(history.map(row => row.reason), ['productive', 'recovery', 'recovery']);
  assert.equal(Object.keys(f.goal()!.debits).length, 3);
  for (let read = 0; read < 3; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session().submits.length, 4);
  assert.notEqual(f.goal()!.published, true);
});

test('a real captured write after proposal invalidates the candidate and requires a fresh verified proposal', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST finish the exact final artifact', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-late-write-intake'));
  await eventually(() => f.session().submits.length === 1, 'original input starts');
  await f.captureWrite('lead', 0, 'TEST artifact checked before proposal\n');
  const first = await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-late-write-first', result: 'TEST stale candidate',
  }) as GoalStatus;
  assert.equal(first.disposition, 'finalizing');
  const staleResultId = f.goal()!.proposal!.resultMessageId;
  await f.captureWrite('lead', 0, 'TEST artifact changed after proposal\n');
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2,
    'changed captured file returns original goal to verification instead of accepting stale evidence');
  assert.equal(f.goal()!.disposition, 'active');
  assert.equal(f.goal()!.proposal, undefined);
  assert.notEqual(f.goal()!.published, true);
  const next = await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-late-write-current', result: 'TEST newly verified changed artifact',
  }) as GoalStatus;
  assert.equal(next.disposition, 'finalizing');
  f.session().finish(1);
  await eventually(() => f.goal()?.published === true, 'fresh verification settles and publishes once');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === staleResultId).length, 0);
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});

test('the first delegated task input contributes real evidence and a late write reopens the original candidate', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST complete the artifact from the original first assignment', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-first-write-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input starts');
  const task = await f.tool('lead', 'task_create', { commandId: 'TEST-first-write-task',
    subject: 'TEST artifact written in the first assigned input', owner: 'worker' }) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  const taskId = task.effects.taskId;
  await eventually(() => f.session('worker').submits.length === 1, 'first assigned worker input starts');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: 'TEST-first-write-start', taskId,
  }) as CommandReceipt).phase, 'completed');
  await f.captureWrite('worker', 0, 'TEST original first-assignment artifact\n');
  assert.equal((await f.tool('worker', 'task_complete', {
    commandId: 'TEST-first-write-complete', taskId,
  }) as CommandReceipt).phase, 'completed');
  const boardNotices = f.teamStore.fenced(() => f.teamStore.list<DeliveryIntent>('outbox')
    .filter(intent => intent.commandId === 'TEST-first-write-complete' && intent.binding.memberId === 'lead-id'));
  assert.equal(boardNotices.length, 1, 'canonical board completion publishes one actual lead notification');
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2, 'lead consumes its already queued board-completion input');
  assert.equal(f.session().submits[1]!.inputId, boardNotices[0]!.inputId);
  const proposal = await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-first-write-proposal', result: 'TEST first artifact candidate',
  }) as GoalStatus;
  assert.equal(proposal.disposition, 'finalizing');
  assert.notEqual(f.goal()!.proposal!.evidenceFingerprint, digest([]),
    'first assignment capture is actually bound to its scoped task, not an empty evidence list');
  const staleId = f.goal()!.proposal!.resultMessageId;
  await f.captureWrite('worker', 0, 'TEST late first-assignment artifact change\n');
  f.session('worker').finish(0);
  f.session().finish(1);
  await eventually(() => f.session().submits.length === 3,
    'late first-assignment effect requires a fresh lead verification input');
  assert.equal(f.goal()!.disposition, 'active');
  assert.equal(f.goal()!.proposal, undefined);
  assert.notEqual(f.goal()!.published, true);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-first-write-current', result: 'TEST verified the changed first-assignment file',
  }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(2);
  await eventually(() => f.goal()?.published === true, 'fresh original verification publishes once');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === staleId).length, 0);
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});

test('a direct change to an already captured artifact after proposal cannot hide behind an unchanged ledger hash', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST compare the actual current artifact at finalization', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-direct-write-intake'));
  await eventually(() => f.session().submits.length === 1, 'original intake starts');
  const file = await f.captureWrite('lead', 0, 'TEST verified artifact before proposal\n');
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-direct-write-first', result: 'TEST stale current-file candidate',
  }) as GoalStatus).disposition, 'finalizing');
  const staleId = f.goal()!.proposal!.resultMessageId;
  writeFileSync(file, 'TEST actual bytes changed without a new capture event\n');
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2,
    'bounded current-file read invalidates the stale candidate without a new ledger event');
  assert.equal(f.goal()!.disposition, 'active');
  assert.notEqual(f.goal()!.published, true);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-direct-write-current', result: 'TEST verified current file bytes',
  }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(1);
  await eventually(() => f.goal()?.published === true, 'fresh current-file verification may finish');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === staleId).length, 0);
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});

test('a known failed original keeps its effect and debit while separately authorized repair can complete the same task', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST finish the original scoped task after a known failed attempt', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 12 } } }, 'TEST-known-failed-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead receives the goal');
  const task = await f.tool('lead', 'task_create', { commandId: 'TEST-known-failed-task',
    subject: 'TEST repair the same scoped file', owner: 'worker' }) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  const taskId = task.effects.taskId;
  await eventually(() => f.session('worker').submits.length === 1, 'first original assignment starts');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: 'TEST-known-failed-start', taskId,
  }) as CommandReceipt).phase, 'completed');
  await f.captureWrite('worker', 0, 'TEST partial effect before a known failure\n');
  const firstInputId = f.session('worker').submits[0]!.inputId;
  const originalDebit = structuredClone(f.goal()!.debits[firstInputId]);
  assert.ok(originalDebit);
  f.session('worker').finish(0, 'failed');
  await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'failed',
    'actual native failure is durably terminal rather than unknown');
  assert.notEqual(f.goal()!.published, true);
  const retry = success<CommandReceipt>(await f.rpc('team.execute', { operation: 'task.lifecycle',
    payload: { taskId, action: 'pending' } }, 'TEST-known-failed-return-pending'));
  assert.equal(retry.phase, 'completed', 'human returns the failed task to the canonical retry state');
  const repair = success<CommandReceipt>(await f.rpc('team.execute', { operation: 'task.start',
    payload: { taskId, notification: 'user' } }, 'TEST-known-failed-human-repair'));
  assert.equal(repair.phase, 'completed', 'human authorizes a new original repair notification');
  await eventually(() => f.session('worker').submits.length === 2,
    'known failed history does not permanently block separately authorized repair');
  assert.notEqual(f.session('worker').submits[1]!.inputId, firstInputId);
  await f.captureWrite('worker', 1, 'TEST repaired and verified actual file\n');
  assert.equal((await f.tool('worker', 'task_complete', {
    commandId: 'TEST-known-failed-complete', taskId,
  }) as CommandReceipt).phase, 'completed');
  f.session('worker').finish(1);
  await eventually(() => f.runtime('worker')?.inputs[1]?.terminal === 'succeeded', 'repair settles successfully');
  const boardNotices = f.teamStore.fenced(() => f.teamStore.list<DeliveryIntent>('outbox')
    .filter(intent => intent.commandId === 'TEST-known-failed-complete' && intent.binding.memberId === 'lead-id'));
  assert.equal(boardNotices.length, 1);
  f.session().finish(0);
  await eventually(() => f.session().submits.length === 2, 'lead receives the actual original board-completion notification');
  assert.equal(f.session().submits[1]!.inputId, boardNotices[0]!.inputId);
  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-known-failed-final', result: 'TEST repaired original task is verified',
  }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(1);
  await eventually(() => f.goal()?.published === true, 'known failed artifact history does not prevent a verified repair result');
  assert.equal(f.runtime('worker')!.inputs[0]!.terminal, 'failed');
  assert.deepEqual(f.goal()!.debits[firstInputId], originalDebit, 'failed charged attempt is neither removed nor refunded');
  assert.equal(success<{ status: string }>(await f.rpc('team.task.get', { taskId })).status, 'completed');
});
