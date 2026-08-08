import {
  buildOrderedVisibleTeamGraphOwnerIds,
  buildTeamGraphDefaultLayoutSeed,
} from '@features/agent-graph';
import { describe, expect, it } from 'vitest';

describe('team graph default layout', () => {
  function members(count: number): { name: string; agentId: string }[] {
    return Array.from({ length: count }, (_, index) => ({
      name: `member-${index}`,
      agentId: `agent-${index}`,
    }));
  }

  it('seeds six visible owners into two row-orbit rows', () => {
    const teamMembers = members(6);

    expect(buildTeamGraphDefaultLayoutSeed(teamMembers, teamMembers).assignments).toEqual({
      'agent-0': { ringIndex: 0, sectorIndex: 0 },
      'agent-1': { ringIndex: 0, sectorIndex: 1 },
      'agent-2': { ringIndex: 0, sectorIndex: 2 },
      'agent-3': { ringIndex: 2, sectorIndex: 0 },
      'agent-4': { ringIndex: 2, sectorIndex: 1 },
      'agent-5': { ringIndex: 2, sectorIndex: 2 },
    });
  });

  it('seeds eight visible owners into row-orbit defaults', () => {
    const teamMembers = members(8);

    expect(buildTeamGraphDefaultLayoutSeed(teamMembers, teamMembers).assignments).toEqual({
      'agent-0': { ringIndex: 0, sectorIndex: 0 },
      'agent-1': { ringIndex: 0, sectorIndex: 1 },
      'agent-2': { ringIndex: 0, sectorIndex: 2 },
      'agent-3': { ringIndex: 1, sectorIndex: 0 },
      'agent-4': { ringIndex: 1, sectorIndex: 1 },
      'agent-5': { ringIndex: 2, sectorIndex: 0 },
      'agent-6': { ringIndex: 2, sectorIndex: 1 },
      'agent-7': { ringIndex: 2, sectorIndex: 2 },
    });
  });

  it('seeds twelve visible owners into four row-orbit rows', () => {
    const teamMembers = members(12);

    expect(buildTeamGraphDefaultLayoutSeed(teamMembers, teamMembers).assignments).toEqual({
      'agent-0': { ringIndex: 0, sectorIndex: 0 },
      'agent-1': { ringIndex: 0, sectorIndex: 1 },
      'agent-2': { ringIndex: 0, sectorIndex: 2 },
      'agent-3': { ringIndex: 1, sectorIndex: 0 },
      'agent-4': { ringIndex: 1, sectorIndex: 1 },
      'agent-5': { ringIndex: 1, sectorIndex: 2 },
      'agent-6': { ringIndex: 2, sectorIndex: 0 },
      'agent-7': { ringIndex: 2, sectorIndex: 1 },
      'agent-8': { ringIndex: 2, sectorIndex: 2 },
      'agent-9': { ringIndex: 3, sectorIndex: 0 },
      'agent-10': { ringIndex: 3, sectorIndex: 1 },
      'agent-11': { ringIndex: 3, sectorIndex: 2 },
    });
  });

  it('seeds fourteen visible owners into aligned row-orbit defaults around the lead', () => {
    const teamMembers = members(14);

    expect(buildTeamGraphDefaultLayoutSeed(teamMembers, teamMembers).assignments).toEqual({
      'agent-0': { ringIndex: 0, sectorIndex: 0 },
      'agent-1': { ringIndex: 0, sectorIndex: 1 },
      'agent-2': { ringIndex: 0, sectorIndex: 2 },
      'agent-3': { ringIndex: 1, sectorIndex: 0 },
      'agent-4': { ringIndex: 1, sectorIndex: 1 },
      'agent-5': { ringIndex: 1, sectorIndex: 2 },
      'agent-6': { ringIndex: 2, sectorIndex: 0 },
      'agent-7': { ringIndex: 2, sectorIndex: 1 },
      'agent-8': { ringIndex: 3, sectorIndex: 0 },
      'agent-9': { ringIndex: 3, sectorIndex: 1 },
      'agent-10': { ringIndex: 3, sectorIndex: 2 },
      'agent-11': { ringIndex: 4, sectorIndex: 0 },
      'agent-12': { ringIndex: 4, sectorIndex: 1 },
      'agent-13': { ringIndex: 4, sectorIndex: 2 },
    });
  });

  it('fails closed instead of merging duplicate stable owner identities', () => {
    const duplicateMembers = [
      { name: 'alice', agentId: 'shared-agent' },
      { name: 'bob', agentId: 'shared-agent' },
      { name: 'tom', agentId: 'agent-tom' },
    ];

    expect(buildOrderedVisibleTeamGraphOwnerIds(duplicateMembers)).toEqual([]);
    expect(buildTeamGraphDefaultLayoutSeed(duplicateMembers)).toEqual({
      orderedVisibleOwnerIds: [],
      signature: null,
      assignments: {},
      duplicateStableOwnerIds: ['shared-agent'],
    });
  });
});
