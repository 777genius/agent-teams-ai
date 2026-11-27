import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildMemberWorkSyncReportRequestDigest } from '../dist/work-sync/policy/core/application/MemberWorkSyncReportJournalProtocol.js';
import { inspectGoalWaits } from '../dist/work-sync/inspectGoalWaits.js';
import type { WorkSyncCommandReceipt } from '../dist/work-sync/commandContracts.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/types.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

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
});
