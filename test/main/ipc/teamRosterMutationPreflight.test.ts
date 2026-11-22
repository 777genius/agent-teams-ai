import { describe, expect, it, vi } from 'vitest';

import {
  parseRosterMutationMembers,
  preflightRosterMutation,
} from '../../../src/main/ipc/teams/teamRosterMutationPreflight';

import type { RuntimeRosterMutationMember } from '../../../src/main/ipc/teams/runtimeRosterMutationMember';

function ports(members: RuntimeRosterMutationMember[]) {
  return {
    getTeamData: vi.fn(async () => ({ members }) as never),
    assertRosterMutationAllowed: vi.fn(async () => undefined),
  };
}

describe('read-only roster mutation preflight', () => {
  it('rejects moving an OpenCode member to the primary owner before mixed validation', async () => {
    const data = ports([
      { name: 'team-lead', providerId: 'codex' },
      { name: 'alice', providerId: 'opencode' },
    ]);
    await expect(
      preflightRosterMutation(data, 'ptc-a', 'replace', {
        members: [{ name: 'alice', providerId: 'codex' }],
      })
    ).rejects.toMatchObject({ code: 'RESTART_REQUIRED' });
    expect(data.assertRosterMutationAllowed).not.toHaveBeenCalled();
  });

  it('validates add/remove/restore against the requested active roster', async () => {
    const alice = { name: 'alice', providerId: 'opencode' as const, role: 'Reviewer' };
    const removed = { name: 'bob', providerId: 'opencode' as const, removedAt: 123 };
    const data = ports([{ name: 'team-lead', providerId: 'codex' }, alice, removed]);
    await preflightRosterMutation(data, 'ptc-a', 'add', { name: 'carol', providerId: 'opencode' });
    expect(data.assertRosterMutationAllowed).toHaveBeenLastCalledWith(
      'ptc-a',
      [alice, expect.objectContaining({ name: 'carol' })],
      true
    );
    await preflightRosterMutation(data, 'ptc-a', 'remove', 'alice');
    expect(data.assertRosterMutationAllowed).toHaveBeenLastCalledWith('ptc-a', [], true);
    await preflightRosterMutation(data, 'ptc-a', 'restore', 'bob');
    expect(data.assertRosterMutationAllowed).toHaveBeenLastCalledWith(
      'ptc-a',
      [alice, { ...removed, removedAt: undefined }],
      true
    );
    expect(removed.removedAt).toBe(123);
  });

  it('preserves the deferred role setter without claiming a live OpenCode replacement', async () => {
    const alice = { name: 'alice', providerId: 'opencode' as const, role: 'Old role' };
    const data = ports([{ name: 'team-lead', providerId: 'opencode' }, alice]);
    await preflightRosterMutation(data, 'ptc-a', 'role', 'alice', ' New role ');
    expect(data.assertRosterMutationAllowed).toHaveBeenCalledWith(
      'ptc-a',
      [{ ...alice, role: 'New role' }],
      true
    );
    expect(alice.role).toBe('Old role');
  });

  it.each([
    ['add', { name: 'alice' }],
    ['remove', 'missing'],
    ['restore', 'alice'],
    ['role', 'alice', 42],
  ])('refuses invalid %s before runtime capability admission', async (operation, ...args) => {
    const data = ports([{ name: 'team-lead', providerId: 'codex' }, { name: 'alice' }]);
    await expect(
      preflightRosterMutation(
        data,
        'ptc-a',
        operation as 'add' | 'remove' | 'restore' | 'role',
        ...args
      )
    ).rejects.toThrow();
    expect(data.assertRosterMutationAllowed).not.toHaveBeenCalled();
  });

  it('rejects sparse IPC rosters before capability admission', async () => {
    const data = ports([{ name: 'team-lead', providerId: 'codex' }]);
    await expect(
      preflightRosterMutation(data, 'ptc-a', 'replace', { members: Array(1) })
    ).rejects.toThrow('member must be object');
    expect(data.assertRosterMutationAllowed).not.toHaveBeenCalled();
  });

  it('normalizes blank authored fields like native persistence', async () => {
    const data = ports([{ name: 'team-lead', providerId: 'codex' }]);
    await preflightRosterMutation(data, 'ptc-a', 'replace', {
      members: [{ name: 'alice', role: ' ', workflow: '' }],
    });
    expect(data.assertRosterMutationAllowed).toHaveBeenCalledWith(
      'ptc-a',
      [expect.objectContaining({ name: 'alice', role: undefined, workflow: undefined })],
      true
    );
  });

  it('rejects case-folded duplicates and runtime-managed names in the shared parser', () => {
    expect(() => parseRosterMutationMembers([{ name: 'alice' }, { name: 'ALICE' }])).toThrow();
    expect(() => parseRosterMutationMembers([{ name: 'alice-2' }])).toThrow(/runtime-managed/);
  });
});
