import {
  getMemberColorByName,
  getParticipantIdentityColor,
  getParticipantIdentityIndexByName,
  getTeammateParticipantIdentityColor,
  TEAM_LEAD_MEMBER_COLOR_ID,
  TEAMMATE_PARTICIPANT_COLOR_PALETTE,
} from '@shared/constants/memberColors';
import {
  buildTeamMemberColorMap,
  resolveTeamLeadColorName,
  resolveTeamMemberColorName,
} from '@shared/utils/teamMemberColors';
import { describe, expect, it } from 'vitest';

describe('buildTeamMemberColorMap', () => {
  it('assigns the high-contrast palette order to active teammates', () => {
    const members = [{ name: 'alice' }, { name: 'tom' }, { name: 'bob' }, { name: 'atlas' }];

    const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });

    expect(colorMap.get('alice')).toBe('blue');
    expect(colorMap.get('tom')).toBe('saffron');
    expect(colorMap.get('bob')).toBe('turquoise');
    expect(colorMap.get('atlas')).toBe('brick');
  });

  it('does not let the lead consume the teammate palette order', () => {
    const members = [
      { name: 'team-lead', agentType: 'team-lead' as const },
      { name: 'alice' },
      { name: 'tom' },
    ];

    const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });

    expect(colorMap.get('team-lead')).toBe('green');
    expect(colorMap.get('alice')).toBe('blue');
    expect(colorMap.get('tom')).toBe('saffron');
  });

  it('keeps every roster color aligned with its participant avatar slot', () => {
    const members = [
      { name: 'maya', agentType: 'team-lead' as const, color: 'saffron' },
      ...Array.from({ length: TEAMMATE_PARTICIPANT_COLOR_PALETTE.length + 1 }, (_, index) => ({
        name: `member-${index + 1}`,
        color: 'pink',
      })),
    ];

    const colorMap = buildTeamMemberColorMap(members, { preferProvidedColors: false });

    expect(colorMap.get('maya')).toBe(getParticipantIdentityColor(0));
    for (const [index, member] of members.slice(1).entries()) {
      expect(colorMap.get(member.name)).toBe(getTeammateParticipantIdentityColor(index));
    }
    expect(colorMap.get('member-13')).toBe('blue');
  });

  it('uses the same identity index for name-based color fallbacks', () => {
    for (const name of ['maya', 'liam', 'sophia']) {
      expect(getMemberColorByName(name)).toBe(
        getParticipantIdentityColor(getParticipantIdentityIndexByName(name))
      );
    }
  });

  it('resolves standalone lead previews through the same shared roster pipeline', () => {
    expect(resolveTeamLeadColorName()).toBe(
      resolveTeamMemberColorName(
        { name: TEAM_LEAD_MEMBER_COLOR_ID, agentType: 'team-lead' },
        { preferProvidedColors: false }
      )
    );
    expect(resolveTeamLeadColorName()).toBe(getParticipantIdentityColor(0));
    expect(getMemberColorByName('lead')).toBe(getParticipantIdentityColor(0));
  });
});
