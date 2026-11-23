import { describe, expect, it, vi } from 'vitest';

import { preflightRosterMutation } from '../../../../src/main/ipc/teams/teamRosterMutationPreflight';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

function mixedTeam(
  members: { name: string; providerId?: 'codex' | 'opencode'; role?: string }[] = [
    { name: 'alice', providerId: 'opencode' },
  ]
) {
  const listProcesses = vi.fn(async () => []);
  const writeMembers = vi.fn();
  const service = new TeamDataService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getMembers: async () => members, writeMembers } as never,
    {} as never,
    (() => ({ processes: { listProcesses } })) as never,
    {} as never,
    { getMeta: async () => ({ providerId: 'codex' }) } as never
  );
  return { service, listProcesses, writeMembers };
}

describe('live preflight uses confirmed runtime liveness', () => {
  it('admits adding a side lane when unchanged primary members inherit their runtime settings', async () => {
    const w = mixedTeam([{ name: 'primary' }, { name: 'alice', providerId: 'opencode' }]);
    vi.spyOn(w.service, 'getTeamData').mockResolvedValue({
      members: [
        { name: 'team-lead', providerId: 'codex' },
        {
          name: 'primary',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'runtime-model',
          effort: 'high',
          selectedFastMode: 'on',
          configuredRuntimeSettings: {},
        },
        {
          name: 'alice',
          providerId: 'opencode',
          configuredRuntimeSettings: { providerId: 'opencode' },
        },
      ],
    } as never);
    await expect(
      preflightRosterMutation(w.service, 'preflight-test', 'add', {
        name: 'bob',
        providerId: 'opencode',
      })
    ).resolves.toBeUndefined();
    expect(w.writeMembers).not.toHaveBeenCalled();
  });

  it('allows a deferred primary role edit but still refuses the same live replacement', async () => {
    const members = [
      { name: 'primary', providerId: 'codex' as const, role: 'Old role' },
      { name: 'alice', providerId: 'opencode' as const },
    ];
    const w = mixedTeam(members);
    vi.spyOn(w.service, 'getTeamData').mockResolvedValue({
      members: [{ name: 'team-lead', providerId: 'codex' }, ...members],
    } as never);
    await expect(
      preflightRosterMutation(w.service, 'preflight-test', 'role', 'primary', 'New role')
    ).resolves.toBeUndefined();
    await expect(
      preflightRosterMutation(w.service, 'preflight-test', 'replace', {
        members: [{ ...members[0], role: 'New role' }, members[1]],
      })
    ).rejects.toMatchObject({ code: 'RESTART_REQUIRED' });
    expect(w.writeMembers).not.toHaveBeenCalled();
  });

  it('rejects a mixed primary add even when the process catalog is empty', async () => {
    const w = mixedTeam();
    await expect(
      w.service.assertRosterMutationAllowed(
        'preflight-test',
        [
          { name: 'alice', providerId: 'opencode' },
          { name: 'bob', providerId: 'codex' },
        ],
        true
      )
    ).rejects.toMatchObject({ code: 'RESTART_REQUIRED' });
    expect(w.listProcesses).not.toHaveBeenCalled();
    expect(w.writeMembers).not.toHaveBeenCalled();
  });

  it('allows a supported mixed side-lane add without a write', async () => {
    const w = mixedTeam();
    await expect(
      w.service.assertRosterMutationAllowed(
        'preflight-test',
        [
          { name: 'alice', providerId: 'opencode' },
          { name: 'bob', providerId: 'opencode' },
        ],
        true
      )
    ).resolves.toBeUndefined();
    expect(w.listProcesses).not.toHaveBeenCalled();
    expect(w.writeMembers).not.toHaveBeenCalled();
  });
});
