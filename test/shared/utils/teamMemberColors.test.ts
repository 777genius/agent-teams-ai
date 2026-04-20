import { describe, expect, it } from 'vitest';

import { getMemberColorByName, TEAM_LEAD_MEMBER_COLOR_ID } from '@shared/constants/memberColors';
import {
  buildTeamMemberColorMap,
  resolveTeamLeadColorName,
  resolveTeamMemberColorName,
} from '@shared/utils/teamMemberColors';

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

    expect(colorMap.get('team-lead')).toBeDefined();
    expect(colorMap.get('alice')).toBe('blue');
    expect(colorMap.get('tom')).toBe('saffron');
  });

  it('resolves standalone lead previews through the same shared roster pipeline', () => {
    expect(resolveTeamLeadColorName()).toBe(
      resolveTeamMemberColorName(
        { name: TEAM_LEAD_MEMBER_COLOR_ID, agentType: 'team-lead' },
        { preferProvidedColors: false }
      )
    );
    expect(resolveTeamLeadColorName()).not.toBe(getMemberColorByName('lead'));
  });
});
