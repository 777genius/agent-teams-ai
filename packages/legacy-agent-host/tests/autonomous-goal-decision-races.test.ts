import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentChangeLedgerReader } from '@agent-teams/task-change-ledger';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/types.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

for (const change of ['task-completed', 'ci-wait-started'] as const) {
  test(`an artifact read cannot mint an obsolete continuation after ${change}`, async t => {
    const f = await goalHost(t, { capture: true });
    await f.open('lead'); await f.open('worker');
    success(await f.rpc('team.execute', { operation: 'message.send', payload: { to: 'lead',
      text: 'TEST preserve current task and wait state across artifact reads', actionMode: 'delegate',
      autonomousGoal: { durationHours: 12, maxAttempts: 8 },
    } }, `TEST-decision-${change}-intake`));
    await eventually(() => f.session().submits.length === 1, 'original lead input starts');
    const task = await f.tool('lead', 'task_create', { commandId: `TEST-decision-${change}-task`,
      subject: 'TEST worker artifact', owner: 'worker' }) as CommandReceipt;
    assert.equal(task.phase, 'completed');
    await eventually(() => f.session('worker').submits.length === 1, 'original assignment starts');
    assert.equal((await f.tool('worker', 'task_start', { commandId: `TEST-decision-${change}-start`,
      taskId: task.effects.taskId }) as CommandReceipt).phase, 'completed');
    await f.captureWrite('worker', 0, 'TEST verified bytes before the concurrent change\n');
    const read = AgentChangeLedgerReader.prototype.readAgentChangesWithEvidence;
    let pending = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(AgentChangeLedgerReader.prototype, 'readAgentChangesWithEvidence', async function (
      this: AgentChangeLedgerReader, request: Parameters<typeof read>[0]
    ) {
      const result = await read.call(this, request);
      if (request.actorId === 'worker-id' && !pending) {
        pending = true;
        await gate;
      }
      return result;
    });
    try {
      f.session('worker').finish(0);
      await eventually(() => pending, 'real goal progress read is suspended after reading its original evidence');
      if (change === 'task-completed') {
        // Human completion is authorized; a non-owning native lead cannot finish another member's task.
        const completed = f.rpc('team.execute', { operation: 'task.lifecycle', payload: {
          taskId: task.effects.taskId, action: 'complete',
        } }, 'TEST-decision-completed-during-read');
        void completed.catch(() => {});
        await eventually(() => JSON.parse(readFileSync(join(f.root, 'tasks',
          f.selected.teams[0]!.binding.teamName, `${task.effects.taskId}.json`), 'utf8')).status === 'completed',
        'authorized human mutation commits while the original artifact read is still pending');
        release();
        assert.equal(success<CommandReceipt>(await completed).phase, 'completed');
      } else {
        const status = await f.tool('lead', 'member_work_sync_status', {
          commandId: 'TEST-decision-wait-status',
        }) as MemberWorkSyncStatus;
        assert.ok(status.reportToken);
        const reported = await f.tool('lead', 'member_work_sync_report', {
          commandId: 'TEST-decision-wait-report', state: 'blocked', taskIds: [],
          agendaFingerprint: status.agenda.fingerprint, reportToken: status.reportToken,
          wait: { kind: 'ci', repository: 'TEST-owner/TEST-repo', runId: '101',
            expectedCommit: 'a'.repeat(40), taskId: task.effects.taskId,
            horizonAt: new Date(Date.now() + 30 * 60_000).toISOString(), status: 'pending' },
        }) as { accepted: boolean };
        assert.equal(reported.accepted, true);
      }
      release();
      success(await f.rpc('runtime.dispatch', { memberId: 'worker-id' }));
      const continuations = f.teamStore.fenced(() => f.teamStore.list<CommandReceipt>('commands'))
        .filter(receipt => receipt.goal?.continuation?.obligationKey.startsWith(`task:${task.effects.taskId}:`));
      assert.deepEqual(continuations, [], 'no obsolete task intent is persisted, admitted, or charged');
      assert.equal(f.session('worker').submits.length, 1);
      assert.equal(Object.values(f.goal()!.debits).filter(row => row.binding.memberId === 'worker-id').length,
        1, 'only the actual original worker assignment consumed an attempt; obsolete work adds no charge');
      if (change === 'ci-wait-started') assert.match(f.goal()!.reason!, /101/u);
    } finally { release(); }
  });
}
