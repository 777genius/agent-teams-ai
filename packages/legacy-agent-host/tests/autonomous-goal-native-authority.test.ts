import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { evidenceProjectDir } from '../dist/evidence/evidenceProjectDir.js';
import { TeamOwner } from '../dist/team/TeamOwner.js';
import type { CommandReceipt } from '../dist/team/contracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

for (const sourceKind of ['TaskStart', 'DO-continuation'] as const) {
  test(`pending goal reassignment retains real ${sourceKind} effects without native helper or subagent authority`, async t => {
    let owner: TeamOwner | undefined;
    const connect = TeamOwner.prototype.connect;
    t.mock.method(TeamOwner.prototype, 'connect', function (this: TeamOwner, principalId: string) {
      if (principalId === 'human') owner = this;
      return connect.call(this, principalId);
    });
    const f = await goalHost(t, { capture: true, solo: true });
    await f.open('lead');
    assert.ok(owner, 'capture the actual Host-owned Team service without replacing its state');
    success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
      text: 'TEST preserve original task effects during an authorized owner change', actionMode: 'do',
      autonomousGoal: { durationHours: 12, maxAttempts: 8 },
    } }, 'TEST-retraction-authority-intake'));
    await eventually(() => f.session().submits.length === 1, 'the actual original goal input starts');
    const task = await f.tool('lead', 'task_create', { commandId: 'TEST-retraction-authority-task',
      subject: 'TEST lead-owned work', owner: 'lead' }) as CommandReceipt;
    assert.equal(task.phase, 'completed');
    success(await f.rpc('team.execute', { operation: 'task.start', payload: {
      taskId: task.effects.taskId, notification: 'user',
    } }, 'TEST-retraction-authority-start'));
    f.session().finish(0);
    await eventually(() => f.session().submits.length === 2, 'the real user-authorized TaskStart reaches Runtime');
    let index = 1;
    if (sourceKind === 'DO-continuation') {
      f.session().finish(1);
      await eventually(() => f.session().submits.length === 3, 'the original task receives a real charged DO continuation');
      index = 2;
    }
    await f.captureWrite('lead', index, 'TEST effect before original reassignment\n');
    const original = f.runtime('lead')!.inputs[index]!;
    const proof = owner.captureNativeMcpAuthority('lead-session', original.intent.binding, original.intent, true);
    assert.equal(proof.mode, 'do');
    assert.equal('taskId' in proof.cause, sourceKind === 'TaskStart');
    assert.equal(owner.allowsOrdinarySubagent('lead-session', original.intent), true,
      'the actual solo Team permits the original DO capability before reassignment');
    const commandId = 'TEST-retraction-authority-unassign';
    assert.deepEqual(await f.rpc('team.execute', { operation: 'task.assign', payload: {
      taskId: task.effects.taskId, owner: null,
    } }, commandId), { ok: false, code: 'hold', outcome: 'unknown' });
    assert.equal(owner.connect('human').getTask(task.effects.taskId).owner, 'lead',
      'the original native effect still prevents publication of the new owner');
    assert.ok(owner.lookupToolInputCause('lead-session', original.intent),
      'the explicit evidence-only lookup retains the original captured cause');
    assert.throws(() => owner!.captureNativeMcpAuthority('lead-session', original.intent.binding, original.intent, true),
      { code: 'forbidden' }, 'evidence-only access cannot authorize a new native helper');
    assert.throws(() => owner!.allowsOrdinarySubagent('lead-session', original.intent), { code: 'forbidden' },
      'evidence-only access cannot authorize a new ordinary child');
    await f.captureWrite('lead', index, 'TEST real in-flight effect while original reassignment is held\n');
    const captured = await new AgentChangeLedgerReader().readAgentChangesWithEvidence({
      teamName: f.selected.teams[0]!.binding.teamName, memberName: 'lead', actorId: 'lead-id',
      projectDir: evidenceProjectDir(f.root, f.selected.teams[0]!.binding.teamName), projectPath: f.workspace,
    });
    assert.ok(captured.evidence.some(event => {
      const cause = event.causalBinding as Record<string, unknown>;
      return event.toolUseId === 'TEST-file-write-2' &&
        cause.inputId === original.intent.inputId && cause.operationRef === original.operationRef;
    }), 'the actual capture ledger still includes the original effect');
    const goal = f.goal()!;
    success(await f.rpc('team.goal.control', { goalId: goal.goalId, expectedRevision: goal.revision,
      action: 'stop' }, 'TEST-retraction-authority-stop'));
    f.session().finish(index);
    await eventually(() => owner!.connect('human').lookup(commandId)?.phase === 'completed',
      'the same pending owner change completes after original native settlement');
    assert.equal(Object.hasOwn(owner.connect('human').getTask(task.effects.taskId), 'owner'), false,
      'canonical unassignment removes the owner field');
    assert.equal(f.runtime('lead')!.inputs[index]!.terminal, 'succeeded');
  });
}
