import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamOwner } from '../dist/team/TeamOwner.js';
import { digest } from '../dist/team/identity.js';
import type { CommandReceipt, DeliveryIntent } from '../dist/team/contracts.js';
import type { GoalRecord, GoalStatus } from '../dist/team/goalContracts.js';
import { eventually, goalHost, success } from './fixtures/autonomous-goal-host.ts';

function originalOwner(t: TestContext) {
  let owner: TeamOwner | undefined;
  const connect = TeamOwner.prototype.connect;
  t.mock.method(TeamOwner.prototype, 'connect', function (this: TeamOwner, principalId: string) {
    if (principalId === 'human') owner = this;
    return connect.call(this, principalId);
  });
  return () => {
    assert.ok(owner);
    return owner;
  };
}

const originalDelivery = (f: Awaited<ReturnType<typeof goalHost>>, commandId: string) => {
  const found = f.teamStore
    .fenced(() => f.teamStore.list<DeliveryIntent>('outbox'))
    .filter((row) => row.commandId === commandId && row.binding.memberId === 'worker-id');
  assert.equal(found.length, 1);
  return found[0]!;
};

function captureWorkerWorkspace(f: Awaited<ReturnType<typeof goalHost>>) {
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q'], {
    cwd: f.workerWorkspace,
    env: {
      PATH: process.env.PATH,
      HOME: f.root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

for (const boundary of ['stop', 'deadline', 'attempt-limit'] as const) {
  test(`an explicit human TaskStart still runs after the goal ${boundary}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T12:00:00.000Z') });
    const f = await goalHost(t);
    await f.open('lead');
    await f.open('worker');
    success(
      await f.rpc(
        'team.execute',
        {
          operation: 'message.send',
          payload: {
            to: 'lead',
            text: 'TEST create the scoped task before automatic work closes',
            actionMode: 'delegate',
            autonomousGoal: { durationHours: 1, maxAttempts: boundary === 'attempt-limit' ? 1 : 8 },
          },
        },
        'TEST-manual-intake'
      )
    );
    await eventually(
      () => f.session().submits.length === 1,
      'the original objective reaches its lead'
    );
    const created = (await f.tool('lead', 'task_create', {
      commandId: 'TEST-manual-task',
      subject: 'TEST pending scoped work remains available to its human',
      owner: 'worker',
    })) as CommandReceipt;
    assert.equal(created.phase, 'completed');
    assert.equal(created.goal?.goalId, f.goal()!.goalId);
    const taskId = created.effects.taskId;
    await eventually(
      () => f.session('worker').submits.length === 1,
      'the original automatic assignment is claimed'
    );
    assert.equal(
      success<{ status: string }>(await f.rpc('team.task.get', { taskId })).status,
      'pending'
    );

    const goal = f.goal()!;
    if (boundary === 'stop') {
      assert.equal(
        success<GoalStatus>(
          await f.rpc(
            'team.goal.control',
            {
              goalId: goal.goalId,
              expectedRevision: goal.revision,
              action: 'stop',
            },
            'TEST-manual-stop'
          )
        ).disposition,
        'stopped'
      );
    } else if (boundary === 'deadline') {
      t.mock.timers.tick(60 * 60_000 + 1);
      f.contexts.get('lead')!.onProgress();
      await eventually(
        () => f.goal()?.deadlineReached === true,
        'the original deadline is durably observed'
      );
    } else assert.equal(Object.keys(goal.debits).length, goal.attemptLimit);

    f.session('worker').finish(0);
    f.session().finish(0);
    await eventually(
      () =>
        f.runtime('worker')?.inputs[0]?.terminal === 'succeeded' &&
        f.runtime('lead')?.inputs[0]?.terminal === 'succeeded',
      'both original automatic inputs settle'
    );
    const before = structuredClone(f.goal()!);
    const command = { operation: 'task.start', payload: { taskId, notification: 'user' } };
    const started = success<CommandReceipt>(
      await f.rpc('team.execute', command, 'TEST-manual-start')
    );
    assert.equal(started.phase, 'completed');
    assert.equal(started.principalId, 'human');
    assert.equal(
      success<{ status: string }>(await f.rpc('team.task.get', { taskId })).status,
      'in_progress'
    );
    const deliveries = f.teamStore
      .fenced(() => f.teamStore.list<DeliveryIntent>('outbox'))
      .filter((row) => row.commandId === started.commandId && row.binding.memberId === 'worker-id');
    assert.equal(
      deliveries.length,
      1,
      'the exact human command retains one original native notification'
    );
    const manualId = deliveries[0]!.inputId;
    await eventually(
      () =>
        f.session('worker').submits.some((input) => input.inputId === manualId) ||
        f
          .runtime('worker')!
          .inputs.some(
            (input) =>
              input.intent.inputId === manualId &&
              ['cancelled', 'rejected', 'not-sent'].includes(input.phase)
          ),
      'the original human start reaches its real Runtime decision'
    );
    t.diagnostic(
      JSON.stringify({
        boundary,
        commandPhase: started.phase,
        goalKind: started.goal?.kind,
        taskStatus: success<{ status: string }>(await f.rpc('team.task.get', { taskId })).status,
        manualPhase: f.runtime('worker')!.inputs.find((input) => input.intent.inputId === manualId)
          ?.phase,
        workerSubmits: f.session('worker').submits.length,
        attempts: Object.keys(f.goal()!.debits).length,
      })
    );
    assert.equal(
      f.session('worker').submits.filter((input) => input.inputId === manualId).length,
      1,
      'explicit human work is not cancelled by the closed automatic goal gate'
    );
    assert.deepEqual(
      f.goal()!.debits,
      before.debits,
      'human start does not spend an automatic attempt'
    );
    assert.equal(f.goal()!.deadlineAt, before.deadlineAt);
    assert.equal(f.goal()!.disposition, before.disposition);
    assert.deepEqual(success(await f.rpc('team.execute', command, 'TEST-manual-start')), started);
    assert.equal(
      f.session('worker').submits.filter((input) => input.inputId === manualId).length,
      1,
      'the same original human command cannot submit twice'
    );
    if (boundary === 'stop') {
      const followup = (await f.tool('worker', 'task_create', {
        commandId: 'TEST-manual-auto-followup',
        subject: 'TEST native follow-up still requires automatic authority',
        owner: 'lead',
      })) as CommandReceipt;
      assert.equal(followup.phase, 'completed');
      assert.equal(followup.goal?.goalId, before.goalId);
      await eventually(
        () =>
          f.teamStore
            .fenced(() => f.teamStore.list<DeliveryIntent>('outbox'))
            .some((row) => row.commandId === followup.commandId && row.phase === 'not_admitted'),
        'the derived automatic notification reaches its closed original admission gate'
      );
      assert.equal(
        f.session().submits.length,
        1,
        'manual authority does not authorize native follow-up work'
      );
      assert.deepEqual(f.goal()!.debits, before.debits);
    }
    f.session('worker').finish(1);
    await eventually(
      () =>
        f.runtime('worker')!.inputs.find((input) => input.intent.inputId === manualId)?.terminal ===
        'succeeded',
      'the separately authorized human input retains its own terminal receipt'
    );
  });
}

test('an active human TaskStart remains uncharged and preserves ordinary actor and recipient authority', async (t) => {
  const owner = originalOwner(t);
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(
    await f.rpc(
      'team.execute',
      {
        operation: 'message.send',
        payload: {
          to: 'lead',
          text: 'TEST preserve independent human task authority',
          actionMode: 'delegate',
          autonomousGoal: { durationHours: 12, maxAttempts: 8 },
        },
      },
      'TEST-active-manual-intake'
    )
  );
  await eventually(() => f.session().submits.length === 1, 'the original lead input starts');
  const task = (await f.tool('lead', 'task_create', {
    commandId: 'TEST-active-manual-task',
    subject: 'TEST pending work for an explicit human start',
    owner: 'worker',
  })) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  await eventually(
    () => f.session('worker').submits.length === 1,
    'the automatic assignment starts'
  );
  f.session('worker').finish(0, 'failed');
  await eventually(
    () => f.runtime('worker')!.inputs[0]?.terminal === 'failed',
    'the original outcome is known'
  );
  const before = structuredClone(f.goal()!);
  const command = {
    commandId: 'TEST-denied-member-start',
    operation: 'task.start' as const,
    payload: { taskId: task.effects.taskId, notification: 'user' as const },
  };
  assert.throws(() => owner().connect('worker-session').execute(command), { code: 'forbidden' });
  assert.equal(
    owner().connect('human').lookup(command.commandId),
    undefined,
    'a claimed user notification does not grant a native actor human TaskStart authority'
  );
  assert.deepEqual(
    await f.rpc(
      'team.execute',
      {
        operation: 'task.start',
        payload: {
          ...command.payload,
          expectedRecipient: {
            name: 'worker',
            memberId: 'worker-id',
            runId: 'TEST-goal-run',
            generation: '2',
          },
        },
      },
      'TEST-stale-manual-recipient'
    ),
    { ok: false, code: 'hold', outcome: 'unknown' }
  );
  assert.equal(owner().connect('human').lookup('TEST-stale-manual-recipient'), undefined);
  const start = success<CommandReceipt>(
    await f.rpc(
      'team.execute',
      {
        operation: command.operation,
        payload: command.payload,
      },
      'TEST-active-human-start'
    )
  );
  const manual = originalDelivery(f, start.commandId);
  await eventually(
    () => f.session('worker').submits.length === 2,
    'the exact human start is claimed'
  );
  assert.equal(f.session('worker').submits[1]!.inputId, manual.inputId);
  assert.equal(owner().goals.humanTaskStart(manual), true);
  assert.deepEqual(f.goal()!.debits, before.debits);
  assert.equal(f.goal()!.disposition, 'active');
  success(
    await f.rpc(
      'team.goal.control',
      { goalId: before.goalId, expectedRevision: before.revision, action: 'stop' },
      'TEST-stop-active-manual'
    )
  );
  await f.rpc('team.snapshot', {});
  assert.equal(
    f.runtime('worker')!.inputs[1]!.phase,
    'consumed',
    'Goal Stop leaves the claimed human input intact'
  );
  f.session('worker').finish(1);
  f.session().finish(0);
  await eventually(
    () =>
      f.runtime('worker')!.inputs[1]!.terminal === 'succeeded' &&
      f.runtime('lead')!.inputs[0]!.terminal === 'succeeded',
    'both original inputs settle without replacement'
  );
  assert.equal(f.goal()!.disposition, 'stopped');
  assert.deepEqual(f.goal()!.debits, before.debits);
  assert.equal(f.session('worker').submits.length, 2);
});

test('a proved human TaskStart invalidates a finalizing candidate inside the actual native claim fence', async (t) => {
  const owner = originalOwner(t);
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(
    await f.rpc(
      'team.execute',
      {
        operation: 'message.send',
        payload: {
          to: 'lead',
          text: 'TEST recheck a result when the human explicitly starts more work',
          actionMode: 'delegate',
          autonomousGoal: { durationHours: 12, maxAttempts: 8 },
        },
      },
      'TEST-manual-claim-intake'
    )
  );
  await eventually(() => f.session().submits.length === 1, 'the root lead input starts');
  const task = (await f.tool('lead', 'task_create', {
    commandId: 'TEST-manual-claim-task',
    subject: 'TEST completed scoped task may be reopened by its human',
    owner: 'worker',
  })) as CommandReceipt;
  await eventually(() => f.session('worker').submits.length === 1, 'the assignment starts');
  assert.equal(
    (
      (await f.tool('worker', 'task_complete', {
        commandId: 'TEST-manual-claim-complete',
        taskId: task.effects.taskId,
      })) as CommandReceipt
    ).phase,
    'completed'
  );
  f.session('worker').finish(0);
  await eventually(
    () => f.runtime('worker')!.inputs[0]!.terminal === 'succeeded',
    'the worker settles'
  );
  f.session().finish(0);
  await eventually(
    () => f.session().submits.length === 2,
    'the lead consumes its canonical task-completion notification'
  );
  assert.equal(
    (
      (await f.tool('lead', 'goal_propose', {
        commandId: 'TEST-manual-claim-proposal',
        result: 'TEST original finalizing candidate',
      })) as GoalStatus
    ).disposition,
    'finalizing'
  );
  const before = structuredClone(f.goal()!);
  let claimedGoal: GoalRecord | undefined;
  f.session('worker').submitAction = async (input) => {
    claimedGoal = structuredClone(f.goal()!);
    return {
      ok: true,
      value: {
        inputId: input.inputId,
        operationRef: input.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  // Hold only the later policy reconciliation to isolate the synchronous claim barrier.
  const reconcile = t.mock.method(owner().goals, 'reconcileCandidate', () => {});
  try {
    assert.equal(
      success<CommandReceipt>(
        await f.rpc(
          'team.execute',
          {
            operation: 'task.lifecycle',
            payload: { taskId: task.effects.taskId, action: 'pending' },
          },
          'TEST-manual-claim-reopen'
        )
      ).phase,
      'completed'
    );
    assert.equal(
      f.goal()!.disposition,
      'finalizing',
      'the ordinary policy is held until the real manual claim'
    );
    const start = success<CommandReceipt>(
      await f.rpc(
        'team.execute',
        { operation: 'task.start', payload: { taskId: task.effects.taskId, notification: 'user' } },
        'TEST-manual-claim-start'
      )
    );
    assert.equal(start.phase, 'completed');
    assert.equal(start.goal?.goalId, before.goalId);
    await eventually(
      () => !!claimedGoal,
      'the original provider submit sees the invalidated candidate'
    );
    assert.ok(claimedGoal);
    assert.equal(claimedGoal.disposition, 'active');
    assert.equal(claimedGoal.proposal, undefined);
    assert.deepEqual(claimedGoal.debits, before.debits);
    assert.equal(f.session('worker').submits.length, 2);
  } finally {
    reconcile.mock.restore();
  }
  assert.notEqual(f.goal()!.published, true);
  success(
    await f.rpc(
      'team.goal.control',
      { goalId: before.goalId, expectedRevision: before.revision, action: 'stop' },
      'TEST-manual-claim-stop'
    )
  );
  f.session('worker').finish(1);
  f.session().finish(1);
  await eventually(
    () => f.runtime('worker')!.inputs[1]!.terminal === 'succeeded',
    'the original manual claim settles'
  );
});

test('uncharged manual work holds completion and its late artifact requires fresh lead verification', async (t) => {
  const f = await goalHost(t, { capture: true, workerWorkspace: 'disjoint' });
  captureWorkerWorkspace(f);
  await f.open('lead');
  await f.open('worker');
  success(
    await f.rpc(
      'team.execute',
      {
        operation: 'message.send',
        payload: {
          to: 'lead',
          text: 'TEST include actual uncharged manual effects in final verification',
          actionMode: 'delegate',
          autonomousGoal: { durationHours: 12, maxAttempts: 12 },
        },
      },
      'TEST-manual-evidence-intake'
    )
  );
  await eventually(() => f.session().submits.length === 1, 'the root lead input starts');
  const task = (await f.tool('lead', 'task_create', {
    commandId: 'TEST-manual-evidence-task',
    subject: 'TEST original manual artifact',
    owner: 'worker',
  })) as CommandReceipt;
  await eventually(
    () => f.session('worker').submits.length === 1,
    'the original worker assignment starts'
  );
  const start = success<CommandReceipt>(
    await f.rpc(
      'team.execute',
      { operation: 'task.start', payload: { taskId: task.effects.taskId, notification: 'user' } },
      'TEST-manual-evidence-start'
    )
  );
  const manual = originalDelivery(f, start.commandId);
  await eventually(
    () =>
      f
        .runtime('worker')!
        .inputs.some((row) => row.intent.inputId === manual.inputId && row.phase === 'admitted'),
    'the exact separate manual input is admitted behind its original assignment'
  );
  assert.equal(f.goal()!.debits[manual.inputId], undefined);
  assert.equal(
    (
      (await f.tool('worker', 'task_complete', {
        commandId: 'TEST-manual-evidence-complete',
        taskId: task.effects.taskId,
      })) as CommandReceipt
    ).phase,
    'completed'
  );
  f.session().finish(0);
  await eventually(
    () => f.session().submits.length === 2,
    'the lead consumes the canonical completion notification'
  );
  assert.deepEqual(
    await f.tool('lead', 'goal_propose', {
      commandId: 'TEST-manual-evidence-too-early',
      result: 'TEST unconsumed manual work cannot disappear',
    }),
    { error: { code: 'hold' } }
  );
  f.session('worker').finish(0);
  await eventually(
    () => f.session('worker').submits.length === 2,
    'the same admitted human input starts once'
  );
  await f.captureWrite('worker', 1, 'TEST first original uncharged artifact\n');
  assert.equal(
    (
      (await f.tool('lead', 'goal_propose', {
        commandId: 'TEST-manual-evidence-first',
        result: 'TEST manually produced artifact candidate',
      })) as GoalStatus
    ).disposition,
    'finalizing'
  );
  const candidate = structuredClone(f.goal()!.proposal!);
  assert.notEqual(
    candidate.evidenceFingerprint,
    digest([]),
    'the manual input contributes actual captured file evidence'
  );
  f.session().finish(1);
  await eventually(
    () => f.runtime('lead')!.inputs[1]!.terminal === 'succeeded',
    'the proposing lead settles first'
  );
  await f.rpc('team.snapshot', {});
  assert.equal(
    f.goal()!.disposition,
    'finalizing',
    'the disjoint manual native input still prevents completion'
  );
  assert.notEqual(f.goal()!.published, true);
  await f.captureWrite('worker', 1, 'TEST late original uncharged artifact change\n');
  f.session('worker').finish(1);
  await eventually(
    () => f.session().submits.length === 3,
    'the changed manual artifact requires fresh lead verification'
  );
  assert.equal(f.goal()!.disposition, 'active');
  assert.equal(f.goal()!.proposal, undefined);
  assert.equal(f.goal()!.debits[manual.inputId], undefined);
  assert.equal(
    (
      (await f.tool('lead', 'goal_propose', {
        commandId: 'TEST-manual-evidence-current',
        result: 'TEST verified current manual artifact',
      })) as GoalStatus
    ).disposition,
    'finalizing'
  );
  assert.notEqual(f.goal()!.proposal!.evidenceFingerprint, candidate.evidenceFingerprint);
  f.session().finish(2);
  await eventually(
    () => f.goal()?.published === true,
    'all original inputs and current manual artifacts permit one result'
  );
  const page = success<{ messages: { messageId?: string }[] }>(
    await f.rpc('team.messages.page', {})
  );
  assert.equal(
    page.messages.filter((row) => row.messageId === candidate.resultMessageId).length,
    0
  );
  assert.equal(
    page.messages.filter((row) => row.messageId === f.goal()!.proposal!.resultMessageId).length,
    1
  );
});

test('an incomplete original human start holds its proof without debit or automatic retirement', async (t) => {
  const owner = originalOwner(t);
  const f = await goalHost(t);
  await f.open('lead');
  await f.open('worker');
  success(
    await f.rpc(
      'team.execute',
      {
        operation: 'message.send',
        payload: {
          to: 'lead',
          text: 'TEST recover the original human task start without reclassifying it',
          actionMode: 'delegate',
          autonomousGoal: { durationHours: 12, maxAttempts: 8 },
        },
      },
      'TEST-held-manual-intake'
    )
  );
  await eventually(() => f.session().submits.length === 1, 'the original objective starts');
  const task = (await f.tool('lead', 'task_create', {
    commandId: 'TEST-held-manual-task',
    subject: 'TEST manual original publication interruption',
    owner: 'worker',
  })) as CommandReceipt;
  await eventually(
    () => f.session('worker').submits.length === 1,
    'the original assignment starts'
  );
  const before = structuredClone(f.goal()!);
  success(
    await f.rpc(
      'team.goal.control',
      { goalId: before.goalId, expectedRevision: before.revision, action: 'stop' },
      'TEST-held-manual-stop'
    )
  );
  f.session('worker').finish(0);
  await eventually(
    () => f.runtime('worker')!.inputs[0]!.terminal === 'succeeded',
    'the original worker settles'
  );
  const commandId = 'TEST-held-manual-start';
  const command = {
    operation: 'task.start',
    payload: { taskId: task.effects.taskId, notification: 'user' },
  };
  const write = TeamOwnerStore.prototype.write;
  let failures = 0;
  const fault = t.mock.method(
    TeamOwnerStore.prototype,
    'write',
    function (this: TeamOwnerStore, path: string, value: unknown) {
      const receipt = value as Partial<CommandReceipt>;
      if (
        path.startsWith('commands/') &&
        receipt.commandId === commandId &&
        receipt.phase === 'completed'
      ) {
        failures++;
        throw new Error('TEST before original manual receipt completion');
      }
      return write.call(this, path, value);
    }
  );
  try {
    assert.deepEqual(await f.rpc('team.execute', command, commandId), {
      ok: false,
      code: 'hold',
      outcome: 'unknown',
    });
    assert.ok(failures > 0, 'the fault follows actual original outbox publication');
    const original = originalDelivery(f, commandId);
    assert.throws(() => owner().goals.humanTaskStart(original), { code: 'hold' });
    assert.throws(() => owner().goals.authorizeInput(original, 'admit'), { code: 'hold' });
    assert.throws(() => owner().goals.inputBindings(), { code: 'hold' });
    assert.deepEqual(f.goal()!.debits, before.debits);
    assert.equal(
      f.runtime('worker')!.inputs.some((input) => input.intent.inputId === original.inputId),
      false
    );
  } finally {
    fault.mock.restore();
  }
  const completed = success<CommandReceipt>(await f.rpc('team.execute', command, commandId));
  assert.equal(completed.phase, 'completed');
  await eventually(
    () => f.session('worker').submits.length === 2,
    'the same original receipt recovers one human submit'
  );
  assert.deepEqual(f.goal()!.debits, before.debits);
  assert.equal(f.goal()!.disposition, 'stopped');
  f.session('worker').finish(1);
  f.session().finish(0);
  await eventually(
    () => f.runtime('worker')!.inputs[1]!.terminal === 'succeeded',
    'the recovered original settles'
  );
});

test('completion retains an uncharged manual generation and its file after an actual checkpoint Restore', async (t) => {
  const owner = originalOwner(t);
  const f = await goalHost(t, { capture: true, workerWorkspace: 'disjoint' });
  captureWorkerWorkspace(f);
  await f.open('lead');
  await f.open('worker');
  success(
    await f.rpc(
      'team.execute',
      {
        operation: 'message.send',
        payload: {
          to: 'lead',
          text: 'TEST retain manual originals independently of the automatic debit inventory',
          actionMode: 'delegate',
          autonomousGoal: { durationHours: 12, maxAttempts: 8 },
        },
      },
      'TEST-retained-manual-intake'
    )
  );
  await eventually(() => f.session().submits.length === 1, 'the root lead input starts');
  const task = (await f.tool('lead', 'task_create', {
    commandId: 'TEST-retained-manual-task',
    subject: 'TEST task assigned only after automatic work stops',
  })) as CommandReceipt;
  assert.equal(task.phase, 'completed');
  const goal = f.goal()!;
  success(
    await f.rpc(
      'team.goal.control',
      { goalId: goal.goalId, expectedRevision: goal.revision, action: 'stop' },
      'TEST-retained-manual-stop'
    )
  );
  const assignment = success<CommandReceipt>(
    await f.rpc(
      'team.execute',
      { operation: 'task.assign', payload: { taskId: task.effects.taskId, owner: 'worker' } },
      'TEST-retained-manual-assign'
    )
  );
  assert.equal(assignment.phase, 'completed');
  await eventually(
    () => originalDelivery(f, assignment.commandId).phase === 'not_admitted',
    'the automatic assignment is denied while the original goal is stopped'
  );
  assert.equal(f.session('worker').submits.length, 0);
  const start = success<CommandReceipt>(
    await f.rpc(
      'team.execute',
      { operation: 'task.start', payload: { taskId: task.effects.taskId, notification: 'user' } },
      'TEST-retained-manual-start'
    )
  );
  const manual = originalDelivery(f, start.commandId);
  const originalSession = f.session('worker');
  await eventually(
    () => originalSession.submits.length === 1,
    'the separately authorized original human input starts'
  );
  await f.captureWrite(
    'worker',
    0,
    'TEST file produced only by the retained uncharged generation\n'
  );
  assert.equal(
    (
      (await f.tool('worker', 'task_complete', {
        commandId: 'TEST-retained-manual-complete',
        taskId: task.effects.taskId,
      })) as CommandReceipt
    ).phase,
    'completed'
  );
  originalSession.finish(0);
  await eventually(
    () =>
      f.runtime('worker')!.inputs.find((input) => input.intent.inputId === manual.inputId)
        ?.terminal === 'succeeded',
    'the uncharged manual original settles before Restore'
  );
  assert.deepEqual(
    f.goal()!.debits,
    {},
    'no automatic input is a substitute witness for this worker generation'
  );
  originalSession.checkpoint = () => ({ ok: true, value: { TEST: 'manual original checkpoint' } });
  const checkpoint = success<{ status: string; reference: string }>(
    await f.rpc('runtime.checkpoint', {
      memberId: 'worker-id',
      checkpointId: 'TEST-manual-original-checkpoint',
    })
  );
  assert.equal(checkpoint.status, 'published');
  success(await f.rpc('runtime.stop', { memberId: 'worker-id' }));
  const restored = success<{ generation: string }>(
    await f.rpc(
      'runtime.restore',
      {
        memberId: 'worker-id',
        expectedGeneration: manual.binding.generation,
        reference: checkpoint.reference,
      },
      'TEST-manual-original-restore'
    )
  );
  assert.notEqual(restored.generation, manual.binding.generation);
  assert.equal(f.session('worker').submits.length, 0);
  assert.deepEqual(owner().goals.inputBindings().get(manual.inputId), {
    backendId: manual.binding.backendId,
    teamId: manual.binding.teamId,
    runId: manual.binding.runId,
    memberId: manual.binding.memberId,
    generation: manual.binding.generation,
  });
  success(
    await f.rpc(
      'team.goal.control',
      { goalId: goal.goalId, expectedRevision: goal.revision, action: 'resume' },
      'TEST-retained-manual-resume'
    )
  );
  assert.equal(
    (
      (await f.tool('lead', 'goal_propose', {
        commandId: 'TEST-retained-manual-proposal',
        result: 'TEST the retained manual file is verified',
      })) as GoalStatus
    ).disposition,
    'finalizing'
  );
  assert.notEqual(f.goal()!.proposal!.evidenceFingerprint, digest([]));
  f.session().finish(0);
  await eventually(
    () => f.goal()?.published === true,
    'retained uncharged input evidence permits one original result'
  );
  assert.equal(originalSession.submits.length, 1);
  assert.equal(
    f.session('worker').submits.length,
    0,
    'evidence reads never recreate a manual native effect'
  );
  assert.deepEqual(f.goal()!.debits, {});
});
