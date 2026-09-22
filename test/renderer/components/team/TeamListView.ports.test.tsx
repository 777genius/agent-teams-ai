import { beforeEach, describe, expect, it, vi } from 'vitest';

const legacyTeams = vi.hoisted(() => ({
  aliveList: vi.fn(),
  deleteDraft: vi.fn(),
  getData: vi.fn(),
  getSavedRequest: vi.fn(),
  replaceMembers: vi.fn(),
  stop: vi.fn(),
}));

import { createTeamListLifecyclePorts } from '@features/team-lifecycle/renderer';
import { createTeamListProvisioningPorts } from '@features/team-provisioning/renderer';
import { createTeamListRosterPorts } from '@features/team-roster-mutations/renderer';
import { createTeamListViewReadPorts } from '@features/team-view-read-model/renderer';
import { executeTeamRelaunch } from '@renderer/components/team/dialogs/teamRelaunchFlow';

describe('shared team renderer feature ports', () => {
  const legacyApi = { teams: legacyTeams };

  beforeEach(() => {
    vi.clearAllMocks();
    legacyTeams.aliveList.mockResolvedValue(['team-alpha']);
    legacyTeams.deleteDraft.mockResolvedValue(undefined);
    legacyTeams.getData.mockResolvedValue({ config: { projectPath: '/tmp/project' }, members: [] });
    legacyTeams.getSavedRequest.mockResolvedValue(null);
    legacyTeams.replaceMembers.mockResolvedValue(undefined);
    legacyTeams.stop.mockResolvedValue(undefined);
  });

  it('adapts every TeamListView legacy read and command behind a narrow feature port', async () => {
    const launchTeam = vi.fn(async () => 'run-team-alpha');
    const lifecycle = createTeamListLifecyclePorts(legacyApi);
    const provisioning = createTeamListProvisioningPorts(legacyApi, { launchTeam });
    const read = createTeamListViewReadPorts(legacyApi);
    const roster = createTeamListRosterPorts(legacyApi);
    const launchRequest = { teamName: 'team-alpha', cwd: '/tmp/project' };
    const replacement = { members: [{ name: 'alice', role: 'Reviewer' }] };

    await expect(lifecycle.listAliveTeams()).resolves.toEqual(['team-alpha']);
    await expect(provisioning.readDraft('team-alpha')).resolves.toBeNull();
    await expect(provisioning.deleteDraft('draft-alpha')).resolves.toBeUndefined();
    await expect(
      read.readTeamData('team-alpha', { includeMemberBranches: false })
    ).resolves.toMatchObject({ config: { projectPath: '/tmp/project' } });
    await expect(lifecycle.stopRunningTeam('team-alpha')).resolves.toBeUndefined();
    await expect(roster.replaceRoster('team-alpha', replacement)).resolves.toBeUndefined();
    await expect(provisioning.launchTeam(launchRequest)).resolves.toBe('run-team-alpha');

    expect(legacyTeams.aliveList).toHaveBeenCalledOnce();
    expect(legacyTeams.getSavedRequest).toHaveBeenCalledWith('team-alpha');
    expect(legacyTeams.deleteDraft).toHaveBeenCalledWith('draft-alpha');
    expect(legacyTeams.getData).toHaveBeenCalledWith('team-alpha', {
      includeMemberBranches: false,
    });
    expect(legacyTeams.stop).toHaveBeenCalledWith('team-alpha');
    expect(legacyTeams.replaceMembers).toHaveBeenCalledWith('team-alpha', replacement);
    expect(launchTeam).toHaveBeenCalledWith(launchRequest);
  });

  it('keeps the existing stop then replace roster then store-owned launch ordering', async () => {
    const calls: string[] = [];
    legacyTeams.stop.mockImplementation(async () => {
      calls.push('stop');
    });
    legacyTeams.replaceMembers.mockImplementation(async () => {
      calls.push('replace');
    });
    const launchTeam = vi.fn(async () => {
      calls.push('launch');
      return 'run-team-alpha';
    });
    const lifecycle = createTeamListLifecyclePorts(legacyApi);
    const provisioning = createTeamListProvisioningPorts(legacyApi, { launchTeam });
    const roster = createTeamListRosterPorts(legacyApi);
    const request = { teamName: 'team-alpha', cwd: '/tmp/project' };
    const members = [{ name: 'alice', role: 'Reviewer' }];

    await executeTeamRelaunch({
      teamName: 'team-alpha',
      isTeamAlive: true,
      request,
      members,
      stopTeam: lifecycle.stopRunningTeam,
      replaceMembers: roster.replaceRoster,
      launchTeam: provisioning.launchTeam,
    });

    expect(calls).toEqual(['stop', 'replace', 'launch']);
    expect(launchTeam).toHaveBeenCalledWith(request);
  });

  it('preserves command rejection without invoking later relaunch stages', async () => {
    legacyTeams.stop.mockRejectedValueOnce(new Error('stop failed'));
    const launchTeam = vi.fn(async () => 'run-team-alpha');
    const lifecycle = createTeamListLifecyclePorts(legacyApi);
    const provisioning = createTeamListProvisioningPorts(legacyApi, { launchTeam });
    const roster = createTeamListRosterPorts(legacyApi);

    await expect(
      executeTeamRelaunch({
        teamName: 'team-alpha',
        isTeamAlive: true,
        request: { teamName: 'team-alpha', cwd: '/tmp/project' },
        members: [],
        stopTeam: lifecycle.stopRunningTeam,
        replaceMembers: roster.replaceRoster,
        launchTeam: provisioning.launchTeam,
      })
    ).rejects.toThrow('stop failed');

    expect(legacyTeams.replaceMembers).not.toHaveBeenCalled();
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('preserves lifecycle, roster, and store-owned launch errors without translation', async () => {
    const stopError = new Error('stop failed');
    const rosterError = new Error('replace failed');
    const launchError = new Error('launch failed');
    const launchTeam = vi.fn(async () => {
      throw launchError;
    });
    const lifecycle = createTeamListLifecyclePorts(legacyApi);
    const provisioning = createTeamListProvisioningPorts(legacyApi, { launchTeam });
    const roster = createTeamListRosterPorts(legacyApi);

    legacyTeams.stop.mockRejectedValueOnce(stopError);
    legacyTeams.replaceMembers.mockRejectedValueOnce(rosterError);

    await expect(lifecycle.stopRunningTeam('team-alpha')).rejects.toBe(stopError);
    await expect(roster.replaceRoster('team-alpha', { members: [] })).rejects.toBe(rosterError);
    await expect(
      provisioning.launchTeam({ teamName: 'team-alpha', cwd: '/tmp/project' })
    ).rejects.toBe(launchError);
  });
});
