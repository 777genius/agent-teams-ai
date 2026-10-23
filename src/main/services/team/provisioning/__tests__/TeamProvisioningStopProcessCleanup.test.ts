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
    await vi.advanceTimersByTimeAsync(250);
    await expect(confirmed).resolves.toBe(true);
    expect(killPid.mock.calls).toEqual([[41]]);
  });

  it.each(['unknown-table', 'unknown-rows', 'new-team-target', 'changed-group'] as const)(
    'refuses %s without replaying a signal',
    async (variant) => {
      const { pending, readRows, readIdentities, killPid } = prepare();
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
    }
  );

  it('bounds observation when the captured process remains alive', async () => {
    vi.useFakeTimers();
    const { pending, killPid } = prepare();
    const confirmed = pending.confirmStopped();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(confirmed).resolves.toBe(false);
    expect(killPid.mock.calls).toEqual([[41]]);
  });

  it('signals each captured descendant once in deepest-first order and retains a surviving child', async () => {
    vi.useFakeTimers();
    const child = { ...identity, pid: 42, parentPid: 41, startIdentity: 'test:child' };
    const grandchild = { ...identity, pid: 43, parentPid: 42, startIdentity: 'test:grandchild' };
    const table = new Map([
      [41, identity],
      [42, child],
      [43, grandchild],
    ]);
    const readIdentities = vi.fn(() => table);
    const killPid = vi.fn();
    const readRows = vi.fn((): { pid: number; command: string }[] => [
      { pid: 41, command: 'node --team-name TEST-owned --agent-id bob' },
    ]);
    const pending = killOrphanedTeamAgentProcesses(
      { teamName: 'TEST-owned', logger },
      {
        readRows,
        readIdentities,
        killPid,
      }
    );
    if (typeof pending === 'boolean') throw new Error('Expected captured pending stop');
    expect(killPid.mock.calls).toEqual([[43], [42], [41]]);
    readRows.mockReturnValue([]);
    readIdentities.mockReturnValue(new Map([[42, child]]));
    const first = pending.confirmStopped();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toBe(false);
    readIdentities.mockReturnValue(new Map());
    await expect(pending.confirmStopped()).resolves.toBe(true);
    expect(killPid.mock.calls).toEqual([[43], [42], [41]]);
  });

  it('extends an outstanding receipt to a new matching root without replaying old signals', async () => {
    const { pending, readRows, readIdentities, killPid } = prepare();
    const newcomer = { ...identity, pid: 51, startIdentity: 'test:new-root' };
    readRows.mockReturnValue([{ pid: 51, command: 'node --team-name TEST-owned --agent-id new' }]);
    readIdentities.mockReturnValue(new Map([[51, newcomer]]));
    pending.stopNewProcesses(undefined);
    expect(killPid.mock.calls).toEqual([[41], [51]]);
    readRows.mockReturnValue([]);
    readIdentities.mockReturnValue(new Map());
    await expect(pending.confirmStopped()).resolves.toBe(true);
  });

  it.each(['unknown-identity', 'kill-failure'] as const)(
    'retries only unsent identities after %s',
    async (variant) => {
      const rows = [{ pid: 41, command: 'node --team-name TEST-owned --agent-id bob' }];
      const table = new Map([[41, identity]]);
      const readIdentities = vi.fn((): typeof table | null => table);
      if (variant === 'unknown-identity')
        readIdentities.mockReturnValueOnce(table).mockReturnValueOnce(null);
      const killPid = vi.fn();
      if (variant === 'kill-failure')
        killPid.mockImplementationOnce(() => {
          throw new Error('transient');
        });
      const pending = killOrphanedTeamAgentProcesses(
        { teamName: 'TEST-owned', logger },
        { readRows: () => rows, readIdentities, killPid }
      );
      if (typeof pending === 'boolean') throw new Error('Expected retained capture');
      pending.stopNewProcesses(undefined);
      pending.stopNewProcesses(undefined);
      expect(killPid).toHaveBeenCalledTimes(variant === 'kill-failure' ? 2 : 1);
    }
  );

  it('signals a newly discovered child before its previously unsent parent', () => {
    const rows = [{ pid: 41, command: 'node --team-name TEST-owned --agent-id bob' }];
    const readIdentities = vi.fn(() => new Map([[41, identity]]));
    const killPid = vi.fn().mockImplementationOnce(() => {
      throw new Error('transient');
    });
    const pending = killOrphanedTeamAgentProcesses(
      { teamName: 'TEST-owned', logger },
      { readRows: () => rows, readIdentities, killPid }
    );
    if (typeof pending === 'boolean') throw new Error('Expected retained capture');
    const child = { ...identity, pid: 42, parentPid: 41, startIdentity: 'test:new-child' };
    readIdentities.mockReturnValue(
      new Map([
        [41, identity],
        [42, child],
      ])
    );
    pending.stopNewProcesses(undefined);
    expect(killPid.mock.calls).toEqual([[41], [42], [41]]);
    pending.stopNewProcesses(undefined);
    expect(killPid.mock.calls).toEqual([[41], [42], [41]]);
  });

  it('retires a foreign reused birth and still stops an unrelated new matching root', async () => {
    const { pending, readRows, readIdentities, killPid } = prepare();
    const foreign = { ...identity, startIdentity: 'test:foreign' };
    const newcomer = { ...identity, pid: 51, startIdentity: 'test:new' };
    readRows.mockReturnValue([{ pid: 51, command: 'node --team-name TEST-owned --agent-id new' }]);
    readIdentities.mockReturnValue(
      new Map([
        [41, foreign],
        [51, newcomer],
      ])
    );
    pending.stopNewProcesses(undefined);
    expect(killPid.mock.calls).toEqual([[41], [51]]);
    readRows.mockReturnValue([]);
    readIdentities.mockReturnValue(new Map([[41, foreign]]));
    await expect(pending.confirmStopped()).resolves.toBe(true);
  });

  it('refuses an uncaptured matching reused birth until an explicit Stop captures it', async () => {
    const { pending, readIdentities, readRows, killPid } = prepare();
    readIdentities.mockReturnValue(
      new Map([[41, { ...identity, startIdentity: 'test:matching-successor' }]])
    );
    await expect(pending.confirmStopped()).resolves.toBe(false);
    expect(killPid.mock.calls).toEqual([[41]]);
    pending.stopNewProcesses(undefined);
    expect(killPid.mock.calls).toEqual([[41], [41]]);
    readRows.mockReturnValue([]);
    readIdentities.mockReturnValue(new Map());
    await expect(pending.confirmStopped()).resolves.toBe(true);
  });

  it('does not let same-birth group refusal suppress signals to unrelated new roots', async () => {
    const { pending, readRows, readIdentities, killPid } = prepare();
    const newcomer = { ...identity, pid: 51, startIdentity: 'test:new' };
    readRows.mockReturnValue([{ pid: 51, command: 'node --team-name TEST-owned --agent-id new' }]);
    readIdentities.mockReturnValue(
      new Map([
        [41, { ...identity, processGroupId: 99 }],
        [51, newcomer],
      ])
    );
    pending.stopNewProcesses(undefined);
    expect(killPid.mock.calls).toEqual([[41], [51]]);
    await expect(pending.confirmStopped()).resolves.toBe(false);
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
