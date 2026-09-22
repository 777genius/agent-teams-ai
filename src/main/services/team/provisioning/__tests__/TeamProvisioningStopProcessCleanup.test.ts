import { describe, expect, it } from 'vitest';

import {
  getPersistedPaneMemberKillTargets,
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
    expect(
      [...selectOrphanedTeamAgentPids([{ pid: 10, command: 'node worker --team-name "alpha team" --agent-id dev' }], 'alpha team')]
    ).toEqual([10]);
  });
});
