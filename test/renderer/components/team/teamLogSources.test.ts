import {
  buildSelectableLogMembers,
  formatMemberLogSourceDescription,
  formatMemberLogSourceLabel,
  getMemberNameFromLogSourceKey,
  memberLogSourceKey,
  resolveLeadLogMember,
} from '@renderer/components/team/teamLogSources';
import { describe, expect, it } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

function member(
  name: string,
  overrides: Partial<ResolvedTeamMember> = {}
): ResolvedTeamMember {
  return {
    name,
    status: 'active',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    ...overrides,
  };
}

describe('team log source helpers', () => {
  it('builds teammate sources without lead, user, blank names, or duplicate removed entries', () => {
    const sources = buildSelectableLogMembers([
      member('team-lead', { agentType: 'team-lead' }),
      member('user'),
      member('   '),
      member('Builder', { removedAt: 1715000000000 }),
      member('Reviewer'),
      member('builder'),
    ]);

    expect(sources.map((source) => source.name)).toEqual(['builder', 'Reviewer']);
    expect(sources[0]?.removedAt).toBeUndefined();
  });

  it('keeps first active duplicate source and preserves original ordering slot', () => {
    const sources = buildSelectableLogMembers([
      member('Zed'),
      member('alpha', { removedAt: 1715000000000 }),
      member('Beta'),
      member('ALPHA'),
      member('alpha-late'),
    ]);

    expect(sources.map((source) => source.name)).toEqual(['Zed', 'ALPHA', 'Beta', 'alpha-late']);
  });

  it('resolves active lead before removed lead and falls back safely when roster has no lead', () => {
    expect(
      resolveLeadLogMember([
        member('team-lead', { agentType: 'team-lead', removedAt: 1715000000000 }),
        member('captain', { agentType: 'orchestrator' }),
      ]).name
    ).toBe('captain');

    const fallback = resolveLeadLogMember([member('Builder')]);
    expect(fallback.name).toBe('team-lead');
    expect(fallback.agentType).toBe('team-lead');
  });

  it('formats source labels, descriptions, and stable member source keys', () => {
    const removed = member('Builder', { removedAt: 1715000000000 });
    const developer = member('Reviewer', { role: 'reviewer' });
    const lead = member('lead-alias', { agentType: 'lead' });

    expect(formatMemberLogSourceLabel(removed)).toBe('Builder (removed)');
    expect(formatMemberLogSourceDescription(removed)).toBe('Removed');
    expect(formatMemberLogSourceDescription(developer)).toBe('Reviewer');
    expect(formatMemberLogSourceDescription(lead)).toBe('Team Lead');
    expect(getMemberNameFromLogSourceKey(memberLogSourceKey('name:with:colon'))).toBe(
      'name:with:colon'
    );
  });
});
