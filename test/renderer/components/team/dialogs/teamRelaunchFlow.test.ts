import { describe, expect, it, vi } from 'vitest';

import { executeTeamRelaunch } from '@renderer/components/team/dialogs/teamRelaunchFlow';

describe('executeTeamRelaunch', () => {
  it('runs stop, replaceMembers, then launch when the team is alive', async () => {
    const calls: string[] = [];
    const stopTeam = vi.fn(async () => {
      calls.push('stop');
    });
    const replaceMembers = vi.fn(async () => {
      calls.push('replace');
    });
    const launchTeam = vi.fn(async () => {
      calls.push('launch');
    });

    await executeTeamRelaunch({
      teamName: 'team-alpha',
      isTeamAlive: true,
      request: {
        teamName: 'team-alpha',
        cwd: '/tmp/project',
      },
      members: [{ name: 'alice', role: 'Reviewer' }],
      stopTeam,
      replaceMembers,
      launchTeam,
    });

    expect(calls).toEqual(['stop', 'replace', 'launch']);
    expect(stopTeam).toHaveBeenCalledWith('team-alpha');
    expect(replaceMembers).toHaveBeenCalledWith('team-alpha', {
      members: [{ name: 'alice', role: 'Reviewer' }],
    });
  });

  it('skips stop when the team is already offline', async () => {
    const calls: string[] = [];
    const stopTeam = vi.fn(async () => {
      calls.push('stop');
    });
    const replaceMembers = vi.fn(async () => {
      calls.push('replace');
    });
    const launchTeam = vi.fn(async () => {
      calls.push('launch');
    });

    await executeTeamRelaunch({
      teamName: 'team-alpha',
      isTeamAlive: false,
      request: {
        teamName: 'team-alpha',
        cwd: '/tmp/project',
      },
      members: [{ name: 'alice', role: 'Reviewer' }],
      stopTeam,
      replaceMembers,
      launchTeam,
    });

    expect(calls).toEqual(['replace', 'launch']);
    expect(stopTeam).not.toHaveBeenCalled();
  });
});
