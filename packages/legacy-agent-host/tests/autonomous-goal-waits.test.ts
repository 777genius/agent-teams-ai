import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { GoalWaitReport } from '../dist/work-sync/policy/core/domain/GoalWaitPolicy.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/types.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';
import type { GoalMember } from './fixtures/autonomous-goal-host.ts';

test('shared exact CI wait permits independent work, charges one due observer, ignores old-SHA success and stops at its horizon', async t => {
  // Advance only wall-clock observations; all Host/store/MCP work and disposal run normally.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST finish both tasks and observe the original CI operation', actionMode: 'delegate',
    autonomousGoal: { durationHours: 12, maxAttempts: 16 } } }, 'TEST-ci-intake'));
  await eventually(() => f.session().submits.length === 1, 'lead receives original objective');
  const first = await f.tool('lead', 'task_create', { commandId: 'TEST-ci-wait-task',
    subject: 'TEST task waiting for exact original CI', owner: 'worker' }) as CommandReceipt;
  const independent = await f.tool('lead', 'task_create', { commandId: 'TEST-ci-independent-task',
    subject: 'TEST independent useful work', owner: 'worker' }) as CommandReceipt;
  assert.equal(first.phase, 'completed');
  assert.equal(independent.phase, 'completed');
  await eventually(() => f.session('worker').submits.length === 1, 'first assignment reaches actual worker');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: 'TEST-ci-wait-start', taskId: first.effects.taskId,
  }) as CommandReceipt).phase, 'completed');

  let reports = 0;
  const report = async (member: GoalMember, wait: GoalWaitReport) => {
    const id = `TEST-ci-sync-${++reports}`;
    const status = await f.tool(member, 'member_work_sync_status', { commandId: `${id}-status` }) as MemberWorkSyncStatus;
    assert.ok(status.reportToken, 'original native status issues the real signed report token');
    const request = { commandId: `${id}-report`, state: 'blocked',
      agendaFingerprint: status.agenda.fingerprint, reportToken: status.reportToken,
      taskIds: [], wait };
    const result = await f.tool(member, 'member_work_sync_report', request) as { accepted: boolean };
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.deepEqual(await f.tool(member, 'member_work_sync_report', request), result,
      'replayed original report is not another wait or attempt');
    return result;
  };
  const wait: GoalWaitReport = { kind: 'ci', repository: 'TEST-owner/TEST-repository',
    runId: '1001', expectedCommit: 'a'.repeat(40), taskId: first.effects.taskId,
    horizonAt: '2026-11-27T12:30:00.000Z', status: 'pending' };
  await report('worker', wait);
  t.mock.timers.tick(1);
  await report('lead', wait);
  assert.deepEqual(await f.tool('worker', 'member_work_sync_status', {
    commandId: 'TEST-ci-no-force', forceNudge: true,
  }), { error: { code: 'unsupported' } }, 'goal reports do not gain a separate uncharged DO nudge');

  f.session('worker').finish(0);
  await eventually(() => f.session('worker').submits.length === 2,
    'a waiting branch does not strand the already authorized independent assignment');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: 'TEST-ci-independent-start', taskId: independent.effects.taskId,
  }) as CommandReceipt).phase, 'completed');
  assert.equal((await f.tool('worker', 'task_complete', {
    commandId: 'TEST-ci-independent-complete', taskId: independent.effects.taskId,
  }) as CommandReceipt).phase, 'completed');
  f.session('worker').finish(1);
  f.session().finish(0);
  await eventually(() => f.runtime('worker')?.inputs[1]?.terminal === 'succeeded' &&
    f.runtime('lead')?.inputs[0]?.terminal === 'succeeded', 'both current original inputs settle');
  const beforeDue = Object.keys(f.goal()!.debits).length;
  for (let read = 0; read < 3; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session('worker').submits.length, 2);
  assert.equal(f.session().submits.length, 1, 'shared pending CI is quiet before its due observation');
  assert.equal(Object.keys(f.goal()!.debits).length, beforeDue);

  t.mock.timers.tick(6 * 60_000);
  f.contexts.get('lead')!.onProgress();
  await eventually(() => f.session('worker').submits.length === 3, 'only the original observer receives the due check');
  assert.equal(f.session().submits.length, 1);
  assert.equal(Object.keys(f.goal()!.debits).length, beforeDue + 1);
  assert.match(f.session('worker').submits[2]!.content, /read-only|read.only/u);
  assert.match(f.session('worker').submits[2]!.content, /1001/u);
  assert.match(f.session('worker').submits[2]!.content, new RegExp('a'.repeat(40), 'u'));

  // A new exact check replaces this task's observation; a late old result cannot release it.
  const newer = { ...wait, runId: '1002', expectedCommit: 'b'.repeat(40) };
  await report('worker', newer);
  t.mock.timers.tick(1);
  await report('worker', { ...wait, status: 'succeeded' });
  f.session('worker').finish(2);
  await eventually(() => f.runtime('worker')?.inputs[2]?.terminal === 'succeeded', 'original due observation settles');
  for (let read = 0; read < 3; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session('worker').submits.length, 3, 'old green SHA cannot release newer pending work');
  assert.notEqual(f.goal()!.published, true);

  t.mock.timers.tick(25 * 60_000);
  f.contexts.get('worker')!.onProgress();
  await eventually(() => /Waiting limit reached/u.test(f.goal()?.reason ?? ''), 'original finite horizon becomes visible Attention');
  assert.match(f.goal()!.reason!, /1002/u);
  assert.equal(f.session('worker').submits.length, 3, 'expired horizon creates no catch-up checks');
  assert.equal(f.session().submits.length, 1);
  assert.equal(Object.keys(f.goal()!.debits).length, beforeDue + 1);
});
