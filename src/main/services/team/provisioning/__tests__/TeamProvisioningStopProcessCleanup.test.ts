import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPersistedPaneMemberKillTargets,
  killOrphanedTeamAgentProcesses,
  selectOrphanedTeamAgentPids,
} from '../TeamProvisioningStopProcessCleanup';

describe('stop process cleanup helpers', () => {
  it('selects tmux teammate pane kill targets from persisted members', () => {
    expect(
      getPersistedPaneMemberKillTargets([
        { name: 'dev', tmuxPaneId: '%1', backendType: 'tmux' },
        { name: 'team-lead', tmuxPaneId: '%2', backendType: 'tmux' },
        { name: 'qa', tmuxPaneId: '', backendType: 'tmux' },
        { name: 'opencode', tmuxPaneId: '%3', backendType: 'opencode' },
      ])
    ).toEqual([{ name: 'dev', paneId: '%1' }]);
  });

  it('selects orphaned agent process pids for the target team', () => {
    const pids = selectOrphanedTeamAgentPids(
      [
        { pid: 10, command: 'node worker --team-name alpha --agent-id dev' },
        { pid: 11, command: 'node worker --team-name alpha --agent-id qa' },
        { pid: 12, command: 'node worker --team-name beta --agent-id dev' },
        { pid: 13, command: 'node worker --team-name alpha' },
      ],
      'alpha',
      11
    );

    expect([...pids]).toEqual([10]);
  });

  it('handles quoted team-name arguments', () => {
    expect([
      ...selectOrphanedTeamAgentPids(
        [{ pid: 10, command: 'node worker --team-name "alpha team" --agent-id dev' }],
        'alpha team'
      ),
    ]).toEqual([10]);
  });
});

describe.skipIf(process.platform === 'win32')('owned orphan stop confirmation', () => {
  afterEach(() => vi.useRealTimers());
  const identity = { pid: 41, parentPid: 1, processGroupId: 41, startIdentity: 'test:original' };
  const logger = { info: vi.fn(), debug: vi.fn() };
  function prepare() {
    const rows = [{ pid: 41, command: 'node worker --team-name TEST-owned --agent-id bob' }];
    const readRows = vi.fn((): typeof rows | null => rows);
    const readIdentities = vi.fn(
      (): Map<number, typeof identity> | null => new Map([[41, identity]])
    );
    const killPid = vi.fn();
    const pending = killOrphanedTeamAgentProcesses(
      { teamName: 'TEST-owned', logger },
      { readRows, readIdentities, killPid }
    );
    if (typeof pending === 'boolean') throw new Error('Expected captured pending stop');
    return { pending, readRows, readIdentities, killPid };
  }

  it('observes captured live identities becoming absent without another signal', async () => {
    vi.useFakeTimers();
    const { pending, readRows, readIdentities, killPid } = prepare();
    const confirmed = pending.confirmStopped();
    readRows.mockReturnValue([]);
    readIdentities.mockReturnValue(new Map());
    await vi.advanceTimersByTimeAsync(50);
    await expect(confirmed).resolves.toBe(true);
    expect(killPid.mock.calls).toEqual([[41]]);
  });

  it.each([
    'reused-pid',
    'unknown-table',
    'unknown-rows',
    'new-team-target',
    'changed-group',
  ] as const)('refuses %s without replaying a signal', async (variant) => {
    const { pending, readRows, readIdentities, killPid } = prepare();
    if (variant === 'reused-pid')
      readIdentities.mockReturnValue(
        new Map([[41, { ...identity, startIdentity: 'test:successor' }]])
      );
    if (variant === 'unknown-table') readIdentities.mockReturnValue(null);
    if (variant === 'unknown-rows') readRows.mockReturnValue(null);
    if (variant === 'new-team-target')
      readRows.mockReturnValue([
        { pid: 99, command: 'node worker --team-name TEST-owned --agent-id successor' },
      ]);
    if (variant === 'changed-group')
      readIdentities.mockReturnValue(new Map([[41, { ...identity, processGroupId: 99 }]]));
    await expect(pending.confirmStopped()).resolves.toBe(false);
    expect(killPid.mock.calls).toEqual([[41]]);
  });

  it('bounds observation when the captured process remains alive', async () => {
    vi.useFakeTimers();
    const { pending, killPid } = prepare();
    const confirmed = pending.confirmStopped();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(confirmed).resolves.toBe(false);
    expect(killPid.mock.calls).toEqual([[41]]);
  });

  it('never signals a target whose birth identity cannot be captured', () => {
    const killPid = vi.fn();
    expect(
      killOrphanedTeamAgentProcesses(
        { teamName: 'TEST-owned', logger },
        {
          readRows: () => [
            { pid: 41, command: 'node worker --team-name TEST-owned --agent-id bob' },
          ],
          readIdentities: () => null,
          killPid,
        }
      )
    ).toBe(false);
    expect(killPid).not.toHaveBeenCalled();
  });
});
