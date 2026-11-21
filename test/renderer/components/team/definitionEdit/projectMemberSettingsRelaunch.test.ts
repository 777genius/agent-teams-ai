import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(), validate: vi.fn(), processAlive: vi.fn(), stop: vi.fn(), update: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { teams: {
  processAlive: mocks.processAlive, stop: mocks.stop, updateMemberSettings: mocks.update,
} } }));
vi.mock('@renderer/components/team/definitionEdit/definitionMemberSettings', () => ({ loadDefinitionMembers: mocks.load }));
vi.mock('@features/team-provisioning/renderer', () => ({ assertMemberSettingsRelaunchRoster: mocks.validate, isCanonicalSettingsLead: () => false }));

import type { ReplaceMembersRequest } from '@shared/types';

import { executeProjectMemberSettingsRelaunch } from '@renderer/components/team/definitionEdit/projectMemberSettingsRelaunch';

const draft = { teamName: 'builders', memberName: 'alice', targetKind: 'member',
  expectedFingerprint: 'member-fingerprint', expectedTeamSettingsFingerprint: 'team-fingerprint',
  settings: { role: 'developer', workflow: null, isolation: null, providerId: null,
    providerBackendId: null, model: 'new', effort: null, fastMode: null, mcpPolicy: null } } as const;
const intent: NonNullable<ReplaceMembersRequest['memberSettingsRelaunch']> = { memberName: 'alice', targetKind: 'member', expectedFingerprint: 'member-fingerprint',
  expectedTeamSettingsFingerprint: 'team-fingerprint', baseline: [
    { memberName: 'alice', expectedFingerprint: 'member-fingerprint' },
  ], model: 'new', effort: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validate.mockReset();
  mocks.load.mockResolvedValue([{ name: 'alice' }]);
  mocks.processAlive.mockResolvedValue(true);
  mocks.stop.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue({ outcome: 'completed', effect: 'persisted_only' });
});

describe('confirmed project member settings relaunch', () => {
  it('stops the logical team, commits the guarded intent, then launches', async () => {
    const order: string[] = [];
    mocks.stop.mockImplementation(async () => { order.push('stop'); });
    mocks.update.mockImplementation(async () => { order.push('save'); return { outcome: 'completed', effect: 'persisted_only' }; });
    const launch = vi.fn(async () => { order.push('launch'); });
    await executeProjectMemberSettingsRelaunch({ logicalTeamName: 'builders', baseline: [{ name: 'alice' }] as never,
      draft, intent, commandId: 'stable-command', request: { teamName: 'builders' } as never, launch });
    expect(order).toEqual(['stop', 'save', 'launch']);
    expect(mocks.stop).toHaveBeenCalledWith('builders');
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'stable-command', idempotencyKey: 'stable-command', teamName: 'builders',
      relaunchGuard: { expectedTeamSettingsFingerprint: 'team-fingerprint', baseline: intent.baseline },
    }));
  });

  it('replays the committed command when launch failed, without rejecting its now-changed baseline', async () => {
    const launch = vi.fn().mockRejectedValueOnce(new Error('launch failed')).mockResolvedValueOnce(undefined);
    const input = { logicalTeamName: 'builders', baseline: [{ name: 'alice' }] as never,
      draft, intent, commandId: 'stable-command', request: { teamName: 'builders' } as never, launch };
    await expect(executeProjectMemberSettingsRelaunch(input)).rejects.toThrow('launch failed');
    mocks.validate.mockImplementationOnce(() => { throw new Error('stale after save'); });
    await expect(executeProjectMemberSettingsRelaunch({ ...input, alreadyCommitted: true })).resolves.toBeUndefined();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls[1][0]).toMatchObject({ commandId: 'stable-command' });
  });

  it('never launches when the definition changed or the guarded save is refused', async () => {
    const launch = vi.fn(async () => undefined);
    mocks.validate.mockImplementationOnce(() => { throw new Error('roster changed'); });
    const input = { logicalTeamName: 'builders', baseline: [{ name: 'alice' }] as never,
      draft, intent, commandId: 'stable-command', request: { teamName: 'builders' } as never, launch };
    await expect(executeProjectMemberSettingsRelaunch(input)).rejects.toThrow('roster changed');
    expect(mocks.stop).not.toHaveBeenCalled();
    mocks.update.mockResolvedValueOnce({ outcome: 'refused', reason: 'project_running' });
    await expect(executeProjectMemberSettingsRelaunch(input)).rejects.toThrow(/Could not safely save/);
    expect(launch).not.toHaveBeenCalled();
  });
});
