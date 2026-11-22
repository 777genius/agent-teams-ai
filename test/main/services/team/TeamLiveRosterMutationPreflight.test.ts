import { describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

function mixedTeam() {
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
    { getMembers: async () => [{ name: 'alice', providerId: 'opencode' }], writeMembers } as never,
    {} as never,
    (() => ({ processes: { listProcesses } })) as never,
    {} as never,
    { getMeta: async () => ({ providerId: 'codex' }) } as never
  );
  return { service, listProcesses, writeMembers };
}

describe('live preflight uses confirmed runtime liveness', () => {
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
