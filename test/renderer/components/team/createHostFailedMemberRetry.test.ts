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
