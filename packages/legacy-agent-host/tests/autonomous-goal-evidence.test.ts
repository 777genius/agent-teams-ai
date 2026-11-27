import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { digest } from '../dist/team/identity.js';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

test('damaged captured inventory, capped current bytes and a symlink all hold completion until the exact original evidence is readable', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST verify actual evidence availability before completion', actionMode: 'do',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-evidence-holds-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input starts');
  const file = await f.captureWrite('lead', 0, 'TEST original qualified artifact\n');
  const originalFile = readFileSync(file);
  const journal = join(f.root, 'teams', 'test-goal-team', '.host-evidence',
    '.board-task-changes', 'agents', 'lead-id', 'events.jsonl');
  const originalJournal = readFileSync(journal);
  appendFileSync(journal, '{"TEST-torn-tail":');
  assert.deepEqual(await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-evidence-damaged', result: 'TEST unavailable inventory is not success',
  }), { error: { code: 'hold' } });
  assert.equal(f.goal()!.proposal, undefined);
  writeFileSync(journal, originalJournal);

  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 'x'));
  assert.deepEqual(await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-evidence-capped', result: 'TEST capped artifact is not success',
  }), { error: { code: 'hold' } });
  writeFileSync(file, originalFile);
  const outside = join(f.root, 'TEST-outside-evidence-root.txt');
  writeFileSync(outside, 'TEST unrelated owned file must not become captured evidence\n');
  rmSync(file);
  symlinkSync(outside, file);
  assert.deepEqual(await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-evidence-symlink', result: 'TEST symlink is not a qualified artifact',
  }), { error: { code: 'hold' } });
  assert.notEqual(f.goal()!.published, true);
  rmSync(file);
  writeFileSync(file, originalFile);

  assert.equal((await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-evidence-readable', result: 'TEST original evidence is readable and verified',
  }) as GoalStatus).disposition, 'finalizing');
  assert.notEqual(f.goal()!.proposal!.evidenceFingerprint, digest([]));
  f.session().finish(0);
  await eventually(() => f.goal()?.published === true, 'restoring exact original evidence permits one final result');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
});

for (const workerWorkspace of ['nested', 'disjoint'] as const) {
  test('a live ordinary writer in a ' + workerWorkspace + ' workspace has the correct completion boundary', async t => {
    const f = await goalHost(t, { capture: true, workerWorkspace });
    await f.open('lead');
    await f.open('worker');
    success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'worker',
      text: 'TEST independent ordinary work stays active', actionMode: 'ask' } }, 'TEST-writer-ordinary'));
    await eventually(() => f.session('worker').submits.length === 1, 'unrelated native writer really starts');
    success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
      text: 'TEST finish only this original goal artifact', actionMode: 'do',
      autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-writer-goal'));
    await eventually(() => f.session().submits.length === 1, 'original goal input starts');
    await f.captureWrite('lead', 0, 'TEST original goal artifact\n');
    const proposal = await f.tool('lead', 'goal_propose', {
      commandId: 'TEST-writer-first-proposal', result: 'TEST current artifact candidate',
    });
    if (workerWorkspace === 'nested') {
      assert.deepEqual(proposal, { error: { code: 'hold' } },
        'segment-overlapping cwd remains a possible writer even with a different pathname');
      f.session('worker').finish(0);
      await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'succeeded', 'overlapping ordinary input settles');
      assert.equal((await f.tool('lead', 'goal_propose', {
        commandId: 'TEST-writer-settled-proposal', result: 'TEST overlapping original writer is settled',
      }) as GoalStatus).disposition, 'finalizing');
    } else {
      assert.equal((proposal as GoalStatus).disposition, 'finalizing');
    }
    f.session().finish(0);
    await eventually(() => f.goal()?.published === true, 'only overlapping original writers constrain finalization');
    if (workerWorkspace === 'disjoint') {
      assert.equal(f.runtime('worker')!.inputs[0]!.phase, 'consumed',
        'unrelated disjoint native work is not globally required to be idle');
      f.session('worker').finish(0);
      await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'succeeded', 'owned unrelated input settles for cleanup');
    }
    assert.equal(f.session('worker').submits.length, 1);
  });
}

test('completion retains a removed worker original artifact without reviving its native authority', async t => {
  const f = await goalHost(t, { capture: true });
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST preserve verified work when its completed worker is removed', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 8 } } }, 'TEST-removed-evidence-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input starts');
  const task = await f.tool('lead', 'task_create', { commandId: 'TEST-removed-evidence-task',
    subject: 'TEST artifact from a subsequently removed worker', owner: 'worker' }) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  const taskId = task.effects.taskId;
  await eventually(() => f.session('worker').submits.length === 1, 'actual first worker assignment starts');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: 'TEST-removed-evidence-start', taskId,
  }) as CommandReceipt).phase, 'completed');
  await f.captureWrite('worker', 0, 'TEST retained original worker artifact\n');
  assert.equal((await f.tool('worker', 'task_complete', {
    commandId: 'TEST-removed-evidence-complete', taskId,
  }) as CommandReceipt).phase, 'completed');
  f.session('worker').finish(0);
  await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'succeeded', 'worker settles its exact original input');
  success(await f.rpc('runtime.stop', { memberId: 'worker-id', expectedGeneration: '1' }));
  assert.equal(f.goal()!.disposition, 'stopped', 'explicit Runtime Stop closes the original goal gate');
  const roster = success<{ revision: number }>(await f.rpc('team.roster.read', {}));
  success(await f.rpc('team.roster.replace', { expectedRevision: roster.revision, members: [] },
    'TEST-remove-completed-worker', { phase: 'capture', remainingMs: 100_000 }));
  const removed = success<{ members: { memberId: string }[]; removedMembers: { memberId: string }[] }>(
    await f.rpc('team.roster.read', {}));
  assert.equal(removed.members.some(member => member.memberId === 'worker-id'), false);
  assert.equal(removed.removedMembers.some(member => member.memberId === 'worker-id'), true);
  assert.equal(f.runtime('worker')!.custody, 'released');
  assert.equal(f.runtime('worker')!.inputs[0]!.terminal, 'succeeded');
  const opens = f.opens();
  const stopped = f.goal()!;
  success(await f.rpc('team.goal.control', { goalId: stopped.goalId,
    expectedRevision: stopped.revision, action: 'resume' }, 'TEST-resume-after-worker-removal'));
  const proposal = await f.tool('lead', 'goal_propose', {
    commandId: 'TEST-removed-evidence-final', result: 'TEST retained original file is verified',
  }) as GoalStatus;
  assert.equal(proposal.disposition, 'finalizing');
  assert.notEqual(f.goal()!.proposal!.evidenceFingerprint, digest([]),
    'removed actor evidence remains part of the actual candidate fingerprint');
  f.session().finish(0);
  await eventually(() => f.goal()?.published === true, 'retained original evidence permits publication through the current authorized reader');
  assert.equal(f.opens(), opens, 'reading retained evidence allocates no replacement worker');
  assert.equal(f.runtime('worker')!.custody, 'released');
});
