import { hostTeamRunId, hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { createHostFailedMemberRetry } from '@renderer/components/team/createHostFailedMemberRetry';
import {
  clearAllTeamLocalStateEpochs,
  invalidateTeamLocalStateEpoch,
} from '@renderer/store/team/teamLocalStateEpoch';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { beforeEach, expect, it, vi } from 'vitest';

const teamName = hostTeamSelectionKey('TEST-owner');
const runId = hostTeamRunId('TEST-owner', 'TEST-launch', 'TEST-roster');
function fixture() {
  const state = {
    activeContextId: 'local',
    isContextSwitching: false,
    currentRuntimeRunIdByTeam: { [teamName]: runId },
    currentProvisioningRunIdByTeam: { [teamName]: runId },
    ignoredRuntimeRunIds: {} as Record<string, string>,
    ignoredProvisioningRunIds: {} as Record<string, string>,
  };
  const names = ['Alice', 'Bob'];
  const failedSelections = Object.fromEntries(
    names.map((name) => [
      name,
      {
        runId,
        memberId: name,
        generation: `${name}-1`,
        attemptId: `${name}-failed`,
        noAllocation: false,
      },
    ])
  );
  const restartMember = vi.fn(async () => {});
  const retry = createHostFailedMemberRetry({
    teamName,
    runId,
    contextId: state.activeContextId,
    memberNames: names,
    failedSelections,
    getState: () => state,
    restartMember,
  });
  return { state, names, failedSelections, restartMember, retry };
}

beforeEach(() => {
  resetContextScopedRequestEpochForTests();
  clearAllTeamLocalStateEpochs();
});

it('reuses existing restart sequentially with the original names and no secondary flag', async () => {
  const f = fixture();
  let release!: () => void;
  f.restartMember.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  f.names.splice(0, f.names.length, 'Foreign');
  const pending = f.retry();
  expect(f.restartMember.mock.calls).toEqual([
    [teamName, 'Alice', undefined, f.failedSelections.Alice],
  ]);
  release();
  await expect(pending).resolves.toEqual({ kind: 'host', attempted: ['Alice', 'Bob'] });
  expect(f.restartMember.mock.calls).toEqual([
    [teamName, 'Alice', undefined, f.failedSelections.Alice],
    [teamName, 'Bob', undefined, f.failedSelections.Bob],
  ]);
});

it.each([
  'context',
  'switching',
  'epoch',
  'team-epoch',
  'runtime',
  'provisioning',
  'stopped',
] as const)(
  'refuses a stale %s before another action and does not fall back to a new selection',
  async (change) => {
    const f = fixture();
    f.restartMember.mockImplementationOnce(async () => {
      if (change === 'context') f.state.activeContextId = 'remote';
      if (change === 'switching') f.state.isContextSwitching = true;
      if (change === 'epoch') invalidateContextScopedRequestEpoch();
      if (change === 'team-epoch') invalidateTeamLocalStateEpoch(teamName);
      if (change === 'runtime') f.state.currentRuntimeRunIdByTeam[teamName] = 'different';
      if (change === 'provisioning') f.state.currentProvisioningRunIdByTeam[teamName] = 'different';
      if (change === 'stopped') f.state.ignoredRuntimeRunIds[runId] = teamName;
    });
    await expect(f.retry()).rejects.toThrow('Team launch changed');
    expect(f.restartMember.mock.calls).toEqual([
      [teamName, 'Alice', undefined, f.failedSelections.Alice],
    ]);
  }
);

it('refuses revoked intent before admission, including switching away and back to the same context', async () => {
  const f = fixture();
  invalidateContextScopedRequestEpoch();
  await expect(f.retry()).rejects.toThrow('Team launch changed');
  expect(f.restartMember).not.toHaveBeenCalled();
});

it('stops after uncertain recovery instead of issuing another member restart', async () => {
  const f = fixture();
  f.restartMember.mockRejectedValueOnce(new Error('hold: unknown original effect'));
  await expect(f.retry()).rejects.toThrow('hold: unknown original effect');
  expect(f.restartMember.mock.calls).toEqual([
    [teamName, 'Alice', undefined, f.failedSelections.Alice],
  ]);
});

it('rejects a foreign launch binding before any action', async () => {
  const f = fixture();
  const retry = createHostFailedMemberRetry({
    teamName,
    runId: hostTeamRunId('OTHER-owner', 'TEST-launch', 'TEST-roster'),
    contextId: 'local',
    memberNames: ['Alice'],
    failedSelections: f.failedSelections,
    getState: () => f.state,
    restartMember: f.restartMember,
  });
  await expect(retry()).rejects.toThrow('does not belong');
  expect(f.restartMember).not.toHaveBeenCalled();
});

it('keeps a copied failed generation and refuses to invent a missing source observation', async () => {
  const f = fixture();
  const original = structuredClone(f.failedSelections.Alice);
  f.failedSelections.Alice!.generation = 'later-generation';
  await f.retry();
  expect(f.restartMember.mock.calls[0]).toEqual([teamName, 'Alice', undefined, original]);
  const retry = createHostFailedMemberRetry({
    teamName,
    runId,
    contextId: 'local',
    memberNames: ['Missing'],
    failedSelections: {},
    getState: () => f.state,
    restartMember: f.restartMember,
  });
  f.restartMember.mockClear();
  await expect(retry()).rejects.toThrow('Failed teammate status is unavailable');
  expect(f.restartMember).not.toHaveBeenCalled();
});

function projectFixture() {
  const f = fixture();
  const provisioningTeamName = hostTeamSelectionKey('TEST-logical-owner');
  f.state.currentRuntimeRunIdByTeam[provisioningTeamName] = runId;
  f.state.currentProvisioningRunIdByTeam[provisioningTeamName] = runId;
  delete f.state.currentProvisioningRunIdByTeam[teamName];
  const retry = createHostFailedMemberRetry({
    teamName,
    provisioningTeamName,
    runId,
    contextId: f.state.activeContextId,
    memberNames: f.names,
    failedSelections: f.failedSelections,
    getState: () => f.state,
    restartMember: f.restartMember,
  });
  return { ...f, provisioningTeamName, retry };
}

it.each(['absent', 'same'] as const)(
  'retries the captured physical project with a logical progress owner and %s physical progress pin',
  async (pin) => {
    const f = projectFixture();
    if (pin === 'same') f.state.currentProvisioningRunIdByTeam[teamName] = runId;
    await expect(f.retry()).resolves.toEqual({ kind: 'host', attempted: ['Alice', 'Bob'] });
    expect(f.restartMember.mock.calls).toEqual([
      [teamName, 'Alice', undefined, f.failedSelections.Alice],
      [teamName, 'Bob', undefined, f.failedSelections.Bob],
    ]);
  }
);

for (const timing of ['before', 'between'] as const) {
  it.each([
    'logical-runtime',
    'logical-progress',
    'physical-runtime',
    'physical-progress',
    'logical-epoch',
    'physical-epoch',
    'logical-ignored-runtime',
    'logical-ignored-progress',
    'physical-ignored-runtime',
    'physical-ignored-progress',
    'context',
  ] as const)(
    'refuses project retry after %s changes ' + timing + ' member actions',
    async (change) => {
      const f = projectFixture();
      const revoke = () => {
        const logical = f.provisioningTeamName;
        if (change === 'logical-runtime')
          f.state.currentRuntimeRunIdByTeam[logical] = 'new-project-run';
        if (change === 'logical-progress')
          f.state.currentProvisioningRunIdByTeam[logical] = 'new-project-run';
        if (change === 'physical-runtime')
          f.state.currentRuntimeRunIdByTeam[teamName] = 'new-runtime';
        if (change === 'physical-progress')
          f.state.currentProvisioningRunIdByTeam[teamName] = 'pending:new-attempt';
        if (change === 'logical-epoch') invalidateTeamLocalStateEpoch(logical);
        if (change === 'physical-epoch') invalidateTeamLocalStateEpoch(teamName);
        if (change === 'logical-ignored-runtime') f.state.ignoredRuntimeRunIds[runId] = logical;
        if (change === 'logical-ignored-progress')
          f.state.ignoredProvisioningRunIds[runId] = logical;
        if (change === 'physical-ignored-runtime') f.state.ignoredRuntimeRunIds[runId] = teamName;
        if (change === 'physical-ignored-progress')
          f.state.ignoredProvisioningRunIds[runId] = teamName;
        if (change === 'context') invalidateContextScopedRequestEpoch();
      };
      if (timing === 'before') revoke();
      else f.restartMember.mockImplementationOnce(async () => revoke());
      await expect(f.retry()).rejects.toThrow('Team launch changed');
      expect(f.restartMember.mock.calls).toEqual(
        timing === 'before' ? [] : [[teamName, 'Alice', undefined, f.failedSelections.Alice]]
      );
    }
  );
}

it('keeps an admitted project batch bound to its original target after navigation alone', async () => {
  const f = projectFixture();
  const navigation = { selectedTeamName: teamName };
  const retry = createHostFailedMemberRetry({
    teamName,
    provisioningTeamName: f.provisioningTeamName,
    runId,
    contextId: 'local',
    memberNames: f.names,
    failedSelections: f.failedSelections,
    getState: () => ({ ...f.state, ...navigation }),
    restartMember: f.restartMember,
  });
  f.restartMember.mockImplementationOnce(async () => {
    navigation.selectedTeamName = hostTeamSelectionKey('TEST-project-b');
  });
  await expect(retry()).resolves.toEqual({ kind: 'host', attempted: ['Alice', 'Bob'] });
  expect(f.restartMember.mock.calls.map((call) => call[0])).toEqual([teamName, teamName]);
});
