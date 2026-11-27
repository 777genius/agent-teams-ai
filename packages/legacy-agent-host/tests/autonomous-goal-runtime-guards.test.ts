import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertGoalWorkspaceIsolation } from '../dist/composition/assertGoalWorkspaceIsolation.js';
import { createRuntimeWorkSyncWake } from '../dist/composition/createRuntimeWorkSyncWake.js';
import { executeCapturedRuntimeControl } from '../dist/composition/executeCapturedRuntimeControl.js';
import { HostInteractionControls } from '../dist/composition/HostInteractionControls.js';
import type { MemberEntry } from '../dist/composition/MemberEntry.js';
import type { RuntimeInput, RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import { fixture } from './native-member-actions-fixture.ts';

for (const goalActive of [false, true]) {
  test(`ordinary member self-Stop preserves its original control grant${goalActive ? ' and closes active goal admission first' : ' without a goal'}`, async t => {
    const f = await fixture(t);
    const member = [...f.entries.values()].find(entry => entry.binding.memberId === 'A')!;
    const principalId = member.profile.principalId;
    const teamId = f.team.definition.binding.teamId;
    const interactionControls = new HostInteractionControls({ principalId, runtime: f.runtime,
      assertCurrent() {}, kick() {} });
    const options: Parameters<typeof executeCapturedRuntimeControl>[0] = {
      teams: new Map([[teamId, f.team]]), capturedTeams: new Map([[teamId, f.team]]),
      entries: f.entries, launches: new Map([[teamId, f.launch]]), retainedLaunches: new Map(),
      runtime: f.runtime, interactionControls, principalId, hostIncarnation: 'TEST-host',
      isSealed: () => false, assertWriter() {}, kick() {}, async dispatchSettled() {},
      async closeEndpoint() {}, rekey() { assert.fail('Stop cannot adopt a new binding'); },
      projection: (_entry, record) => ({ phase: record?.phase ?? 'missing' }),
      activityProjection() { assert.fail('Stop does not read activity'); },
    };
    try {
      if (goalActive) {
        const receipt = f.owner.executeGoalCommand('human', {
          commandId: 'TEST-self-stop-goal', operation: 'message.send', payload: {
            to: 'leader', text: 'TEST objective retaining ordinary member controls', actionMode: 'delegate',
            autonomousGoal: { durationHours: 12, maxAttempts: 8 },
          },
        }, { intake: { binding: f.lead.binding } });
        assert.equal(receipt.phase, 'completed');
      }
      await assert.rejects(executeCapturedRuntimeControl(options, teamId, 'stop', { memberId: 'B' }),
        { code: 'forbidden' }, 'self-control never authorizes stopping another member');
      assert.equal(f.owner.goals.snapshot()?.disposition, goalActive ? 'active' : undefined);
      const driver = f.drivers.get('A:1')!;
      const close = driver.close;
      t.mock.method(driver, 'close', async () => {
        assert.equal(f.owner.goals.snapshot()?.disposition, goalActive ? 'stopped' : undefined,
          'the canonical goal latch precedes the first native Stop effect');
        return close();
      });
      assert.deepEqual(await executeCapturedRuntimeControl(options, teamId, 'stop', { memberId: 'A' }),
        { phase: 'closed' });
      assert.equal(driver.closed, 1);
      assert.equal(f.runtime.readCapturedSession(member.binding).record?.custody, 'released');
    } finally {
      interactionControls.seal();
      for (const entry of f.entries.values()) await f.runtime.stopCapturedSession(entry.binding);
    }
  });
}

test('revocation cannot remove an unsettled captured workspace from the other-Team overlap guard', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-goal-isolation-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'nested'), disjoint = join(root, 'nested-sibling');
  mkdirSync(nested); mkdirSync(disjoint);
  // This guard receives only captured path/binding projections; Runtime custody is supplied separately.
  const entry = (teamId: string, cwd: string) => ({ binding: { teamId }, profile: { cwd } }) as MemberEntry;
  const own = entry('TEST-goal', nested), foreign = entry('TEST-foreign', root);
  let phase: RuntimeInput['phase'] = 'claimed';
  const readRuntime = (binding: MemberEntry['binding']) => {
    assert.equal(binding.teamId, 'TEST-foreign', 'claim-time isolation never re-enters the target Runtime fence');
    return { attached: true, record: { inputs: [{ phase }] } as RuntimeSessionRecord };
  };
  const current = (row: MemberEntry) => row === own;
  for (phase of ['claimed', 'consumed', 'unknown'] as const) {
    assert.throws(() => assertGoalWorkspaceIsolation('TEST-goal', [own, foreign], current, readRuntime),
      { code: 'hold' }, `${phase} original may still write after revocation`);
  }
  phase = 'terminal';
  assert.doesNotThrow(() => assertGoalWorkspaceIsolation('TEST-goal', [own, foreign], current, readRuntime));
  phase = 'unknown';
  assert.doesNotThrow(() => assertGoalWorkspaceIsolation('TEST-goal', [own, entry('TEST-foreign', disjoint)], current, readRuntime),
    'segment boundaries preserve isolation for a disjoint sibling directory');
});

test('a failed goal wake still recovers accepted ordinary Work Sync work', async () => {
  const calls: string[] = [];
  const entry = { delivery: { teamName: 'TEST-team' }, async settleWorkSync() {
    calls.push('ordinary'); return { held: [] };
  } } as unknown as MemberEntry;
  const wake = createRuntimeWorkSyncWake({ entries: new Map([['TEST-entry', entry]]),
    isCurrent: () => true, isSealed: () => false,
    async settleGoal() { calls.push('goal'); throw new Error('TEST unavailable strict goal projection'); },
  });
  try { await wake.runOnce(); assert.deepEqual(calls, ['goal', 'ordinary']); }
  finally { await wake.dispose(); }
});

test('ordinary fallback rechecks the original grant after asynchronous goal settlement', async () => {
  let current = true, ordinary = 0;
  const entry = { delivery: { teamName: 'TEST-team' }, async settleWorkSync() {
    ordinary++; return { held: [] };
  } } as unknown as MemberEntry;
  const wake = createRuntimeWorkSyncWake({ entries: new Map([['TEST-entry', entry]]),
    isCurrent: () => current, isSealed: () => false,
    async settleGoal() { await Promise.resolve(); current = false; },
  });
  try { await wake.runOnce(); assert.equal(ordinary, 0); }
  finally { await wake.dispose(); }
});

for (const current of [true, false]) {
  test(`a ${current ? 'failed' : 'retired'} goal discovery cannot suppress another Team ordinary wake`, async () => {
    const calls: string[] = [];
    const unavailable = { delivery: { teamName: 'TEST-unavailable-goal-team' }, team: { owner: { goals: {
      snapshot() { calls.push('unavailable-read'); throw new Error('TEST retained goal state is unreadable'); },
    } } } } as unknown as MemberEntry;
    const healthy = { delivery: { teamName: 'TEST-healthy-ordinary-team' }, async settleWorkSync() {
      calls.push('ordinary'); return { held: [] };
    } } as unknown as MemberEntry;
    const wake = createRuntimeWorkSyncWake({ entries: new Map([['TEST-unavailable', unavailable], ['TEST-healthy', healthy]]),
      isCurrent: entry => entry !== unavailable || current, isSealed: () => false,
    });
    try {
      await wake.runOnce();
      assert.deepEqual(calls, current ? ['unavailable-read', 'ordinary'] : ['ordinary']);
    } finally { await wake.dispose(); }
  });
}
