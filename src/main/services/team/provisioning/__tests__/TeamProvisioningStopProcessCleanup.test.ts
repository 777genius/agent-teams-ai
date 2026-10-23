import { describe, expect, it } from 'vitest';

import {
  getPersistedPaneMemberKillTargets,
  resolveOrphanedTeamAgentStopVerdict,
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

describe('resolveOrphanedTeamAgentStopVerdict', () => {
  it('confirms recorded runtime exit when the process table is unreadable', () => {
    expect(
      resolveOrphanedTeamAgentStopVerdict({
        rows: null,
        teamName: 'alpha',
        currentRunPid: 999,
        knownPids: [10, 11],
        isPidAlive: () => false,
      })
    ).toEqual({ verdict: { confirmed: true }, targetPids: [] });
  });

  it('targets live recorded processes when the process table is unreadable', () => {
    expect(
      resolveOrphanedTeamAgentStopVerdict({
        rows: null,
        teamName: 'alpha',
        knownPids: [10, 11],
        isPidAlive: (pid) => pid === 11,
      })
    ).toEqual({
      verdict: { confirmed: false, reason: 'live_agent_processes' },
      targetPids: [11],
    });
  });

  it('cannot prove exit without a table and without recorded pids', () => {
    expect(
      resolveOrphanedTeamAgentStopVerdict({
        rows: null,
        teamName: 'alpha',
        knownPids: [],
        isPidAlive: () => false,
      })
    ).toEqual({
      verdict: { confirmed: false, reason: 'process_table_unreadable' },
      targetPids: [],
    });
  });

  it('unions discovered orphans with live recorded pids', () => {
    expect(
      resolveOrphanedTeamAgentStopVerdict({
        rows: [
          { pid: 20, command: 'node worker --team-name alpha --agent-id dev' },
          { pid: 21, command: 'node worker --team-name beta --agent-id dev' },
        ],
        teamName: 'alpha',
        knownPids: [30, 31],
        isPidAlive: (pid) => pid === 31,
      })
    ).toEqual({
      verdict: { confirmed: false, reason: 'live_agent_processes' },
      targetPids: [20, 31],
    });
  });
});
