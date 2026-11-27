import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { listProductCommandReceipts } from '../dist/team/commandEntries.js';
import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import type { GoalRecord } from '../dist/team/goalContracts.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/types.js';
import type { GoalWaitReport } from '../dist/work-sync/policy/core/domain/GoalWaitPolicy.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';
import type { GoalMember } from './fixtures/autonomous-goal-host.ts';

type Fixture = Awaited<ReturnType<typeof goalHost>>;

async function workingTask(t: TestContext, suffix: string) {
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: {
    to: 'lead', text: 'TEST finish the task and observe its original CI operation',
    actionMode: 'delegate', autonomousGoal: { durationHours: 12, maxAttempts: 16 },
  } }, `TEST-admission-${suffix}-intake`));
  await eventually(() => f.session().submits.length === 1, 'lead receives the original objective');
  const task = await f.tool('lead', 'task_create', {
    commandId: `TEST-admission-${suffix}-task`, subject: 'TEST current worker task', owner: 'worker',
  }) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  await eventually(() => f.session('worker').submits.length === 1, 'the real assignment starts');
  assert.equal((await f.tool('worker', 'task_start', {
    commandId: `TEST-admission-${suffix}-start`, taskId: task.effects.taskId,
  }) as CommandReceipt).phase, 'completed');
  return { f, taskId: task.effects.taskId };
}

async function report(f: Fixture, member: GoalMember, commandId: string, wait: GoalWaitReport) {
  const status = await f.tool(member, 'member_work_sync_status', {
    commandId: `${commandId}-status`,
  }) as MemberWorkSyncStatus;
  assert.ok(status.reportToken, 'the real current native input issues the report token');
  const accepted = await f.tool(member, 'member_work_sync_report', {
    commandId, state: 'blocked', taskIds: [], reportToken: status.reportToken,
    agendaFingerprint: status.agenda.fingerprint, wait,
  }) as { accepted: boolean };
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
}

function pendingWait(taskId: string): GoalWaitReport {
  return { kind: 'ci', repository: 'TEST-owner/TEST-admission', runId: '1001',
    expectedCommit: 'a'.repeat(40), taskId,
    horizonAt: new Date(Date.now() + 60 * 60_000).toISOString(), status: 'pending' };
}

/** Lower actual provider readiness after the real debit, before Runtime can claim the input. */
function holdNextContinuation(t: TestContext, f: Fixture) {
  const existing = new Set(Object.keys(f.goal()!.debits));
  const write = TeamOwnerStore.prototype.write;
  let captured: string | undefined;
  t.mock.method(TeamOwnerStore.prototype, 'write', function (this: TeamOwnerStore, name: string, value: unknown) {
    write.call(this, name, value);
    if (this.root !== f.root || name !== 'state.json' || captured) return;
    const state = value as { autonomousGoal?: GoalRecord };
    for (const [inputId, debit] of Object.entries(state.autonomousGoal?.debits ?? {})) {
      if (existing.has(inputId) || debit.binding.memberId !== 'worker-id') continue;
      const original = listProductCommandReceipts(this).find(row => row.commandId === debit.commandId);
      if (original?.goal?.kind !== 'continuation') continue;
      captured = inputId;
      f.session('worker').ready = false;
      break;
    }
  });
  return async () => {
    await eventually(() => !!captured && f.runtime('worker')?.inputs.some(input =>
      input.intent.inputId === captured && input.phase === 'admitted') === true,
    'the real charged continuation is admitted without a native claim');
    assert.ok(captured);
    const inputId = captured;
    const receipt = f.teamStore.fenced(() => listProductCommandReceipts(f.teamStore)
      .find(row => row.effects.deliveryId === inputId));
    assert.ok(receipt?.goal?.continuation, 'the original typed product receipt is retained');
    assert.equal(f.session('worker').submits.length, 1, 'admission has made no second native submit');
    return { inputId, receipt };
  };
}

async function assertRetired(f: Fixture, inputId: string, handoffCommandId?: string) {
  assert.ok(f.goal()!.debits[inputId], 'the original automatic attempt was charged');
  f.session('worker').ready = true;
  f.contexts.get('worker')!.onProgress();
  await eventually(() => f.runtime('worker')?.inputs.some(input => input.intent.inputId === inputId &&
    ['cancelled', 'rejected'].includes(input.phase)) === true,
  'fresh claim/retirement rules invalidate the original queued continuation');
  if (handoffCommandId) await eventually(() => f.session('worker').submits.length === 2,
    'the existing canonical old-owner handoff notification is delivered');
  for (let read = 0; read < 2; read++) success(await f.rpc('team.snapshot', {}));
  assert.equal(f.session('worker').submits.some(input => input.inputId === inputId), false,
    'obsolete continuation never reaches the provider');
  assert.equal(f.session('worker').submits.length, handoffCommandId ? 2 : 1);
  if (handoffCommandId) {
    const notification = f.session('worker').submits[1]!;
    const original = f.teamStore.fenced(() => f.teamStore.read<DeliveryIntent>(`outbox/${notification.inputId}.json`));
    assert.equal(original?.commandId, handoffCommandId,
      'the only extra native submission belongs to the original canonical assignment');
    assert.match(notification.content, /reassigned away from you/u);
  }
  assert.ok(f.goal()!.debits[inputId], 'invalidating queued work never refunds its original debit');
}

test('a newly reported pending CI wait invalidates an already admitted task continuation', async t => {
  const { f, taskId } = await workingTask(t, 'task-wait');
  const held = holdNextContinuation(t, f);
  f.session('worker').finish(0);
  const original = await held();
  assert.match(original.receipt.goal!.continuation!.obligationKey, new RegExp(`^task:${taskId}:`, 'u'));
  await report(f, 'lead', 'TEST-admission-task-now-waits', pendingWait(taskId));
  await assertRetired(f, original.inputId);
});

test('a fresh observation postpones and invalidates the already admitted original wait check', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const { f, taskId } = await workingTask(t, 'wait-observed');
  const wait = pendingWait(taskId);
  await report(f, 'worker', 'TEST-admission-wait-first', wait);
  f.session('worker').finish(0);
  await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'succeeded', 'original worker input settles');
  const held = holdNextContinuation(t, f);
  t.mock.timers.tick(6 * 60_000);
  f.contexts.get('worker')!.onProgress();
  const original = await held();
  assert.equal(original.receipt.goal!.continuation!.reason, 'wait');
  t.mock.timers.tick(1);
  await report(f, 'lead', 'TEST-admission-wait-observed-again', wait);
  await assertRetired(f, original.inputId);
});

test('reassignment invalidates a due check admitted for the previous task observer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const { f, taskId } = await workingTask(t, 'wait-reassigned');
  await report(f, 'worker', 'TEST-admission-reassigned-first', pendingWait(taskId));
  f.session('worker').finish(0);
  await eventually(() => f.runtime('worker')?.inputs[0]?.terminal === 'succeeded', 'original worker input settles');
  const held = holdNextContinuation(t, f);
  t.mock.timers.tick(6 * 60_000);
  f.contexts.get('worker')!.onProgress();
  const original = await held();
  assert.equal(original.receipt.goal!.continuation!.reason, 'wait');
  const commandId = 'TEST-admission-reassign-observer';
  const changed = await f.tool('lead', 'task_set_owner', {
    commandId, taskId, owner: 'lead',
  }) as CommandReceipt | { error: { code: string } };
  if ('error' in changed) assert.deepEqual(changed, { error: { code: 'hold' } },
    'canonical assignment waits for its original cancellation proof');
  else assert.equal(changed.phase, 'completed');
  f.contexts.get('lead')!.onProgress();
  await eventually(() => f.teamStore.fenced(() => listProductCommandReceipts(f.teamStore)
    .find(row => row.commandId === commandId)?.phase === 'completed'),
  'the same original assignment publishes after the obsolete queued input is cancelled');
  assert.equal((await f.tool('lead', 'task_get', { taskId }) as { owner: string }).owner, 'lead');
  await assertRetired(f, original.inputId, commandId);
});
