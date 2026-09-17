import { rosterAvatarUrl } from '@features/team-direct-chats/renderer/hooks/useChatMemberIdentity';
import { getParticipantAvatarUrlByIndex, LEAD_PARTICIPANT_AVATAR_URL } from '@renderer/utils/memberAvatarCatalog';
import { agentAvatarUrl, buildMemberAvatarMap } from '@renderer/utils/memberHelpers';
import { describe, expect, it } from 'vitest';

describe('rosterAvatarUrl', () => {
  const members = [
    { name: 'team-lead', agentType: 'team-lead' },
    { name: 'alice' },
    { name: 'echo' },
  ];
  const avatarMap = buildMemberAvatarMap(members);

  it('uses the same positional roster avatars as the Team member list', () => {
    expect(rosterAvatarUrl('team-lead', avatarMap)).toBe(LEAD_PARTICIPANT_AVATAR_URL);
    expect(rosterAvatarUrl('alice', avatarMap)).toBe(getParticipantAvatarUrlByIndex(1));
    expect(rosterAvatarUrl('echo', avatarMap)).toBe(getParticipantAvatarUrlByIndex(2));
    expect(rosterAvatarUrl('alice', avatarMap)).not.toBe(agentAvatarUrl('alice'));
  });

  it('resolves lead aliases to the reserved lead avatar', () => {
    expect(rosterAvatarUrl('lead', avatarMap)).toBe(LEAD_PARTICIPANT_AVATAR_URL);
    expect(rosterAvatarUrl('team-leader', avatarMap)).toBe(LEAD_PARTICIPANT_AVATAR_URL);
  });
});
