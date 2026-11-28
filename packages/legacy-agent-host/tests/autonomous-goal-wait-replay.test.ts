import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildMemberWorkSyncReportRequestDigest } from '../dist/work-sync/policy/core/application/MemberWorkSyncReportJournalProtocol.js';
import { MemberWorkSyncReporter } from '../dist/work-sync/policy/core/application/MemberWorkSyncReporter.js';
import { inspectGoalWaits } from '../dist/work-sync/inspectGoalWaits.js';
import { goalWaitKey } from '../dist/work-sync/policy/core/domain/GoalWaitPolicy.js';
import type { GoalContinuation, GoalStatus } from '../dist/team/goalContracts.js';
import { TeamOwnerError, type CommandReceipt } from '../dist/team/contracts.js';
import { listTeamCommandEntries, teamCommandPath } from '../dist/team/commandEntries.js';
import { workSyncCommandFingerprint, type WorkSyncCommandReceipt } from '../dist/work-sync/commandContracts.js';
import type { GoalWaitReport } from '../dist/work-sync/policy/core/domain/GoalWaitPolicy.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/types.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';
import type { GoalMember } from './fixtures/autonomous-goal-host.ts';

test('original report digest includes exact wait facts while absent waits preserve the old digest', () => {
  const hash = { sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex') };
  const request = { teamName: 'TEST-team', memberName: 'lead', state: 'blocked' as const,
    agendaFingerprint: 'TEST-agenda', reportToken: 'TEST-token' };
  const original = hash.sha256Hex(JSON.stringify({ ...request, taskIds: [], note: '', reportedAt: '', leaseTtlMs: 0, source: '' }));
  assert.equal(buildMemberWorkSyncReportRequestDigest(hash, request), original);
  const wait = { kind: 'ci' as const, repository: 'TEST-owner/TEST-repository', runId: '1001',
    expectedCommit: 'a'.repeat(40), horizonAt: '2026-11-27T13:00:00.000Z', status: 'pending' as const };
  const withWait = buildMemberWorkSyncReportRequestDigest(hash, { ...request, wait });
  assert.notEqual(withWait, original);
  assert.equal(buildMemberWorkSyncReportRequestDigest(hash, { ...request, wait: { status: wait.status,
    horizonAt: wait.horizonAt, expectedCommit: wait.expectedCommit, runId: wait.runId, repository: wait.repository, kind: wait.kind } }), withWait);
  assert.notEqual(buildMemberWorkSyncReportRequestDigest(hash, { ...request, wait: { ...wait, status: 'succeeded' } }), withWait);
  const replacement = { ...wait, runId: '1002', supersedes: { runId: wait.runId, expectedCommit: wait.expectedCommit } };
  const linked = buildMemberWorkSyncReportRequestDigest(hash, { ...request, wait: replacement });
  assert.notEqual(linked, buildMemberWorkSyncReportRequestDigest(hash, { ...request, wait: { ...wait, runId: '1002' } }));
  assert.notEqual(linked, buildMemberWorkSyncReportRequestDigest(hash, { ...request,
    wait: { ...replacement, supersedes: { ...replacement.supersedes, runId: '1003' } } }));
  assert.equal(linked, buildMemberWorkSyncReportRequestDigest(hash, { ...request,
    wait: { ...replacement, supersedes: { expectedCommit: wait.expectedCommit, runId: wait.runId } } }));
});

test('completed native wait report replays after a shorter horizon without extending the original operation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const f = await goalHost(t); await f.open('lead'); await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST original bounded CI observation', actionMode: 'do', autonomousGoal: { durationHours: 1, maxAttempts: 8 } } }, 'TEST-replay-intake'));
  await eventually(() => f.session().submits.length === 1, 'original lead input is active');
  const wait = { kind: 'ci', repository: 'TEST-owner/TEST-repository', runId: '1001',
    expectedCommit: 'a'.repeat(40), horizonAt: '2026-11-27T12:40:00.000Z', status: 'pending' };
  const prepare = async (commandId: string, horizonAt: string) => {
    const status = await f.tool('lead', 'member_work_sync_status', { commandId: `${commandId}-status` }) as MemberWorkSyncStatus;
    assert.ok(status.reportToken);
    return { commandId, state: 'blocked', taskIds: [], agendaFingerprint: status.agenda.fingerprint,
      reportToken: status.reportToken, wait: { ...wait, horizonAt } };
  };
  const a = await prepare('TEST-long-wait', wait.horizonAt);
  const accepted = await f.tool('lead', 'member_work_sync_report', a) as { accepted: boolean };
  assert.equal(accepted.accepted, true);
  t.mock.timers.tick(1);
  const b = await prepare('TEST-short-wait', '2026-11-27T12:20:00.000Z');
  assert.equal((await f.tool('lead', 'member_work_sync_report', b) as { accepted: boolean }).accepted, true);
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', a), accepted);
  const extension = await prepare('TEST-new-extension', wait.horizonAt);
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', extension), { error: { code: 'invalid' } });
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', { ...a, wait: { ...a.wait, status: 'succeeded' } }),
    { error: { code: 'conflict' } });
  assert.equal(Object.keys(f.goal()!.debits).length, 0);
  const reports = f.teamStore.fenced(() => f.teamStore.list<WorkSyncCommandReceipt>('commands'))
    .filter(row => row.family === 'work-sync' && row.operation === 'report' && row.phase === 'completed');
  assert.equal(reports.length, 2);
  const slots = reports.map((row, index) => ({ ...row, payload: { ...(row.payload as Record<string, unknown>),
    wait: { ...wait, runId: String(1001 + index), ...(index ? { taskId: 'goal' } : {}) } } })) as WorkSyncCommandReceipt[];
  assert.equal(inspectGoalWaits(slots, [], f.goal()!.deadlineAt).length, 2,
    'task-free scope and a legitimate task named goal have distinct observation slots');

  // Projection uses accepted receipt facts; task/repository equality is not run supersession.
  for (const status of ['pending', 'failed', 'cancelled'] as const) {
    const original = { ...wait, kind: 'ci' as const, taskId: 'goal', runId: '101', status };
    const independent = { ...original, runId: '102', status: 'succeeded' as const };
    const sameTask = [original, independent].map((observed, index) => ({ ...reports[index]!,
      receivedAt: new Date(Date.parse('2026-11-27T12:00:00.000Z') + index).toISOString(),
      payload: { ...(reports[index]!.payload as Record<string, unknown>), wait: observed },
    })) as WorkSyncCommandReceipt[];
    const projected = inspectGoalWaits(sameTask, [], f.goal()!.deadlineAt);
    assert.equal(projected.length, 2, `${status} original and successful independent run both remain`);
    const retained = projected.find(row => row.key === goalWaitKey(original))!;
    assert.ok(retained);
    assert.deepEqual(retained.taskIds, ['goal']);
    assert.equal(retained.pending, status === 'pending');
    assert.equal(Boolean(retained.attentionReason), status !== 'pending');
    assert.deepEqual(inspectGoalWaits([...sameTask].reverse(), [], f.goal()!.deadlineAt)
      .sort((left, right) => left.key.localeCompare(right.key)),
    [...projected].sort((left, right) => left.key.localeCompare(right.key)),
    'persisted receipt enumeration order does not decide which run remains required');
  }
});

for (const originalStatus of ['pending', 'failed'] as const) {
  test(`a successful independent CI run cannot accept a goal with an original ${originalStatus} run`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
    const f = await goalHost(t, { solo: true }); await f.open('lead');
    success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
      text: 'TEST verify both independent CI runs before returning the bounded research result',
      actionMode: 'do', autonomousGoal: { durationHours: 1, maxAttempts: 8 },
    } }, 'TEST-independent-ci-intake'));
    await eventually(() => f.session().submits.length === 1, 'original lead input is active');
    const wait: GoalWaitReport = { kind: 'ci', repository: 'TEST-owner/TEST-repository', runId: '101',
      expectedCommit: 'a'.repeat(40), horizonAt: '2026-11-27T12:40:00.000Z', status: originalStatus };
    const report = async (commandId: string, observed: GoalWaitReport) => {
      const status = await f.tool('lead', 'member_work_sync_status', { commandId: `${commandId}-status` }) as MemberWorkSyncStatus;
      assert.ok(status.reportToken);
      const accepted = await f.tool('lead', 'member_work_sync_report', { commandId, state: 'blocked', taskIds: [],
        agendaFingerprint: status.agenda.fingerprint, reportToken: status.reportToken, wait: observed }) as { accepted: boolean };
      assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    };
    await report('TEST-original-ci', wait);
    t.mock.timers.tick(1);
    await report('TEST-independent-ci-success', { ...wait, runId: '102', status: 'succeeded' });
    assert.deepEqual(await f.tool('lead', 'goal_propose', {
      commandId: 'TEST-independent-ci-premature', result: 'TEST both CI runs must be verified',
    }), { error: { code: 'hold' } }, 'only the second run succeeded; the original still blocks acceptance');
    assert.equal(f.goal()!.disposition, 'active');
    assert.equal(f.goal()!.proposal, undefined);
    assert.equal(f.goal()!.published, undefined);
    assert.deepEqual(f.goal()!.debits, {});

    t.mock.timers.tick(1);
    await report('TEST-original-ci-resolved', { ...wait, status: 'succeeded' });
    const proposal = await f.tool('lead', 'goal_propose', {
      commandId: 'TEST-independent-ci-final', result: 'TEST both exact CI runs verified',
    }) as GoalStatus;
    assert.equal(proposal.disposition, 'finalizing', JSON.stringify(proposal));
    f.session().finish(0);
    await eventually(() => f.goal()?.published === true, 'the exact original result and native settlement allow one publication');
    const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
    assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
    assert.deepEqual(f.goal()!.debits, {}, 'passive observations and final publication do not allocate inputs');
    assert.equal(f.session().submits.length, 1);
  });
}

type WaitHost = Awaited<ReturnType<typeof goalHost>>;
const reference = (wait: GoalWaitReport) => ({ runId: wait.runId, expectedCommit: wait.expectedCommit });
const baseWait = (): GoalWaitReport => ({ kind: 'ci', repository: 'TEST-owner/TEST-repository', runId: '101',
  expectedCommit: 'a'.repeat(40), horizonAt: '2026-11-27T12:59:00.000Z', status: 'failed' });

async function waitGoal(t: TestContext, options = { solo: true, capture: false }): Promise<WaitHost> {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
  const f = await goalHost(t, options); await f.open('lead');
  if (!options.solo) await f.open('worker');
  success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
    text: 'TEST repair and verify the original objective using the exact required checks', actionMode: 'do',
    autonomousGoal: { durationHours: 1, maxAttempts: 16 } } }, 'TEST-replacement-intake'));
  await eventually(() => f.session().submits.length === 1, 'the original lead input is active');
  return f;
}

async function observeWait(f: WaitHost, commandId: string, wait: GoalWaitReport, member: GoalMember = 'lead') {
  const status = await f.tool(member, 'member_work_sync_status', { commandId: commandId + '-status' }) as MemberWorkSyncStatus;
  assert.ok(status.reportToken);
  const request = { commandId, state: 'blocked', taskIds: [], agendaFingerprint: status.agenda.fingerprint,
    reportToken: status.reportToken, wait };
  const result = await f.tool(member, 'member_work_sync_report', request) as { accepted?: boolean; error?: { code: string } };
  return { request, result };
}
async function acceptedWait(f: WaitHost, commandId: string, wait: GoalWaitReport, member: GoalMember = 'lead') {
  const observed = await observeWait(f, commandId, wait, member);
  assert.equal(observed.result.accepted, true, JSON.stringify(observed.result));
  return observed;
}
function waitReports(f: WaitHost): WorkSyncCommandReceipt[] {
  return f.teamStore.fenced(() => f.teamStore.list<WorkSyncCommandReceipt>('commands'))
    .filter(row => row.family === 'work-sync' && row.operation === 'report' && row.phase === 'completed');
}

test('self-consistent unsupported retained report or wait facts hold after the original receipt decoder', async t => {
  const f = await waitGoal(t), wait = { ...baseWait(), status: 'pending' as const };
  const status = await f.tool('lead', 'member_work_sync_status', { commandId: 'TEST-ordinary-status' }) as MemberWorkSyncStatus;
  assert.ok(status.reportToken);
  const ordinaryResult = await f.tool('lead', 'member_work_sync_report', {
    commandId: 'TEST-ordinary-report', state: 'caught_up', taskIds: [],
    agendaFingerprint: status.agenda.fingerprint, reportToken: status.reportToken,
  }) as { accepted: boolean };
  assert.equal(ordinaryResult.accepted, true, JSON.stringify(ordinaryResult));
  const ordinary = waitReports(f).find(row => row.commandId === 'TEST-ordinary-report')!;
  assert.deepEqual(inspectGoalWaits([ordinary], [], f.goal()!.deadlineAt), [], 'an ordinary report has no required wait');

  await acceptedWait(f, 'TEST-required-retained-wait', wait);
  const original = waitReports(f).find(row => row.commandId === 'TEST-required-retained-wait');
  assert.ok(original);
  const path = teamCommandPath(original.commandId), debits = structuredClone(f.goal()!.debits);
  const submits = f.session().submits.length;
  const write = (receipt: WorkSyncCommandReceipt) => f.teamStore.fenced(() => f.teamStore.write(path, receipt));
  const read = () => f.teamStore.fenced(() => listTeamCommandEntries(f.teamStore));
  const held = (error: unknown) => error instanceof TeamOwnerError && error.code === 'hold';
  try {
    const payload = original.payload as Record<string, unknown>;
    for (const [label, unsupportedPayload] of [
      ['wait-null', { ...payload, wait: null }],
      ['wait-future-kind', { ...payload, wait: { ...wait, kind: 'future-ci' } }],
      ['wait-future-field', { ...payload, wait: { ...wait, futureVersionField: true } }],
      ['payload-null', null], ['payload-string', 'future-report'],
      ['payload-number', 1], ['payload-boolean', true], ['payload-array', [payload]],
    ] as const) {
      // Model a self-consistent future retained fact, not a value the current MCP can accept.
      // Original Runtime/input authority and all goal debits remain untouched.
      const retained = JSON.parse(JSON.stringify({ ...original, payload: unsupportedPayload })) as WorkSyncCommandReceipt;
      write(retained);
      assert.throws(read, held, 'ordinary payload corruption is already held by the unchanged fingerprint guard');
      retained.fingerprint = workSyncCommandFingerprint(retained);
      write(retained);
      assert.deepEqual(read().find(row => row.commandId === original.commandId), retained,
        'the existing outer decoder accepts this self-consistent retained receipt');
      assert.throws(() => inspectGoalWaits([retained], [], f.goal()!.deadlineAt), held, label);
      assert.deepEqual(await f.tool('lead', 'goal_propose', {
        commandId: 'TEST-unsupported-wait-proposal-' + label, result: 'TEST retained check still needs an understood outcome',
      }), { error: { code: 'hold' } }, label);
      assert.equal(f.goal()!.disposition, 'active');
      assert.equal(f.goal()!.proposal, undefined);
      assert.equal(f.goal()!.published, undefined);
    }
  } finally { write(original); }
  const restored = inspectGoalWaits(waitReports(f), [], f.goal()!.deadlineAt);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.pending, true);
  assert.deepEqual(f.goal()!.debits, debits);
  assert.equal(f.session().submits.length, submits);
});

test('explicit failed-check replacement verifies repaired work without discarding independent pending CI', async t => {
  const f = await waitGoal(t, { solo: true, capture: true }), original = baseWait();
  await f.captureWrite('lead', 0, 'TEST first artifact requiring repair\n');
  await acceptedWait(f, 'TEST-red-original', original);
  await f.captureWrite('lead', 0, 'TEST repaired artifact for the new expected commit\n');
  const independent = { ...original, runId: '102', expectedCommit: 'c'.repeat(40), status: 'pending' as const };
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-independent-pending', independent);
  const replacement = { ...independent, runId: '103', supersedes: reference(original) };
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-replacement-pending', replacement);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-replacement-green',
    { ...independent, runId: replacement.runId, status: 'succeeded' });
  assert.deepEqual(await f.tool('lead', 'goal_propose', { commandId: 'TEST-still-independent',
    result: 'TEST independent original check must still finish' }), { error: { code: 'hold' } });
  assert.equal(f.goal()!.proposal, undefined);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-late-old-pending', { ...original, status: 'pending' });
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-independent-green', { ...independent, status: 'succeeded' });
  const projected = inspectGoalWaits(waitReports(f), [], f.goal()!.deadlineAt);
  assert.equal(projected.length, 2);
  assert.equal(projected.some(row => row.key === goalWaitKey(original)), false, 'late old report never restores the retired scope');
  assert.equal((await f.tool('lead', 'goal_propose', { commandId: 'TEST-repaired-final',
    result: 'TEST repaired artifact and both current check references verified' }) as GoalStatus).disposition, 'finalizing');
  f.session().finish(0);
  await eventually(() => f.goal()?.published === true, 'actual original native settlement publishes the repaired result');
  const page = success<{ messages: { messageId?: string }[] }>(await f.rpc('team.messages.page', {}));
  assert.equal(page.messages.filter(row => row.messageId === f.goal()!.proposal!.resultMessageId).length, 1);
  assert.deepEqual(f.goal()!.debits, {});
  assert.equal(f.session().submits.length, 1);
});

test('replacement rejects pending sources, forks, retrofits and changed originals while preserving other task associations', async t => {
  const f = await waitGoal(t), tasks: string[] = [];
  for (const id of ['one', 'two']) {
    const task = await f.tool('lead', 'task_create', { commandId: 'TEST-scope-' + id,
      subject: 'TEST original check scope ' + id, owner: 'lead' }) as CommandReceipt;
    assert.equal(task.phase, 'completed'); tasks.push(task.effects.taskId!);
  }
  const original = { ...baseWait(), taskId: tasks[0]! };
  await acceptedWait(f, 'TEST-shared-first', original);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-shared-second', { ...original, taskId: tasks[1]! });
  const independent = { ...original, runId: '102', status: 'pending' as const };
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-known-independent', independent);
  const replacement = { ...original, runId: '103', expectedCommit: 'b'.repeat(40),
    status: 'pending' as const, supersedes: reference(original) };
  t.mock.timers.tick(1); const accepted = await acceptedWait(f, 'TEST-first-link', replacement);
  const projected = inspectGoalWaits(waitReports(f), [], f.goal()!.deadlineAt);
  assert.deepEqual(projected.find(row => row.key === goalWaitKey(original))!.taskIds, [tasks[1]]);
  assert.deepEqual(projected.find(row => row.key === goalWaitKey(replacement))!.taskIds, [tasks[0]]);
  for (const [label, wait] of [
    ['pending', { ...replacement, runId: '104', supersedes: reference(independent) }],
    ['fork', { ...replacement, runId: '105' }],
    ['retrofit', { ...independent, supersedes: reference(original) }],
    ['changed-link', { ...replacement, supersedes: reference(independent) }],
    ['other-repository', { ...replacement, runId: '106', repository: 'TEST-owner/TEST-other' }],
    ['unknown', { ...replacement, runId: '107', supersedes: { ...reference(original), runId: '999' } }],
    ['self', { ...replacement, supersedes: reference(replacement) }],
  ] as const) {
    const observed = await observeWait(f, 'TEST-rejected-' + label, wait);
    assert.deepEqual(observed.result, { error: { code: 'invalid' } }, label);
  }
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', {
    ...accepted.request, wait: { ...replacement, supersedes: reference(independent) },
  }), { error: { code: 'conflict' } }, 'a repeated command cannot change its predecessor fingerprint');
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', accepted.request), accepted.result);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-repeat-link', replacement);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-shared-late-pending', { ...original, status: 'pending' });
  const after = inspectGoalWaits(waitReports(f), [], f.goal()!.deadlineAt);
  assert.deepEqual(after.find(row => row.key === goalWaitKey(original))!.taskIds, [tasks[1]]);
  assert.equal(after.find(row => row.key === goalWaitKey(original))!.pending, true);

});

test('only the captured lead or original observer of the exact task scope may authorize a replacement', async t => {
  const f = await waitGoal(t, { solo: false, capture: false }), tasks: string[] = [];
  for (const id of ['lead-observed', 'worker-observed']) {
    const task = await f.tool('lead', 'task_create', { commandId: 'TEST-authority-' + id,
      subject: 'TEST captured observation scope ' + id, owner: 'worker' }) as CommandReceipt;
    assert.equal(task.phase, 'completed'); tasks.push(task.effects.taskId!);
  }
  await eventually(() => f.session('worker').submits.length === 1, 'an actual goal-bound worker input is active');
  const original = { ...baseWait(), taskId: tasks[0]! };
  await acceptedWait(f, 'TEST-lead-observer', original);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-worker-observer',
    { ...original, taskId: tasks[1]! }, 'worker');
  const replacement = { ...original, runId: '102', status: 'pending' as const, supersedes: reference(original) };
  assert.deepEqual((await observeWait(f, 'TEST-wrong-observer', replacement, 'worker')).result,
    { error: { code: 'forbidden' } });
  await acceptedWait(f, 'TEST-own-scoped-observer', { ...replacement, taskId: tasks[1]! }, 'worker');
  const scoped = inspectGoalWaits(waitReports(f), [], f.goal()!.deadlineAt);
  assert.deepEqual(scoped.find(row => row.key === goalWaitKey(original))!.taskIds, [tasks[0]]);
  assert.deepEqual(scoped.find(row => row.key === goalWaitKey(replacement))!.taskIds, [tasks[1]]);
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-worker-replacement-failed',
    { ...replacement, taskId: tasks[1]!, status: 'failed' }, 'worker');
  const actors = ['lead', 'worker'] as const;
  const statuses = await Promise.all(actors.map(member => f.tool(member, 'member_work_sync_status',
    { commandId: 'TEST-leaf-race-status-' + member }) as Promise<MemberWorkSyncStatus>));
  let entered = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = MemberWorkSyncReporter.prototype.execute;
  t.mock.method(MemberWorkSyncReporter.prototype, 'execute', async function(
    this: MemberWorkSyncReporter, ...args: Parameters<typeof execute>
  ) {
    if (args[0].wait?.supersedes?.runId === replacement.runId) {
      entered++;
      await held;
    }
    return execute.apply(this, args);
  });
  const debits = structuredClone(f.goal()!.debits);
  const competing = actors.map((member, index) => {
    assert.ok(statuses[index]!.reportToken);
    return f.tool(member, 'member_work_sync_report', {
      commandId: 'TEST-leaf-race-' + member, state: 'blocked', taskIds: [],
      agendaFingerprint: statuses[index]!.agenda.fingerprint, reportToken: statuses[index]!.reportToken,
      wait: { ...replacement, runId: String(104 + index), taskId: tasks[1]!, supersedes: reference(replacement) },
    }) as Promise<{ accepted?: boolean; error?: { code: string } }>;
  });
  const settled = Promise.allSettled(competing);
  try {
    await eventually(() => entered === 2, 'both captured actors pass initial leaf validation before either report may finish');
    release();
    const results = await Promise.all(competing);
    assert.equal(results.filter(row => row.accepted === true).length, 1, 'only one replacement owns the original leaf');
    assert.equal(results.filter(row => row.error?.code === 'invalid').length, 1);
  } finally {
    release(); await settled;
  }
  assert.deepEqual(f.goal()!.debits, debits);
  await acceptedWait(f, 'TEST-authorized-lead-observer', replacement);
  const final = inspectGoalWaits(waitReports(f), [], f.goal()!.deadlineAt);
  assert.equal(final.length, 2);
  assert.equal(final.some(row => row.key === goalWaitKey(original)), false);
  assert.deepEqual(final.find(row => row.key === goalWaitKey(replacement))!.taskIds, [tasks[0]]);
  assert.equal(final.filter(row => row.taskIds.includes(tasks[1]!)).length, 1);
});

test('three exact operations preserve the original horizon and poll backoff without late ancestor reactivation', async t => {
  const f = await waitGoal(t), original = { ...baseWait(), status: 'pending' as const };
  const first = await acceptedWait(f, 'TEST-chain-a-pending', original);
  t.mock.timers.tick(6 * 60_000); await acceptedWait(f, 'TEST-chain-a-failed', { ...original, status: 'failed' });
  const second = { ...original, runId: '102', expectedCommit: 'b'.repeat(40),
    horizonAt: '2026-11-27T12:58:00.000Z', supersedes: reference(original) };
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-chain-b-pending', second);
  t.mock.timers.tick(16 * 60_000); await acceptedWait(f, 'TEST-chain-b-failed', { ...second, status: 'failed' });
  const third = { ...second, runId: '103', expectedCommit: 'c'.repeat(40), supersedes: reference(second) };
  assert.deepEqual((await observeWait(f, 'TEST-chain-horizon-extension', { ...third, horizonAt: original.horizonAt })).result,
    { error: { code: 'invalid' } });
  t.mock.timers.tick(1); const lastObserved = Date.now();
  const last = await acceptedWait(f, 'TEST-chain-c-pending', third);
  t.mock.timers.tick(8 * 60_000); await acceptedWait(f, 'TEST-chain-late-a', { ...original, status: 'pending' });
  t.mock.timers.tick(1); await acceptedWait(f, 'TEST-chain-late-b', { ...second, status: 'succeeded' });
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', first.request), first.result);
  assert.deepEqual(await f.tool('lead', 'member_work_sync_report', last.request), last.result);
  assert.deepEqual((await observeWait(f, 'TEST-chain-cycle', { ...original, supersedes: reference(third) })).result,
    { error: { code: 'invalid' } });
  const reports = waitReports(f), proof = reports[0]!.nativeInput;
  // Pure scheduling projection supplies historical observations; no debit or Runtime store is fabricated.
  const history: (GoalContinuation & { inputId: string; createdAt: string })[] = [original, second].map((wait, index) => ({
    target: proof.team.source, source: { binding: proof.team.source, inputId: proof.original.inputId,
      operationRef: proof.original.operationRef, inputFingerprint: proof.original.fingerprint },
    obligationKey: 'wait:' + goalWaitKey(wait), evidenceFingerprint: 'TEST-observation-' + index,
    reason: 'wait', sequence: index + 1, text: 'TEST original due observation',
    inputId: 'TEST-original-poll-' + index,
    createdAt: new Date(Date.parse('2026-11-27T12:00:00.000Z') + (index ? 21 : 5) * 60_000).toISOString(),
  }));
  const projected = inspectGoalWaits(reports, history, f.goal()!.deadlineAt);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.key, goalWaitKey(third));
  assert.equal(projected[0]!.pending, true);
  assert.equal(projected[0]!.horizonAt, Date.parse(second.horizonAt));
  assert.equal(projected[0]!.dueAt, lastObserved + 30 * 60_000,
    'ancestor poll count is retained, but their later reports cannot postpone the current operation');
  assert.equal(projected[0]!.attentionReason, undefined);
  assert.deepEqual(f.goal()!.debits, {});
  assert.equal(f.session().submits.length, 1);
});
