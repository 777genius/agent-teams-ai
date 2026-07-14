import { describe, expect, it } from 'vitest';

import {
  buildOrganizationGraphFocusState,
  getOrganizationDescendantNodeIds,
  getOrganizationNodePath,
  searchOrganizationNodes,
} from '../organizationGraphFocus';
import { buildOrganizationMapViewModel } from '../organizationMapViewModel';

import type {
  OrganizationMapPayload,
  OrganizationNodeDto,
  OrganizationRelationDto,
} from '../../../contracts';
import type { GraphDataPort, GraphNode } from '@claude-teams/agent-graph';

function buildTeamNode(
  id: string,
  label: string,
  teamName: string,
  taskSubject?: string
): OrganizationNodeDto {
  return {
    id,
    kind: 'team',
    label,
    team: {
      teamName,
      displayName: label,
      isOnline: true,
      memberCount: 1,
      taskCounts: { pending: 0, inProgress: taskSubject ? 1 : 0, completed: 0 },
      agents: [
        {
          id: `agent:${teamName}`,
          teamName,
          name: `${label} Agent`,
          status: taskSubject ? 'active' : 'idle',
          activeTaskCount: taskSubject ? 1 : 0,
          currentTasks: taskSubject
            ? [{ id: `task:${teamName}`, subject: taskSubject, status: 'in_progress' }]
            : [],
        },
      ],
    },
  };
}

function buildFixture(): {
  viewModel: ReturnType<typeof buildOrganizationMapViewModel>;
  graphData: GraphDataPort;
} {
  const containsRelations: OrganizationRelationDto[] = [
    ['root', 'org:acme'],
    ['org:acme', 'group:platform'],
    ['group:platform', 'team:alpha'],
    ['org:acme', 'group:sales'],
    ['group:sales', 'team:beta'],
    ['org:acme', 'team:gamma'],
  ].map(([sourceNodeId, targetNodeId], index) => ({
    id: `contains:${index}`,
    sourceNodeId: sourceNodeId!,
    targetNodeId: targetNodeId!,
    kind: 'contains',
    sourceKind: 'manual',
    weight: 1,
  }));
  const payload: OrganizationMapPayload = {
    scope: 'all',
    organizations: [{ id: 'acme', name: 'Acme', rootNodeId: 'org:acme' }],
    activeOrganizationId: 'acme',
    rootNodeId: 'root',
    nodes: [
      { id: 'root', kind: 'organization', label: 'All Organizations' },
      { id: 'org:acme', kind: 'organization', label: 'Acme' },
      { id: 'group:platform', kind: 'container', label: 'Platform' },
      buildTeamNode('team:alpha', 'Alpha Runtime', 'alpha', 'Ship authentication flow'),
      { id: 'group:sales', kind: 'container', label: 'Revenue' },
      buildTeamNode('team:beta', 'Beta Growth', 'beta', 'Review campaign'),
      buildTeamNode('team:gamma', 'Gamma Support', 'gamma'),
    ],
    relations: [
      ...containsRelations,
      {
        id: 'message:alpha-beta',
        sourceNodeId: 'team:alpha',
        targetNodeId: 'team:beta',
        kind: 'communicates',
        sourceKind: 'runtime',
        weight: 2,
        messageCount: 2,
      },
    ],
    degraded: false,
    diagnostics: {
      totalTeams: 3,
      renderedTeams: 3,
      totalCrossTeamMessages: 2,
      renderedCrossTeamRelations: 1,
      truncatedTeams: 0,
      truncatedCrossTeamMessages: 0,
      generatedAt: '2026-07-14T00:00:00.000Z',
    },
  };
  const graphNode = (id: string, ownerId?: string): GraphNode => ({
    id,
    kind: ownerId ? 'task' : id === 'root' ? 'lead' : 'member',
    label: id,
    ownerId,
    state: 'idle',
    domainRef: ownerId
      ? { kind: 'task', teamName: ownerId, taskId: id }
      : { kind: id === 'root' ? 'lead' : 'member', teamName: 'acme', memberName: id },
  });
  const graphData: GraphDataPort = {
    teamName: 'Organization Map',
    isAlive: true,
    nodes: [
      ...payload.nodes.map((node) => graphNode(node.id)),
      graphNode('agent:alpha', 'team:alpha'),
      graphNode('agent:beta', 'team:beta'),
    ],
    edges: [
      ...payload.relations
        .filter((relation) => relation.kind === 'contains')
        .map((relation) => ({
          id: relation.id,
          source: relation.sourceNodeId,
          target: relation.targetNodeId,
          type: 'parent-child' as const,
        })),
      {
        id: 'ownership:alpha',
        source: 'team:alpha',
        target: 'agent:alpha',
        type: 'ownership',
      },
      {
        id: 'ownership:beta',
        source: 'team:beta',
        target: 'agent:beta',
        type: 'ownership',
      },
      {
        id: 'edge:message:alpha-beta',
        source: 'team:alpha',
        target: 'team:beta',
        type: 'message',
      },
    ],
    particles: [],
  };

  return { viewModel: buildOrganizationMapViewModel(payload), graphData };
}

describe('organizationGraphFocus', () => {
  it('searches organizations, groups, teams, and active task subjects', () => {
    const { viewModel } = buildFixture();

    expect(searchOrganizationNodes(viewModel, 'platform')[0]).toMatchObject({
      nodeId: 'group:platform',
      kind: 'container',
    });
    expect(searchOrganizationNodes(viewModel, 'ship authentication')[0]).toMatchObject({
      nodeId: 'team:alpha',
      matchedTaskSubject: 'Ship authentication flow',
    });
    expect(searchOrganizationNodes(viewModel, 'acme')[0]?.nodeId).toBe('org:acme');
  });

  it('builds a safe breadcrumb path and descendant set', () => {
    const { viewModel } = buildFixture();

    expect(getOrganizationNodePath(viewModel, 'team:alpha').map((node) => node.id)).toEqual([
      'root',
      'org:acme',
      'group:platform',
      'team:alpha',
    ]);
    expect(getOrganizationDescendantNodeIds(viewModel, 'group:platform')).toEqual(
      new Set(['group:platform', 'team:alpha'])
    );
  });

  it('keeps ancestors, tasks, and connected teams in context focus', () => {
    const { viewModel, graphData } = buildFixture();
    const focus = buildOrganizationGraphFocusState(viewModel, graphData, 'team:alpha', 'context');

    expect(focus.connectedTeamCount).toBe(1);
    expect(focus.focusNodeIds).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      })
    );
    expect(focus.focusNodeIds?.has('root')).toBe(true);
    expect(focus.focusNodeIds?.has('group:platform')).toBe(true);
    expect(focus.focusNodeIds?.has('team:alpha')).toBe(true);
    expect(focus.focusNodeIds?.has('agent:alpha')).toBe(true);
    expect(focus.focusNodeIds?.has('group:sales')).toBe(true);
    expect(focus.focusNodeIds?.has('team:beta')).toBe(true);
    expect(focus.focusNodeIds?.has('team:gamma')).toBe(false);
    expect(focus.focusEdgeIds?.has('edge:message:alpha-beta')).toBe(true);
  });

  it('supports path-only and connected-team focus modes', () => {
    const { viewModel, graphData } = buildFixture();
    const pathFocus = buildOrganizationGraphFocusState(viewModel, graphData, 'team:alpha', 'path');
    const connectionFocus = buildOrganizationGraphFocusState(
      viewModel,
      graphData,
      'team:alpha',
      'connections'
    );

    expect(pathFocus.focusNodeIds?.has('root')).toBe(true);
    expect(pathFocus.focusNodeIds?.has('team:beta')).toBe(false);
    expect(pathFocus.focusEdgeIds?.has('edge:message:alpha-beta')).toBe(false);
    expect(connectionFocus.focusNodeIds?.has('root')).toBe(false);
    expect(connectionFocus.focusNodeIds?.has('team:alpha')).toBe(true);
    expect(connectionFocus.focusNodeIds?.has('team:beta')).toBe(true);
    expect(connectionFocus.focusNodeIds?.has('agent:beta')).toBe(true);
    expect(connectionFocus.focusEdgeIds?.has('edge:message:alpha-beta')).toBe(true);
    expect(connectionFocus.focusNodeIds?.has('team:gamma')).toBe(false);
  });
});
