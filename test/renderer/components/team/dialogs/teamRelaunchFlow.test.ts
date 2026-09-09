import { executeTeamRelaunch } from '@renderer/components/team/dialogs/teamRelaunchFlow';
import { describe, expect, it, vi } from 'vitest';

describe('executeTeamRelaunch', () => {
  it.each([false, true])(
    'refuses a stale target before any side effect (alive=%s)',
    async (isTeamAlive) => {
      const stopTeam = vi.fn();
      const replaceMembers = vi.fn();
      const launchTeam = vi.fn();
      await expect(
        executeTeamRelaunch({
          teamName: 'test-team',
          isTeamAlive,
          request: { teamName: 'test-team', cwd: '/tmp/test-project' },
          members: [],
          validateBeforeReplace: async () => {
            throw new Error('stale target');
          },
          stopTeam,
          replaceMembers,
          launchTeam,
        })
      ).rejects.toThrow('stale target');
      expect(stopTeam).not.toHaveBeenCalled();
      expect(replaceMembers).not.toHaveBeenCalled();
      expect(launchTeam).not.toHaveBeenCalled();
    }
  );

  it('checks again after stop and refuses a target changed during the stop', async () => {
    const validateBeforeReplace = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('stale target'));
    const replaceMembers = vi.fn();
    const launchTeam = vi.fn();
    await expect(
      executeTeamRelaunch({
        teamName: 'test-team',
        isTeamAlive: true,
        request: { teamName: 'test-team', cwd: '/tmp/test-project' },
        members: [],
        validateBeforeReplace,
        stopTeam: vi.fn(),
        replaceMembers,
        launchTeam,
      })
    ).rejects.toThrow('stale target');
    expect(validateBeforeReplace).toHaveBeenCalledTimes(2);
    expect(replaceMembers).not.toHaveBeenCalled();
    expect(launchTeam).not.toHaveBeenCalled();
  });

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

  it('keeps changed relaunch provider and model in the replacement and launch payloads', async () => {
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
    const request = {
      teamName: 'team-alpha',
      cwd: '/tmp/project',
      providerId: 'anthropic' as const,
      model: 'sonnet',
      effort: 'low' as const,
    };
    const members = [
      { name: 'alice', role: 'Reviewer' },
      { name: 'jack', role: 'Builder', providerId: 'anthropic' as const, model: 'sonnet' },
    ];

    await executeTeamRelaunch({
      teamName: 'team-alpha',
      isTeamAlive: true,
      request,
      members,
      stopTeam,
      replaceMembers,
      launchTeam,
    });

    expect(calls).toEqual(['stop', 'replace', 'launch']);
    expect(replaceMembers).toHaveBeenCalledWith('team-alpha', { members });
    expect(launchTeam).toHaveBeenCalledWith(request);
  });
});

it('passes the target guard into persistence and does not launch after a write conflict', async () => {
  const intent = {
    memberName: 'worker',
    targetKind: 'member' as const,
    expectedFingerprint: 'original',
    baseline: [{ memberName: 'worker', expectedFingerprint: 'original' }],
    model: 'glm-5.3-flash',
    effort: null,
  };
  const replaceMembers = vi.fn().mockRejectedValue(new Error('target conflict'));
  const launchTeam = vi.fn();
  await expect(
    executeTeamRelaunch({
      teamName: 'test-team',
      isTeamAlive: true,
      request: { teamName: 'test-team', cwd: '/tmp/test-only' },
      members: [{ name: 'worker', model: intent.model }],
      memberSettingsRelaunch: intent,
      stopTeam: vi.fn(),
      replaceMembers,
      launchTeam,
    })
  ).rejects.toThrow('target conflict');
  expect(replaceMembers).toHaveBeenCalledWith('test-team', {
    members: [{ name: 'worker', model: intent.model }],
    memberSettingsRelaunch: intent,
  });
  expect(launchTeam).not.toHaveBeenCalled();
});
