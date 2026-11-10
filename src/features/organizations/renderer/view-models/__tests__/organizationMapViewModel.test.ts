import { describe, expect, it } from 'vitest';

import { buildOrganizationMapViewModel } from '../organizationMapViewModel';

import type { OrganizationMapPayload } from '../../../contracts';

describe('organization map overview summaries', () => {
  it('aggregates organization health, tasks, agents, and largest groups', () => {
    const payload: OrganizationMapPayload = {
      scope: 'all',
      organizations: [{ id: 'product', name: 'Product', rootNodeId: 'org:product' }],
      activeOrganizationId: 'product',
      rootNodeId: 'org:product',
      nodes: [
        { id: 'org:product', kind: 'organization', label: 'Product', color: '#38bdf8' },
        { id: 'group:platform', kind: 'container', label: 'Platform' },
        { id: 'group:runtime', kind: 'container', label: 'Runtime systems' },
        { id: 'group:ops', kind: 'container', label: 'Operations' },
        {
          id: 'team:runtime',
          kind: 'team',
          label: 'Runtime',
          team: {
            teamName: 'runtime',
            displayName: 'Runtime',
            isOnline: true,
            memberCount: 5,
            taskCounts: { pending: 2, inProgress: 3, completed: 4 },
            agents: [],
          },
        },
        {
          id: 'team:support',
          kind: 'team',
          label: 'Support',
          team: {
            teamName: 'support',
            displayName: 'Support',
            isOnline: false,
            memberCount: 2,
            taskCounts: { pending: 1, inProgress: 0, completed: 1 },
            agents: [],
          },
        },
      ],
      relations: [
        {
          id: 'r1',
          sourceNodeId: 'org:product',
          targetNodeId: 'group:platform',
          kind: 'contains',
          sourceKind: 'manual',
          weight: 1,
        },
        {
          id: 'r2',
          sourceNodeId: 'org:product',
          targetNodeId: 'group:ops',
          kind: 'contains',
          sourceKind: 'manual',
          weight: 1,
        },
        {
          id: 'r3',
          sourceNodeId: 'group:platform',
          targetNodeId: 'group:runtime',
          kind: 'contains',
          sourceKind: 'manual',
          weight: 1,
        },
        {
          id: 'r4',
          sourceNodeId: 'group:runtime',
          targetNodeId: 'team:runtime',
          kind: 'contains',
          sourceKind: 'manual',
          weight: 1,
        },
        {
          id: 'r5',
          sourceNodeId: 'group:ops',
          targetNodeId: 'team:support',
          kind: 'contains',
          sourceKind: 'manual',
          weight: 1,
        },
      ],
      degraded: false,
      diagnostics: {
        totalTeams: 2,
        renderedTeams: 2,
        totalCrossTeamMessages: 0,
        renderedCrossTeamRelations: 0,
        truncatedTeams: 0,
        truncatedCrossTeamMessages: 0,
        generatedAt: '2026-07-16T00:00:00.000Z',
      },
    };

    const [summary] = buildOrganizationMapViewModel(payload).organizationOverviews;

    expect(summary).toMatchObject({
      organizationId: 'product',
      groupCount: 3,
      teamCount: 2,
      onlineTeamCount: 1,
      agentCount: 7,
      activeTaskCount: 3,
      taskCount: 11,
      attentionCount: 1,
      healthPercent: 50,
    });
    expect(summary?.largestGroups.map((group) => group.label)).toEqual(['Operations', 'Platform']);
  });
});
