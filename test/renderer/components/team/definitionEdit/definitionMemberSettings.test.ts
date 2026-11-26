import { beforeEach, describe, expect, it, vi } from 'vitest';

const teams = vi.hoisted(() => ({ getSavedRequest: vi.fn(), getMemberSettingsTarget: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams } }));

import { loadDefinitionMembers } from '@renderer/components/team/definitionEdit/definitionMemberSettings';

const settings = { role: null, workflow: null, isolation: null, providerId: null,
  providerBackendId: null, model: null, effort: null, fastMode: null, mcpPolicy: null };
const targets = {
  alice: { name: 'alice', agentType: 'developer', agentId: 'a@team', joinedAt: 1, settings },
  bob: { name: 'bob', agentType: 'developer', agentId: 'b@team', joinedAt: 2, settings },
  coordinator: { name: 'coordinator', agentType: 'team-lead', agentId: 'lead@team', joinedAt: 3, settings },
};
beforeEach(() => {
  teams.getSavedRequest.mockReset().mockResolvedValue({ members: [{ name: 'alice' }, { name: 'bob' }] });
  teams.getMemberSettingsTarget.mockReset().mockImplementation(async ({ memberName }: { memberName: keyof typeof targets }) => targets[memberName] ?? null);
});

describe('definition member settings baseline', () => {
  it('retains the actual lead and every saved member identity', async () => {
    const members = await loadDefinitionMembers('builders', 'alice', 'coordinator');
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'coordinator', agentId: 'lead@team' }),
      expect.objectContaining({ name: 'alice', agentId: 'a@team' }),
      expect.objectContaining({ name: 'bob', agentId: 'b@team' }),
    ]));
  });

  it('refuses an incomplete baseline when another member disappeared', async () => {
    teams.getMemberSettingsTarget.mockImplementation(async ({ memberName }: { memberName: keyof typeof targets }) =>
      memberName === 'bob' ? null : targets[memberName] ?? null);
    await expect(loadDefinitionMembers('builders', 'alice', 'coordinator')).resolves.toBe('member_missing');
  });
});
