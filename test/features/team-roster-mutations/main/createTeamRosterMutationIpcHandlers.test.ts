import { createTeamRosterMutationIpcHandlers } from '@features/team-roster-mutations/main/adapters/input/ipc/createTeamRosterMutationIpcHandlers';
import { describe, expect, it, vi } from 'vitest';

import type { TeamRosterMutationFeature } from '@features/team-roster-mutations/main';

vi.mock('@features/team-configuration', () => ({
  parseOptionalMemberEffort: (value: unknown) => ({ valid: true, value }),
  parseOptionalMemberProviderId: (value: unknown) => ({ valid: true, value }),
  parseOptionalProviderBackendId: (value: unknown) => ({ valid: true, value }),
  parseOptionalTeamFastMode: (value: unknown) => ({ valid: true, value }),
}));
vi.mock('@main/ipc/guards', () => ({
  validateMemberName: (value: unknown) => ({ valid: true, value }),
  validateTeammateName: (value: unknown) =>
    typeof value === 'string' && value.trim()
      ? { valid: true, value: value.trim() }
      : { valid: false, error: 'Invalid member name' },
  validateTeamName: (value: unknown) => ({ valid: true, value }),
}));

function feature() {
  const replaceMembers = vi.fn(() => Promise.resolve());
  const replaceMembersWithSettingsRelaunch = vi.fn(() => Promise.resolve());
  return {
    replaceMembers,
    replaceMembersWithSettingsRelaunch,
    handlers: createTeamRosterMutationIpcHandlers({
      replaceMembers: { execute: replaceMembers },
      replaceMembersWithSettingsRelaunch,
      logger: { error: vi.fn() },
    } as unknown as TeamRosterMutationFeature),
  };
}

describe('createTeamRosterMutationIpcHandlers', () => {
  it('preserves settings relaunch fingerprints through the activated roster handler', async () => {
    const harness = feature();
    const intent = {
      memberName: 'worker',
      targetKind: 'member',
      expectedFingerprint: 'target-fingerprint',
      expectedTeamSettingsFingerprint: 'team-fingerprint',
      baseline: [{ memberName: 'worker', expectedFingerprint: 'target-fingerprint' }],
      model: 'gpt-5',
      effort: 'high',
    };

    await expect(
      harness.handlers.replaceMembers({}, 'sandbox-team', {
        members: [{ name: 'worker', providerId: 'codex', model: 'gpt-5' }],
        memberSettingsRelaunch: intent,
      })
    ).resolves.toEqual({ success: true, data: undefined });

    expect(harness.replaceMembersWithSettingsRelaunch).toHaveBeenCalledWith(
      'sandbox-team',
      [expect.objectContaining({ name: 'worker', providerId: 'codex', model: 'gpt-5' })],
      intent
    );
    expect(harness.replaceMembers).not.toHaveBeenCalled();
  });

  it('returns stale-write rejection without falling back to an unguarded roster write', async () => {
    const harness = feature();
    harness.replaceMembersWithSettingsRelaunch.mockRejectedValueOnce(
      new Error('Member settings changed. Reopen member settings.')
    );

    await expect(
      harness.handlers.replaceMembers({}, 'sandbox-team', {
        members: [{ name: 'worker' }],
        memberSettingsRelaunch: {
          memberName: 'worker',
          expectedFingerprint: 'stale-fingerprint',
        },
      })
    ).resolves.toEqual({
      success: false,
      error: 'Member settings changed. Reopen member settings.',
    });

    expect(harness.replaceMembers).not.toHaveBeenCalled();
  });
});
