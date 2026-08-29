import { describe, expect, it, vi } from 'vitest';

import { TEAM_STOP_FOR_RELAUNCH } from '../../src/preload/constants/ipcChannels';
import { createTeamRelaunchStopBridge } from '../../src/preload/teamRelaunchStopBridge';

describe('team relaunch stop preload bridge', () => {
  it.each([
    { status: 'stopped' as const },
    {
      status: 'not-dispatched' as const,
      reason: 'validation-rejected' as const,
      diagnostic: 'invalid team name',
    },
    {
      status: 'outcome-unknown' as const,
      reason: 'stop-operation-failed' as const,
      diagnostic: 'process crashed after dispatch',
    },
  ])('preserves the typed main-process outcome %#', async (outcome) => {
    const invoke = vi.fn(async () => outcome);

    await expect(createTeamRelaunchStopBridge(invoke)('team-alpha')).resolves.toEqual(outcome);
    expect(invoke).toHaveBeenCalledWith(TEAM_STOP_FOR_RELAUNCH, 'team-alpha');
  });

  it('returns unknown when transport rejects before main dispatch can be observed', async () => {
    const transportError = new Error('renderer destroyed');
    const invoke = vi.fn(async () => Promise.reject(transportError));

    await expect(createTeamRelaunchStopBridge(invoke)('team-alpha')).resolves.toEqual({
      status: 'outcome-unknown',
      reason: 'transport-failure',
      diagnostic: `Relaunch stop IPC failed without an authoritative response: ${transportError.message}`,
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('returns unknown when the IPC response times out', async () => {
    const invoke = vi.fn(async () => Promise.reject(new Error('IPC response timed out')));

    await expect(createTeamRelaunchStopBridge(invoke)('team-alpha')).resolves.toMatchObject({
      status: 'outcome-unknown',
      reason: 'transport-failure',
      diagnostic: expect.stringContaining('timed out'),
    });
  });

  it('returns the same unknown outcome when the stop dispatched but its response was lost', async () => {
    const dispatchedStop = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => {
      await dispatchedStop();
      throw new Error('reply port closed');
    });

    await expect(createTeamRelaunchStopBridge(invoke)('team-alpha')).resolves.toEqual({
      status: 'outcome-unknown',
      reason: 'transport-failure',
      diagnostic: 'Relaunch stop IPC failed without an authoritative response: reply port closed',
    });
    expect(dispatchedStop).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([
    { success: false, error: 'not the contract' },
    { status: 'not-dispatched', diagnostic: 'missing authoritative reason' },
  ])(
    'treats malformed response %# as unknown instead of guessing dispatch state',
    async (value) => {
      const invoke = vi.fn(async () => value);

      await expect(createTeamRelaunchStopBridge(invoke)('team-alpha')).resolves.toMatchObject({
        status: 'outcome-unknown',
        reason: 'malformed-response',
      });
    }
  );
});
