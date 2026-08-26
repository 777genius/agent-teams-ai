import {
  executeTeamRelaunch,
  TeamRelaunchKnownPreDispatchFailure,
} from '@renderer/components/team/dialogs/teamRelaunchFlow';
import { describe, expect, it, vi } from 'vitest';

describe('executeTeamRelaunch', () => {
  it('runs stop, replaceMembers, then launch when the team is alive', async () => {
    const calls: string[] = [];
    const stopTeam = vi.fn(async () => {
      calls.push('stop');
      return { status: 'stopped' as const };
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
      return { status: 'stopped' as const };
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
      return { status: 'stopped' as const };
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

  it('keeps a transaction-applied relaunch roster inside the snapshot fence', async () => {
    const calls: string[] = [];
    const replaceMembers = vi.fn();
    await executeTeamRelaunch({
      teamName: 'team-alpha',
      isTeamAlive: true,
      request: {
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        rosterTransactionId: '11111111-1111-4111-8111-111111111111',
      },
      members: [{ name: 'target' }],
      stopTeam: async () => {
        calls.push('stop');
        return { status: 'stopped' };
      },
      replaceMembers,
      launchTeam: async () => {
        calls.push('launch');
      },
    });
    expect(calls).toEqual(['stop', 'launch']);
    expect(replaceMembers).not.toHaveBeenCalled();
  });

  it('reports a deterministic stop rejection as a known pre-dispatch failure', async () => {
    const replaceMembers = vi.fn();
    const launchTeam = vi.fn();
    const relaunch = executeTeamRelaunch({
      teamName: 'team-alpha',
      isTeamAlive: true,
      request: {
        teamName: 'team-alpha',
        cwd: '/tmp/project',
        rosterTransactionId: '11111111-1111-4111-8111-111111111111',
      },
      members: [{ name: 'target' }],
      stopTeam: async () => ({
        status: 'not-dispatched',
        reason: 'validation-rejected',
        diagnostic: 'invalid team name',
      }),
      replaceMembers,
      launchTeam,
    });

    await expect(relaunch).rejects.toMatchObject({
      name: 'TeamRelaunchKnownPreDispatchFailure',
      kind: 'stop-rejected',
    });
    expect(replaceMembers).not.toHaveBeenCalled();
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('reports an abort before stop as a known pre-dispatch failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('dialog closed'));
    const stopTeam = vi.fn();
    const launchTeam = vi.fn();

    await expect(
      executeTeamRelaunch({
        teamName: 'team-alpha',
        isTeamAlive: true,
        request: { teamName: 'team-alpha', cwd: '/tmp/project' },
        members: [{ name: 'target' }],
        stopTeam,
        replaceMembers: vi.fn(),
        launchTeam,
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(TeamRelaunchKnownPreDispatchFailure);
    expect(stopTeam).not.toHaveBeenCalled();
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('preserves an unknown stop transport outcome without claiming no dispatch', async () => {
    const launchTeam = vi.fn();

    await expect(
      executeTeamRelaunch({
        teamName: 'team-alpha',
        isTeamAlive: true,
        request: { teamName: 'team-alpha', cwd: '/tmp/project' },
        members: [{ name: 'target' }],
        stopTeam: async () => ({
          status: 'outcome-unknown',
          reason: 'transport-failure',
          diagnostic: 'stop response lost',
        }),
        replaceMembers: vi.fn(),
        launchTeam,
      })
    ).rejects.toMatchObject({
      name: 'TeamRelaunchStopOutcomeUnknownError',
      outcome: { status: 'outcome-unknown', reason: 'transport-failure' },
    });
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('treats an untyped stop rejection as unknown regardless of its message', async () => {
    const transportError = new Error('validation rejected before dispatch');

    await expect(
      executeTeamRelaunch({
        teamName: 'team-alpha',
        isTeamAlive: true,
        request: { teamName: 'team-alpha', cwd: '/tmp/project' },
        members: [{ name: 'target' }],
        stopTeam: async () => Promise.reject(transportError),
        replaceMembers: vi.fn(),
        launchTeam: vi.fn(),
      })
    ).rejects.toMatchObject({
      name: 'TeamRelaunchStopOutcomeUnknownError',
      cause: transportError,
    });
  });

  it('does not reclassify a launch rejection after stop succeeds as pre-dispatch', async () => {
    const launchError = new Error('launch known not started');

    await expect(
      executeTeamRelaunch({
        teamName: 'team-alpha',
        isTeamAlive: true,
        request: {
          teamName: 'team-alpha',
          cwd: '/tmp/project',
          rosterTransactionId: '11111111-1111-4111-8111-111111111111',
        },
        members: [{ name: 'target' }],
        stopTeam: async () => ({ status: 'stopped' }),
        replaceMembers: vi.fn(),
        launchTeam: async () => {
          throw launchError;
        },
      })
    ).rejects.toBe(launchError);
  });
});
