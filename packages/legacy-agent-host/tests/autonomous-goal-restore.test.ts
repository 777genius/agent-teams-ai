import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

for (const scenario of [
  { successorWrites: false, priorContinuation: false },
  { successorWrites: true, priorContinuation: false },
  { successorWrites: false, priorContinuation: true },
]) {
  const suffix = scenario.successorWrites ? ' and its newly captured artifact' :
    scenario.priorContinuation ? ' after already charged original work' : ' and its retained artifact';
  test(`a real checkpoint successor verifies the original goal${suffix}`, async t => {
    const f = await goalHost(t, { capture: true });
    await f.open('lead'); await f.open('worker');
    success(await f.rpc('team.execute', { operation: 'message.send', payload: {
      to: 'lead', text: 'TEST preserve the original objective and verified artifact across checkpoint restore',
      actionMode: 'do', autonomousGoal: { durationHours: 12, maxAttempts: 8 },
    } }, 'TEST-original-goal'));
    const originalSession = f.session();
    await eventually(() => originalSession.submits.length === 1, 'the original human input is dispatched');
    const originalBinding = structuredClone(f.contexts.get('lead')!.endpoint.binding);
    const file = await f.captureWrite('lead', 0, 'TEST original artifact before checkpoint\n');
    if (scenario.priorContinuation) {
      originalSession.finish(0);
      await eventually(() => originalSession.submits.length === 2,
        'a real charged continuation runs before its original checkpoint');
    }
    const originalCount = originalSession.submits.length;
    const goal = f.goal()!;
    success(await f.rpc('team.goal.control', { goalId: goal.goalId, expectedRevision: goal.revision,
      action: 'stop' }, 'TEST-stop-before-checkpoint'));
    originalSession.finish(originalCount - 1);
    await eventually(() => f.runtime('lead')!.inputs.at(-1)?.terminal === 'succeeded',
      'the original native turn settles before checkpoint publication');
    originalSession.checkpoint = () => ({ ok: true,
      value: { history: originalSession.submits.map(input => input.content) } });
    const checkpoint = success<{ status: string; reference: string }>(await f.rpc('runtime.checkpoint', {
      memberId: 'lead-id', checkpointId: 'TEST-goal-original-checkpoint',
    }));
    assert.equal(checkpoint.status, 'published');
    success(await f.rpc('runtime.stop', { memberId: 'lead-id' }));
    assert.equal(f.runtime('lead')!.custody, 'released');
    const restored = success<{ generation: string; nativeReady: boolean }>(await f.rpc('runtime.restore', {
      memberId: 'lead-id', expectedGeneration: originalBinding.generation, reference: checkpoint.reference,
    }, 'TEST-goal-original-restore'));
    assert.notEqual(restored.generation, originalBinding.generation);
    assert.equal(restored.nativeReady, true);
    assert.deepEqual(f.restored, [{ history: originalSession.submits.map(input => input.content) }]);
    assert.notEqual(f.session(), originalSession);
    assert.equal(f.session().submits.length, 0, 'checkpoint restore never replays an original input');
    const snapshot = success<{ autonomousGoal: GoalStatus }>(await f.rpc('team.snapshot', {}));
    assert.equal(snapshot.autonomousGoal.canResume, true);
    const stopped = f.goal()!;
    success(await f.rpc('team.goal.control', { goalId: stopped.goalId, expectedRevision: stopped.revision,
      action: 'resume' }, 'TEST-resume-original-goal'));
    await eventually(() => f.session().submits.length === 1,
      () => `the genuine successor receives one new continuation: ${JSON.stringify(f.goal())}`);
    const successorBinding = f.contexts.get('lead')!.endpoint.binding;
    assert.equal(successorBinding.generation, restored.generation);
    assert.equal(Object.keys(f.goal()!.debits).length, scenario.priorContinuation ? 2 : 1);
    assert.ok(f.goal()!.debits[f.session().submits[0]!.inputId]);
    if (scenario.successorWrites)
      await f.captureWrite('lead', 0, 'TEST updated artifact from the genuine successor\n');
    const proposal = await f.tool('lead', 'goal_propose', {
      commandId: 'TEST-restored-goal-proposal', result: 'TEST verified original objective and current artifact',
    }) as GoalStatus;
    assert.equal(proposal.disposition, 'finalizing', JSON.stringify(proposal));
    f.session().finish(0);
    await eventually(() => f.goal()!.published === true,
      () => `the original and successor settle one verified result: ${JSON.stringify(f.goal())}`);
    assert.equal(originalSession.submits.length, originalCount);
    assert.equal(f.runtime('lead')!.inputs.at(-1)?.terminal, 'succeeded');
    assert.equal(f.runtimeStore.fenced(successorBinding, tx => tx.get()?.inputs[0]?.terminal), 'succeeded');
    assert.equal(readFileSync(file, 'utf8'), scenario.successorWrites
      ? 'TEST updated artifact from the genuine successor\n' : 'TEST original artifact before checkpoint\n');
    const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
    assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
  });
}
