import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { evidenceProjectDir } from '../dist/evidence/evidenceProjectDir.js';
import { digest } from '../dist/team/identity.js';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('canonical primary task references bind dependency notifications to the child task, preserving ordinary commands', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead'); await f.open('worker');
  const ordinary = success<CommandReceipt>(await f.rpc('team.execute', { operation: 'task.create',
    payload: { subject: 'TEST ordinary unrelated backlog' } }, 'TEST-provenance-ordinary'));
  assert.equal(ordinary.phase, 'completed');
  assert.equal(ordinary.goal, undefined);
  assert.equal(f.goal(), undefined);
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST finish the two dependent artifacts', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 12 } } }, 'TEST-provenance-intake'));
  await eventually(() => f.session().submits.length === 1, 'original goal reaches the lead');
  const parent = await f.tool('lead', 'task_create', { commandId: 'TEST-provenance-parent',
    subject: 'TEST prerequisite artifact', owner: 'worker', descriptionTaskRefs: [{
      taskId: ordinary.effects.taskId, displayId: ordinary.effects.taskId,
      teamName: f.selected.teams[0]!.binding.teamName,
    }] }) as CommandReceipt;
  const child = await f.tool('lead', 'task_create', { commandId: 'TEST-provenance-child',
    subject: 'TEST dependent artifact', owner: 'worker', blockedBy: [parent.effects.taskId] }) as CommandReceipt;
  assert.equal(parent.phase, 'completed'); assert.equal(child.phase, 'completed');
  const plan = (commandId: string) => f.teamStore.fenced(() => f.teamStore.read<{
    notifications: { taskId?: string; messageId: string }[];
  }>(`task-plans/${digest(commandId)}.json`)!);
  assert.equal(plan(parent.commandId).notifications[0]!.taskId, parent.effects.taskId,
    'a context reference cannot replace the canonical notification task');
  assert.equal(plan(child.commandId).notifications.length, 0, 'unresolved dependency remains quiet');
  await eventually(() => f.session('worker').submits.length === 1, 'original parent assignment starts');
  await f.tool('worker', 'task_start', { commandId: 'TEST-provenance-start', taskId: parent.effects.taskId });
  const completion = await f.tool('worker', 'task_complete', { commandId: 'TEST-provenance-complete',
    taskId: parent.effects.taskId }) as CommandReceipt;
  assert.equal(completion.phase, 'completed');
  assert.deepEqual(plan(completion.commandId).notifications.map(row => row.taskId), [child.effects.taskId],
    'the child task is the notification cause, independently of the completing command task');
  f.session('worker').finish(0);
  await eventually(() => f.session('worker').submits.length === 2, 'exact dependency notification starts');
  await f.captureWrite('worker', 1, 'TEST child artifact from the original dependency notification\n');
  const captured = await new AgentChangeLedgerReader().readAgentChangesWithEvidence({
    teamName: f.selected.teams[0]!.binding.teamName, memberName: 'worker', actorId: 'worker-id',
    projectDir: evidenceProjectDir(f.root, f.selected.teams[0]!.binding.teamName), projectPath: f.workspace,
  });
  assert.ok(captured.evidence.some(event => {
    const cause = event.causalBinding as Record<string, unknown>;
    return cause.inputId === f.session('worker').submits[1]!.inputId &&
      cause.goalTaskCommandId === completion.commandId && cause.goalTaskId === child.effects.taskId;
  }), 'real captured file effect retains the exact child task and original producing receipt');
  f.session('worker').finish(1);
});

test('unknown original task effect blocks reassignment publication; original settlement preserves evidence and permits handoff', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead'); await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'task.create', payload: {
    subject: 'TEST unrelated backlog avoids board-wide completion notification',
  } }, 'TEST-reassignment-ordinary'));
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST finish the exact artifact with a verified owner handoff', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 12 } } }, 'TEST-reassignment-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input starts');
  const task = await f.tool('lead', 'task_create', { commandId: 'TEST-reassignment-task',
    subject: 'TEST artifact needing a safe owner handoff', owner: 'worker' }) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  await eventually(() => f.session('worker').submits.length === 1, 'original worker input starts');
  await f.captureWrite('worker', 0, 'TEST original worker artifact retained across handoff\n');
  const originalInput = f.session('worker').submits[0]!.inputId;
  f.session('worker').finish(0, 'unknown');
  await eventually(() => f.runtime('worker')!.inputs[0]!.phase === 'unknown', 'original uncertainty is durable');
  const assignmentId = 'TEST-reassignment-handoff';
  assert.deepEqual(await f.rpc('team.execute', { operation: 'task.assign',
    payload: { taskId: task.effects.taskId, owner: 'lead' } }, assignmentId),
  { ok: false, code: 'hold', outcome: 'unknown' }, 'the original command remains unresolved, never falsely successful');
  const held = f.teamStore.fenced(() => f.teamStore.read<CommandReceipt>(`commands/${digest(assignmentId)}.json`)!);
  assert.equal(held.phase, 'held');
  assert.equal((await f.tool('lead', 'task_get', { taskId: task.effects.taskId }) as { owner: string }).owner, 'worker');
  assert.equal(f.session('worker').submits.length, 1, 'unknown original is neither replaced nor replayed');
  assert.ok(f.goal()!.debits[originalInput]);
  // Only an actual event from that original native operation settles the uncertainty.
  f.session('worker').finish(0);
  await eventually(() => f.teamStore.fenced(() => f.teamStore.read<CommandReceipt>(
    `commands/${digest(assignmentId)}.json`)?.phase === 'completed'), 'original handoff publishes after proven settlement');
  assert.equal((await f.tool('lead', 'task_get', { taskId: task.effects.taskId }) as { owner: string }).owner, 'lead');
  await eventually(() => f.session('worker').submits.length === 2, 'existing old-owner handoff notification is preserved');
  assert.match(f.session('worker').submits[1]!.content, /reassigned away from you/u);
  f.session('worker').finish(1);
  await f.tool('lead', 'task_start', { commandId: 'TEST-reassignment-lead-start', taskId: task.effects.taskId });
  await f.tool('lead', 'task_complete', { commandId: 'TEST-reassignment-lead-complete', taskId: task.effects.taskId });
  assert.equal((await f.tool('lead', 'goal_propose', { commandId: 'TEST-reassignment-propose',
    result: 'TEST verified original artifact after the exact owner handoff' }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(0);
  await eventually(() => f.goal()?.published === true, 'historical original artifact evidence remains verifiable after handoff');
  assert.equal(f.runtime('worker')!.inputs[0]!.terminal, 'succeeded');
  assert.ok(f.goal()!.debits[originalInput], 'the original charged witness is never refunded or rewritten');
});
