import { describe, expect, it } from 'vitest';

import {
  buildOrganizationGraphData,
  getOrganizationGraphRenderProfile,
  getOrganizationNodeIdFromGraphRef,
} from '../organizationGraphData';
import {
  buildOrganizationMapViewModel,
  getOrganizationIdForNodeId,
} from '../organizationMapViewModel';

import type {
  OrganizationMapPayload,
  OrganizationNodeDto,
  OrganizationRelationDto,
} from '../../../contracts';
import type { GraphDomainRef } from '@claude-teams/agent-graph';

function buildPayload(): OrganizationMapPayload {
  return {
    organizations: [
      {
        id: 'default',
        name: 'All Teams',
        rootNodeId: 'org:default',
        updatedAt: '2026-06-24T12:00:00.000Z',
      },
    ],
    activeOrganizationId: 'default',
    nodes: [
      {
        id: 'org:default',
        kind: 'organization',
        label: 'All Teams',
      },
      {
        id: 'team:alpha',
        kind: 'team',
        label: 'Alpha Team',
        team: {
          teamName: 'alpha',
          displayName: 'Alpha Team',
          isOnline: true,
          memberCount: 2,
          taskCounts: {
            pending: 1,
            inProgress: 1,
            completed: 0,
          },
          agents: [
            {
              id: 'agent:alpha:alice',
              teamName: 'alpha',
              name: 'alice',
              role: 'developer',
              status: 'active',
              activeTaskCount: 1,
              currentTasks: [
                {
                  id: 'task-1',
                  subject: 'Build org overview',
                  status: 'in_progress',
                },
              ],
            },
            {
              id: 'agent:alpha:bob',
              teamName: 'alpha',
              name: 'bob',
              role: 'reviewer',
              status: 'idle',
              activeTaskCount: 0,
              currentTasks: [],
            },
          ],
        },
      },
      {
        id: 'team:beta',
        kind: 'team',
        label: 'Beta Team',
        team: {
          teamName: 'beta',
          displayName: 'Beta Team',
          isOnline: false,
          memberCount: 1,
          taskCounts: {
            pending: 0,
            inProgress: 0,
            completed: 1,
          },
          agents: [
            {
              id: 'agent:beta:carol',
              teamName: 'beta',
              name: 'carol',
              status: 'offline',
              activeTaskCount: 0,
              currentTasks: [],
            },
          ],
        },
      },
    ],
    relations: [
      {
        id: 'contains:org:default:team:alpha',
        sourceNodeId: 'org:default',
        targetNodeId: 'team:alpha',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'contains:org:default:team:beta',
        sourceNodeId: 'org:default',
        targetNodeId: 'team:beta',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'communicates:team:alpha:team:beta',
        sourceNodeId: 'team:alpha',
        targetNodeId: 'team:beta',
        kind: 'communicates',
        sourceKind: 'runtime',
        weight: 2,
        messageCount: 2,
        lastActivityAt: '2026-06-24T12:05:00.000Z',
        latestMessagePreview: 'Need QA help',
      },
    ],
    degraded: false,
    diagnostics: {
      totalTeams: 2,
      renderedTeams: 2,
      totalCrossTeamMessages: 2,
      renderedCrossTeamRelations: 1,
      truncatedTeams: 0,
      truncatedCrossTeamMessages: 0,
      generatedAt: '2026-06-24T12:05:00.000Z',
    },
  };
}

function getFixtureTeamNode(payload: OrganizationMapPayload, nodeId: string): OrganizationNodeDto {
  const node = payload.nodes.find((candidate) => candidate.id === nodeId);
  if (!node?.team) {
    throw new Error(`Expected team fixture ${nodeId}`);
  }
  return node;
}

function getFixtureNode(payload: OrganizationMapPayload, nodeId: string): OrganizationNodeDto {
  const node = payload.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Expected node fixture ${nodeId}`);
  }
  return node;
}

function getFixtureRelation(
  payload: OrganizationMapPayload,
  relationId: string
): OrganizationRelationDto {
  const relation = payload.relations.find((candidate) => candidate.id === relationId);
  if (!relation) {
    throw new Error(`Expected relation fixture ${relationId}`);
  }
  return relation;
}

function cloneFixtureTeamNode(
  source: OrganizationNodeDto,
  input: { id: string; label: string; parentNodeId: string; teamName: string }
): OrganizationNodeDto {
  if (!source.team) {
    throw new Error(`Expected team source ${source.id}`);
  }

  return {
    ...source,
    id: input.id,
    label: input.label,
    parentNodeId: input.parentNodeId,
    team: {
      ...source.team,
      teamName: input.teamName,
      displayName: input.label,
      agents: source.team.agents.map((agent) => ({
        ...agent,
        id: `${input.id}:${agent.name}`,
        teamName: input.teamName,
        currentTasks: agent.currentTasks.map((task) => ({
          ...task,
          id: `${input.id}:${task.id}`,
        })),
      })),
    },
  };
}

function buildNestedPayload(): OrganizationMapPayload {
  const payload = buildPayload();
  return {
    ...payload,
    nodes: [
      payload.nodes[0],
      {
        id: 'unit:engineering',
        kind: 'container',
        label: 'Engineering',
      },
      {
        ...payload.nodes[1],
        parentNodeId: 'unit:engineering',
      },
      payload.nodes[2],
    ],
    relations: [
      {
        id: 'contains:org:default:unit:engineering',
        sourceNodeId: 'org:default',
        targetNodeId: 'unit:engineering',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:unit:engineering:team:alpha',
        sourceNodeId: 'unit:engineering',
        targetNodeId: 'team:alpha',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:org:default:team:beta',
        sourceNodeId: 'org:default',
        targetNodeId: 'team:beta',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      payload.relations[2],
    ],
  };
}

function buildLargePayload(teamCount = 12): OrganizationMapPayload {
  return {
    organizations: [
      {
        id: 'default',
        name: 'All Teams',
        rootNodeId: 'org:default',
        updatedAt: '2026-06-24T12:00:00.000Z',
      },
    ],
    activeOrganizationId: 'default',
    nodes: [
      {
        id: 'org:default',
        kind: 'organization',
        label: 'All Teams',
      },
      ...Array.from({ length: teamCount }, (_, teamIndex) => ({
        id: `team:${teamIndex}`,
        kind: 'team' as const,
        label: `Team ${teamIndex}`,
        team: {
          teamName: `team-${teamIndex}`,
          displayName: `Team ${teamIndex}`,
          isOnline: true,
          memberCount: 4,
          taskCounts: {
            pending: 0,
            inProgress: teamIndex === 0 ? 1 : 0,
            completed: 0,
          },
          agents: Array.from({ length: 4 }, (_, agentIndex) => ({
            id: `agent:${teamIndex}:${agentIndex}`,
            teamName: `team-${teamIndex}`,
            name: `agent-${agentIndex}`,
            status: agentIndex === 0 ? ('active' as const) : ('idle' as const),
            activeTaskCount: agentIndex === 0 ? 1 : 0,
            currentTasks:
              agentIndex === 0
                ? [
                    {
                      id: `task-${teamIndex}-${agentIndex}`,
                      subject: `Task ${teamIndex}`,
                      status: 'in_progress' as const,
                    },
                  ]
                : [],
          })),
        },
      })),
    ],
    relations: Array.from({ length: teamCount }, (_, teamIndex) => ({
      id: `contains:org:default:team:${teamIndex}`,
      sourceNodeId: 'org:default',
      targetNodeId: `team:${teamIndex}`,
      kind: 'contains' as const,
      sourceKind: 'inferred' as const,
      weight: 1,
    })),
    degraded: false,
    diagnostics: {
      totalTeams: teamCount,
      renderedTeams: teamCount,
      totalCrossTeamMessages: 0,
      renderedCrossTeamRelations: 0,
      truncatedTeams: 0,
      truncatedCrossTeamMessages: 0,
      generatedAt: '2026-06-24T12:05:00.000Z',
    },
  };
}

function buildAllOrganizationsPayload(): OrganizationMapPayload {
  const base = buildPayload();
  return {
    ...base,
    scope: 'all',
    activeOrganizationId: 'product',
    rootNodeId: 'org:__all-organizations__',
    organizations: [
      {
        id: 'product',
        name: 'Product Org',
        rootNodeId: 'org:product',
      },
      {
        id: 'quality',
        name: 'Quality Org',
        rootNodeId: 'org:quality',
      },
    ],
    nodes: [
      {
        id: 'org:__all-organizations__',
        kind: 'organization',
        label: 'Organizations',
      },
      {
        id: 'org:product',
        structureUnitId: 'product-root',
        kind: 'organization',
        label: 'Product Org',
        parentNodeId: 'org:__all-organizations__',
      },
      {
        ...base.nodes[1],
        parentNodeId: 'org:product',
      },
      {
        id: 'org:quality',
        structureUnitId: 'quality-root',
        kind: 'organization',
        label: 'Quality Org',
        parentNodeId: 'org:__all-organizations__',
      },
      {
        ...base.nodes[2],
        parentNodeId: 'org:quality',
      },
    ],
    relations: [
      {
        id: 'contains:overview:product',
        sourceNodeId: 'org:__all-organizations__',
        targetNodeId: 'org:product',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'contains:product:alpha',
        sourceNodeId: 'org:product',
        targetNodeId: 'team:alpha',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:overview:quality',
        sourceNodeId: 'org:__all-organizations__',
        targetNodeId: 'org:quality',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'contains:quality:beta',
        sourceNodeId: 'org:quality',
        targetNodeId: 'team:beta',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      getFixtureRelation(base, 'communicates:team:alpha:team:beta'),
    ],
  };
}

function buildAllOrganizationsNestedPayload(): OrganizationMapPayload {
  const base = buildAllOrganizationsPayload();
  const betaNode = base.nodes.find((node) => node.id === 'team:beta');
  if (!betaNode?.team) {
    throw new Error('Expected beta team fixture');
  }

  return {
    ...base,
    nodes: [
      base.nodes.find((node) => node.id === 'org:__all-organizations__')!,
      base.nodes.find((node) => node.id === 'org:product')!,
      {
        id: 'unit:product:engineering',
        structureUnitId: 'engineering',
        kind: 'container',
        label: 'Engineering',
        parentNodeId: 'org:product',
      },
      {
        ...base.nodes.find((node) => node.id === 'team:alpha')!,
        parentNodeId: 'unit:product:engineering',
      },
      base.nodes.find((node) => node.id === 'org:quality')!,
      base.nodes.find((node) => node.id === 'team:beta')!,
      {
        id: 'unit:__all-organizations__:unassigned-teams',
        kind: 'container',
        label: 'Unassigned Teams',
        parentNodeId: 'org:__all-organizations__',
      },
      {
        ...betaNode,
        id: 'team:gamma',
        label: 'Gamma Team',
        parentNodeId: 'unit:__all-organizations__:unassigned-teams',
        team: {
          ...betaNode.team,
          teamName: 'gamma',
          displayName: 'Gamma Team',
        },
      },
    ],
    relations: [
      {
        id: 'contains:overview:product',
        sourceNodeId: 'org:__all-organizations__',
        targetNodeId: 'org:product',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'contains:product:engineering',
        sourceNodeId: 'org:product',
        targetNodeId: 'unit:product:engineering',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:engineering:alpha',
        sourceNodeId: 'unit:product:engineering',
        targetNodeId: 'team:alpha',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:overview:quality',
        sourceNodeId: 'org:__all-organizations__',
        targetNodeId: 'org:quality',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'contains:quality:beta',
        sourceNodeId: 'org:quality',
        targetNodeId: 'team:beta',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:overview:unassigned',
        sourceNodeId: 'org:__all-organizations__',
        targetNodeId: 'unit:__all-organizations__:unassigned-teams',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      {
        id: 'contains:unassigned:gamma',
        sourceNodeId: 'unit:__all-organizations__:unassigned-teams',
        targetNodeId: 'team:gamma',
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      },
      base.relations.find((relation) => relation.kind === 'communicates')!,
    ],
  };
}

function buildSiblingGroupsPayload(): OrganizationMapPayload {
  const base = buildPayload();
  const alpha = cloneFixtureTeamNode(getFixtureTeamNode(base, 'team:alpha'), {
    id: 'team:alpha',
    label: 'Alpha Team',
    parentNodeId: 'unit:growth',
    teamName: 'alpha',
  });
  const beta = cloneFixtureTeamNode(getFixtureTeamNode(base, 'team:beta'), {
    id: 'team:beta',
    label: 'Beta Team',
    parentNodeId: 'unit:growth',
    teamName: 'beta',
  });
  const gamma = cloneFixtureTeamNode(getFixtureTeamNode(base, 'team:alpha'), {
    id: 'team:gamma',
    label: 'Gamma Team',
    parentNodeId: 'unit:retention',
    teamName: 'gamma',
  });
  const delta = cloneFixtureTeamNode(getFixtureTeamNode(base, 'team:beta'), {
    id: 'team:delta',
    label: 'Delta Team',
    parentNodeId: 'unit:retention',
    teamName: 'delta',
  });

  return {
    ...base,
    nodes: [
      getFixtureNode(base, 'org:default'),
      {
        id: 'unit:growth',
        kind: 'container',
        label: 'Growth Group',
      },
      alpha,
      beta,
      {
        id: 'unit:retention',
        kind: 'container',
        label: 'Retention Group',
      },
      gamma,
      delta,
    ],
    relations: [
      {
        id: 'contains:org:default:unit:growth',
        sourceNodeId: 'org:default',
        targetNodeId: 'unit:growth',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:unit:growth:team:alpha',
        sourceNodeId: 'unit:growth',
        targetNodeId: 'team:alpha',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:unit:growth:team:beta',
        sourceNodeId: 'unit:growth',
        targetNodeId: 'team:beta',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:org:default:unit:retention',
        sourceNodeId: 'org:default',
        targetNodeId: 'unit:retention',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:unit:retention:team:gamma',
        sourceNodeId: 'unit:retention',
        targetNodeId: 'team:gamma',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:unit:retention:team:delta',
        sourceNodeId: 'unit:retention',
        targetNodeId: 'team:delta',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
    ],
    diagnostics: {
      ...base.diagnostics,
      totalTeams: 4,
      renderedTeams: 4,
      renderedCrossTeamRelations: 0,
      totalCrossTeamMessages: 0,
    },
  };
}

function buildTallSiblingGroupsPayload(): OrganizationMapPayload {
  const base = buildPayload();
  const source = getFixtureTeamNode(base, 'team:alpha');
  const bulkTeams = Array.from({ length: 10 }, (_, index) =>
    cloneFixtureTeamNode(source, {
      id: `team:bulk-${index}`,
      label: `Bulk Team ${index}`,
      parentNodeId: 'unit:bulk',
      teamName: `bulk-${index}`,
    })
  );
  const smallTeam = cloneFixtureTeamNode(getFixtureTeamNode(base, 'team:beta'), {
    id: 'team:small',
    label: 'Small Team',
    parentNodeId: 'unit:small',
    teamName: 'small',
  });

  return {
    ...base,
    nodes: [
      getFixtureNode(base, 'org:default'),
      {
        id: 'unit:bulk',
        kind: 'container',
        label: 'Bulk Group',
      },
      ...bulkTeams,
      {
        id: 'unit:small',
        kind: 'container',
        label: 'Small Group',
      },
      smallTeam,
    ],
    relations: [
      {
        id: 'contains:org:default:unit:bulk',
        sourceNodeId: 'org:default',
        targetNodeId: 'unit:bulk',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      ...bulkTeams.map((team) => ({
        id: `contains:unit:bulk:${team.id}`,
        sourceNodeId: 'unit:bulk',
        targetNodeId: team.id,
        kind: 'contains' as const,
        sourceKind: 'manual' as const,
        weight: 1,
      })),
      {
        id: 'contains:org:default:unit:small',
        sourceNodeId: 'org:default',
        targetNodeId: 'unit:small',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:unit:small:team:small',
        sourceNodeId: 'unit:small',
        targetNodeId: 'team:small',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
    ],
    diagnostics: {
      ...base.diagnostics,
      totalTeams: 11,
      renderedTeams: 11,
      renderedCrossTeamRelations: 0,
      totalCrossTeamMessages: 0,
    },
  };
}

describe('buildOrganizationGraphData', () => {
  it('selects the active organization root when multiple summaries are present', () => {
    const payload = buildPayload();
    payload.activeOrganizationId = 'default';
    payload.organizations = [
      { id: 'other', name: 'Other', rootNodeId: 'org:other' },
      ...payload.organizations,
    ];
    payload.nodes = [{ id: 'org:other', kind: 'organization', label: 'Other' }, ...payload.nodes];

    const viewModel = buildOrganizationMapViewModel(payload);

    expect(viewModel.rootNode?.id).toBe('org:default');
  });

  it('counts manual and runtime non-containment links in summary stats', () => {
    const payload = buildPayload();
    payload.relations.push({
      id: 'manual:alpha:beta',
      sourceNodeId: 'team:alpha',
      targetNodeId: 'team:beta',
      kind: 'depends_on',
      sourceKind: 'manual',
      weight: 1,
      label: 'Manual dependency',
    });

    const viewModel = buildOrganizationMapViewModel(payload);

    expect(viewModel.stats.communicationEdgeCount).toBe(1);
    expect(viewModel.stats.manualRelationCount).toBe(1);
    expect(viewModel.stats.linkCount).toBe(2);
  });

  it('maps organization payloads to reusable graph nodes, edges, and particles', () => {
    const viewModel = buildOrganizationMapViewModel(buildPayload());
    const graph = buildOrganizationGraphData(viewModel);

    expect(
      graph.nodes.filter((node) => !node.layoutOnly).map((node) => [node.id, node.kind, node.state])
    ).toEqual([
      ['team:alpha', 'member', 'active'],
      ['team:beta', 'member', 'terminated'],
      ['agent:alpha:alice', 'task', 'active'],
    ]);
    expect(graph.nodes.find((node) => node.id === 'org:default')).toMatchObject({
      kind: 'lead',
      layoutOnly: true,
    });
    expect(graph.layout?.mode).toBe('grid-under-lead');
    expect(graph.layout?.showTasks).toBe(true);
    expect(graph.layout?.fitTaskRowsToContent).toBe(true);
    expect(graph.layout?.showEmptyTaskPlaceholders).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === 'agent:alpha:alice')).toMatchObject({
      taskZoomVisibility: 'summary',
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'team:alpha',
          target: 'team:beta',
          type: 'message',
          aggregateCount: 2,
        }),
        expect.objectContaining({
          source: 'team:alpha',
          target: 'agent:alpha:alice',
          type: 'ownership',
        }),
      ])
    );
    expect(graph.particles).toHaveLength(2);
    expect(graph.particles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeId: 'org-message:communicates:team:alpha:team:beta:team:alpha->team:beta',
          kind: 'inbox_message',
          preview: 'Need QA help',
        }),
      ])
    );

    const selectedGraph = buildOrganizationGraphData(viewModel, { selectedNodeId: 'team:alpha' });

    expect(selectedGraph.layout?.showTasks).toBe(true);
    expect(
      selectedGraph.nodes
        .filter((node) => !node.layoutOnly)
        .map((node) => [node.id, node.kind, node.state])
    ).toEqual([
      ['team:alpha', 'member', 'active'],
      ['team:beta', 'member', 'terminated'],
      ['agent:alpha:alice', 'task', 'active'],
    ]);
    expect(selectedGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'team:alpha',
          target: 'agent:alpha:alice',
          type: 'ownership',
        }),
      ])
    );

    const editGraph = buildOrganizationGraphData(viewModel, {
      selectedNodeId: 'team:alpha',
      showSelectedTeamDetails: false,
    });

    expect(editGraph.layout?.showTasks).toBe(false);
    expect(editGraph.nodes.some((node) => node.kind === 'task')).toBe(false);
    expect(editGraph.edges.some((edge) => edge.type === 'ownership')).toBe(false);
  });

  it('renders only the latest four in-progress agent tasks per team', () => {
    const payload = buildPayload();
    const alphaNode = payload.nodes.find((node) => node.id === 'team:alpha');
    expect(alphaNode?.team).toBeTruthy();
    alphaNode!.team!.agents = Array.from({ length: 6 }, (_, index) => ({
      id: `agent:alpha:${index}`,
      teamName: 'alpha',
      name: `agent-${index}`,
      status: 'active',
      activeTaskCount: 1,
      currentTasks: [
        {
          id: `task-${index}`,
          subject: `Task ${index}`,
          status: index === 0 ? 'completed' : 'in_progress',
          updatedAt: `2026-06-24T12:0${index}:00.000Z`,
        },
      ],
    }));

    const graph = buildOrganizationGraphData(buildOrganizationMapViewModel(payload));

    expect(
      graph.nodes.filter((node) => node.kind === 'task').map((node) => [node.id, node.sublabel])
    ).toEqual([
      ['agent:alpha:5', 'Task 5'],
      ['agent:alpha:4', 'Task 4'],
      ['agent:alpha:3', 'Task 3'],
      ['agent:alpha:2', 'Task 2'],
    ]);
  });

  it('resolves agent graph clicks back to their owning team node', () => {
    const viewModel = buildOrganizationMapViewModel(buildPayload());
    const ref: GraphDomainRef = {
      kind: 'task',
      teamName: 'alpha',
      taskId: 'agent:alpha:alice',
    };

    expect(getOrganizationNodeIdFromGraphRef(viewModel, ref)).toBe('team:alpha');
  });

  it('resolves graph refs by team summary name instead of rebuilding node ids', () => {
    const payload = buildPayload();
    payload.nodes[1] = {
      ...payload.nodes[1],
      id: 'team:dream-team',
      team: {
        ...payload.nodes[1].team!,
        teamName: 'dream team',
      },
    };
    const viewModel = buildOrganizationMapViewModel(payload);

    expect(
      getOrganizationNodeIdFromGraphRef(viewModel, {
        kind: 'task',
        teamName: 'dream team',
        taskId: 'agent:dream-team:alice',
      })
    ).toBe('team:dream-team');
    expect(
      getOrganizationNodeIdFromGraphRef(viewModel, {
        kind: 'crossteam',
        teamName: 'beta',
        externalTeamName: 'dream team',
      })
    ).toBe('team:dream-team');
  });

  it('renders collapsed containers as selectable nodes and reroutes communication edges', () => {
    const viewModel = buildOrganizationMapViewModel(buildNestedPayload());
    const graph = buildOrganizationGraphData(viewModel, {
      collapsedNodeIds: new Set(['unit:engineering']),
    });

    expect(graph.nodes.map((node) => node.id)).not.toContain('team:alpha');
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'unit:engineering',
          kind: 'member',
          visualVariant: 'container',
          role: expect.stringContaining('1'),
        }),
      ])
    );
    expect(graph.layout?.ownerOrder).toContain('unit:engineering');
    expect(graph.layout?.slotAssignments['unit:engineering']).toBeDefined();
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'unit:engineering',
          target: 'team:beta',
          type: 'message',
        }),
      ])
    );
    expect(graph.particles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeId:
            'org-message:rel:communicates:unit:engineering->team:beta:unit:engineering->team:beta',
        }),
      ])
    );
  });

  it('renders containers as group frames instead of graph nodes', () => {
    const viewModel = buildOrganizationMapViewModel(buildNestedPayload());
    const graph = buildOrganizationGraphData(viewModel);

    expect(graph.nodes.map((node) => [node.id, node.kind, node.visualVariant])).toEqual(
      expect.arrayContaining([
        ['team:alpha', 'member', 'team'],
        ['team:beta', 'member', 'team'],
      ])
    );
    expect(graph.nodes.find((node) => node.id === 'org:default')).toMatchObject({
      kind: 'lead',
      layoutOnly: true,
    });
    expect(graph.nodes.map((node) => node.id)).not.toContain('unit:engineering');
    expect(graph.groupFrames).toEqual([
      {
        id: 'unit:engineering',
        label: 'Engineering',
        semanticSummary: '1 teams · 1 active · 2 tasks',
        nodeIds: ['team:alpha', 'agent:alpha:alice'],
        color: '#8bd3ff',
        depth: 0,
        priority: 'normal',
      },
    ]);
    expect(graph.layout?.ownerOrder).toEqual(['team:beta', 'team:alpha']);

    const collapsedGraph = buildOrganizationGraphData(viewModel, {
      collapsedNodeIds: new Set(['unit:engineering']),
    });
    expect(collapsedGraph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'unit:engineering',
          kind: 'member',
          visualVariant: 'container',
        }),
      ])
    );
    expect(collapsedGraph.groupFrames).toEqual([
      {
        id: 'unit:engineering',
        label: 'Engineering',
        semanticSummary: expect.any(String),
        nodeIds: ['unit:engineering'],
        color: '#8bd3ff',
        depth: 0,
        priority: 'normal',
      },
    ]);
  });

  it('counts online teams in group aggregates independently of task status', () => {
    const payload = buildNestedPayload();
    const alpha = payload.nodes.find((node) => node.id === 'team:alpha');
    if (!alpha?.team) throw new Error('Expected alpha team fixture');
    alpha.team.isOnline = false;

    const graph = buildOrganizationGraphData(buildOrganizationMapViewModel(payload));

    expect(graph.groupFrames?.find((frame) => frame.id === 'unit:engineering')).toMatchObject({
      semanticSummary: '1 teams · 0 active · 2 tasks',
    });
  });

  it('renders organizations as frames in all-organizations scope', () => {
    const viewModel = buildOrganizationMapViewModel(buildAllOrganizationsPayload());
    const graph = buildOrganizationGraphData(viewModel);

    expect(viewModel.rootNode?.id).toBe('org:__all-organizations__');
    expect(graph.nodes.map((node) => [node.id, node.kind, node.visualVariant])).toEqual(
      expect.arrayContaining([
        ['team:alpha', 'member', 'team'],
        ['team:beta', 'member', 'team'],
      ])
    );
    const graphNodeIds = graph.nodes.map((node) => node.id);
    expect(graph.nodes.find((node) => node.id === 'org:__all-organizations__')).toMatchObject({
      kind: 'lead',
      visualVariant: 'organization',
      layoutOnly: true,
    });
    expect(graphNodeIds).not.toContain('org:product');
    expect(graphNodeIds).not.toContain('org:quality');
    expect(graph.groupFrames).toEqual([
      {
        id: 'org:product',
        label: 'Product Org',
        semanticSummary: expect.any(String),
        nodeIds: ['team:alpha', 'agent:alpha:alice'],
        color: '#4f8cff',
        depth: 0,
        priority: 'primary',
      },
      {
        id: 'org:quality',
        label: 'Quality Org',
        semanticSummary: expect.any(String),
        nodeIds: ['team:beta'],
        color: '#4f8cff',
        depth: 0,
        priority: 'primary',
      },
    ]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'team:alpha',
          target: 'team:beta',
          type: 'message',
        }),
      ])
    );
    expect(getOrganizationIdForNodeId(viewModel, 'team:beta')).toBe('quality');
    expect(getOrganizationIdForNodeId(viewModel, 'org:product')).toBe('product');
  });

  it('renders nested groups inside organization frames in all-organizations scope', () => {
    const viewModel = buildOrganizationMapViewModel(buildAllOrganizationsNestedPayload());
    const graph = buildOrganizationGraphData(viewModel);

    const graphNodeIds = graph.nodes.map((node) => node.id);
    expect(graphNodeIds).not.toContain('org:product');
    expect(graphNodeIds).not.toContain('org:quality');
    expect(graphNodeIds).not.toContain('unit:product:engineering');
    expect(graphNodeIds).not.toContain('unit:__all-organizations__:unassigned-teams');
    expect(graph.groupFrames).toEqual([
      {
        id: 'org:product',
        label: 'Product Org',
        semanticSummary: expect.any(String),
        nodeIds: ['unit:product:engineering', 'team:alpha', 'agent:alpha:alice'],
        color: '#4f8cff',
        depth: 0,
        labelLane: 1,
        priority: 'primary',
      },
      {
        id: 'unit:product:engineering',
        label: 'Engineering',
        semanticSummary: expect.any(String),
        nodeIds: ['team:alpha', 'agent:alpha:alice'],
        color: '#8bd3ff',
        depth: 1,
        priority: 'normal',
      },
      {
        id: 'org:quality',
        label: 'Quality Org',
        semanticSummary: expect.any(String),
        nodeIds: ['team:beta'],
        color: '#4f8cff',
        depth: 0,
        priority: 'primary',
      },
      {
        id: 'unit:__all-organizations__:unassigned-teams',
        label: 'Unassigned Teams',
        semanticSummary: expect.any(String),
        nodeIds: ['team:gamma'],
        color: '#8bd3ff',
        depth: 0,
        priority: 'normal',
      },
    ]);
    expect(getOrganizationIdForNodeId(viewModel, 'unit:product:engineering')).toBe('product');
    expect(getOrganizationIdForNodeId(viewModel, 'team:gamma')).toBeNull();
  });

  it('uses rows layout slots by default for nested organization blocks', () => {
    const viewModel = buildOrganizationMapViewModel(buildAllOrganizationsNestedPayload());
    const graph = buildOrganizationGraphData(viewModel);
    const slots = graph.layout?.slotAssignments ?? {};

    expect(graph.layout?.mode).toBe('grid-under-lead');
    expect(slots['team:alpha']?.ringIndex).toBe(slots['team:beta']?.ringIndex);
    expect(slots['team:alpha']?.sectorIndex).toBeLessThan(slots['team:beta']?.sectorIndex ?? -1);
    expect(
      (slots['team:beta']?.sectorIndex ?? 0) - (slots['team:alpha']?.sectorIndex ?? 0)
    ).toBeGreaterThanOrEqual(2);
    expect(slots['team:beta']?.ringIndex).toBeLessThan(slots['team:gamma']?.ringIndex ?? -1);
    expect(
      (slots['team:gamma']?.ringIndex ?? 0) - (slots['team:beta']?.ringIndex ?? 0)
    ).toBeGreaterThanOrEqual(6);
  });

  it('packs narrow sibling groups side by side in rows layout', () => {
    const viewModel = buildOrganizationMapViewModel(buildSiblingGroupsPayload());
    const graph = buildOrganizationGraphData(viewModel, { layoutMode: 'grid-under-lead' });
    const slots = graph.layout?.slotAssignments ?? {};

    expect(slots['team:alpha']?.ringIndex).toBe(slots['team:gamma']?.ringIndex);
    expect(slots['team:beta']?.ringIndex).toBe(slots['team:delta']?.ringIndex);
    expect(slots['team:alpha']?.sectorIndex).toBeLessThan(slots['team:gamma']?.sectorIndex ?? -1);
    expect(slots['team:beta']?.sectorIndex).toBeLessThan(slots['team:delta']?.sectorIndex ?? -1);
    expect(
      (slots['team:gamma']?.sectorIndex ?? 0) - (slots['team:alpha']?.sectorIndex ?? 0)
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps sibling group slots stable when a neighboring group is collapsed', () => {
    const viewModel = buildOrganizationMapViewModel(buildSiblingGroupsPayload());
    const expandedGraph = buildOrganizationGraphData(viewModel, { layoutMode: 'grid-under-lead' });
    const collapsedGraph = buildOrganizationGraphData(viewModel, {
      collapsedNodeIds: new Set(['unit:growth']),
      layoutMode: 'grid-under-lead',
    });
    const expandedSlots = expandedGraph.layout?.slotAssignments ?? {};
    const collapsedSlots = collapsedGraph.layout?.slotAssignments ?? {};

    expect(collapsedSlots['team:gamma']).toEqual(expandedSlots['team:gamma']);
    expect(collapsedSlots['team:delta']).toEqual(expandedSlots['team:delta']);
    expect(collapsedSlots['unit:growth']?.ringIndex).toBe(expandedSlots['team:alpha']?.ringIndex);
    expect(collapsedGraph.groupFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'unit:growth',
          nodeIds: ['unit:growth'],
        }),
      ])
    );
  });

  it('places up to three teams from one group in the same row', () => {
    const payload = buildSiblingGroupsPayload();
    const epsilon = cloneFixtureTeamNode(getFixtureTeamNode(payload, 'team:alpha'), {
      id: 'team:epsilon',
      label: 'Epsilon Team',
      parentNodeId: 'unit:growth',
      teamName: 'epsilon',
    });
    payload.nodes.push(epsilon);
    payload.relations.push({
      id: 'contains:unit:growth:team:epsilon',
      sourceNodeId: 'unit:growth',
      targetNodeId: 'team:epsilon',
      kind: 'contains',
      sourceKind: 'manual',
      weight: 1,
    });
    payload.diagnostics = {
      ...payload.diagnostics,
      totalTeams: 5,
      renderedTeams: 5,
    };
    const viewModel = buildOrganizationMapViewModel(payload);
    const graph = buildOrganizationGraphData(viewModel, { layoutMode: 'grid-under-lead' });
    const slots = graph.layout?.slotAssignments ?? {};

    expect(slots['team:alpha']?.ringIndex).toBe(slots['team:beta']?.ringIndex);
    expect(slots['team:beta']?.ringIndex).toBe(slots['team:epsilon']?.ringIndex);
    expect(slots['team:alpha']?.sectorIndex).toBe(0);
    expect(slots['team:beta']?.sectorIndex).toBe(1);
    expect(slots['team:epsilon']?.sectorIndex).toBe(2);
  });

  it('keeps tall sibling groups on their own row', () => {
    const viewModel = buildOrganizationMapViewModel(buildTallSiblingGroupsPayload());
    const graph = buildOrganizationGraphData(viewModel, { layoutMode: 'grid-under-lead' });
    const slots = graph.layout?.slotAssignments ?? {};

    expect(slots['team:bulk-0']?.ringIndex).toBeLessThan(slots['team:small']?.ringIndex ?? -1);
    expect(slots['team:bulk-9']?.ringIndex).toBeLessThan(slots['team:small']?.ringIndex ?? -1);
  });

  it('renders manual organization relations as typed graph edges', () => {
    const payload = buildPayload();
    payload.relations.push({
      id: 'rel:depends_on:team:alpha->team:beta',
      sourceNodeId: 'team:alpha',
      targetNodeId: 'team:beta',
      kind: 'depends_on',
      sourceKind: 'manual',
      weight: 1,
    });
    const viewModel = buildOrganizationMapViewModel(payload);
    const graph = buildOrganizationGraphData(viewModel);

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'team:alpha',
          target: 'team:beta',
          type: 'blocking',
          label: 'depends on',
          color: '#f59e0b',
        }),
      ])
    );
  });

  it('keeps visual relation edge ids unique when source relations reuse ids', () => {
    const payload = buildPayload();
    payload.relations.push(
      {
        id: 'shared-relation-id',
        sourceNodeId: 'team:alpha',
        targetNodeId: 'team:beta',
        kind: 'depends_on',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'shared-relation-id',
        sourceNodeId: 'team:alpha',
        targetNodeId: 'team:beta',
        kind: 'communicates',
        sourceKind: 'runtime',
        weight: 1,
        messageCount: 1,
      }
    );
    const graph = buildOrganizationGraphData(buildOrganizationMapViewModel(payload));
    const relationEdges = graph.edges.filter(
      (edge) => edge.type === 'blocking' || edge.type === 'related' || edge.type === 'message'
    );

    expect(new Set(relationEdges.map((edge) => edge.id)).size).toBe(relationEdges.length);
  });

  it('reroutes manual relation edges to collapsed container nodes', () => {
    const payload = buildNestedPayload();
    payload.relations.push({
      id: 'rel:observes:team:alpha->team:beta',
      sourceNodeId: 'team:alpha',
      targetNodeId: 'team:beta',
      kind: 'observes',
      sourceKind: 'manual',
      weight: 1,
    });
    const viewModel = buildOrganizationMapViewModel(payload);
    const graph = buildOrganizationGraphData(viewModel, {
      collapsedNodeIds: new Set(['unit:engineering']),
    });

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'unit:engineering',
          target: 'team:beta',
          type: 'related',
          aggregateCount: 1,
        }),
      ])
    );
  });

  it('aggregates manual relation edges when collapse reroutes them to a container', () => {
    const payload = buildNestedPayload();
    payload.nodes.push({
      ...payload.nodes.find((node) => node.id === 'team:alpha')!,
      id: 'team:gamma',
      label: 'Gamma Team',
      parentNodeId: 'unit:engineering',
      team: {
        ...payload.nodes.find((node) => node.id === 'team:alpha')!.team!,
        teamName: 'gamma',
        displayName: 'Gamma Team',
      },
    });
    payload.relations.push(
      {
        id: 'contains:unit:engineering:team:gamma',
        sourceNodeId: 'unit:engineering',
        targetNodeId: 'team:gamma',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'rel:observes:team:alpha->team:beta',
        sourceNodeId: 'team:alpha',
        targetNodeId: 'team:beta',
        kind: 'observes',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'rel:observes:team:gamma->team:beta',
        sourceNodeId: 'team:gamma',
        targetNodeId: 'team:beta',
        kind: 'observes',
        sourceKind: 'manual',
        weight: 1,
      }
    );
    const viewModel = buildOrganizationMapViewModel(payload);
    const graph = buildOrganizationGraphData(viewModel, {
      collapsedNodeIds: new Set(['unit:engineering']),
    });

    expect(
      graph.edges.filter(
        (edge) =>
          edge.source === 'unit:engineering' &&
          edge.target === 'team:beta' &&
          edge.type === 'related'
      )
    ).toEqual([expect.objectContaining({ aggregateCount: 2 })]);
  });

  it('renders bounded in-progress agent task lanes for large organization maps', () => {
    const viewModel = buildOrganizationMapViewModel(buildLargePayload());
    const graph = buildOrganizationGraphData(viewModel);
    const profile = getOrganizationGraphRenderProfile(viewModel);

    expect(profile.detailMode).toBe('active-agent-tasks');
    expect(profile.hiddenAgentCount).toBe(36);
    expect(graph.layout?.mode).toBe('grid-under-lead');
    expect(graph.layout?.showTasks).toBe(true);
    expect(graph.layout?.showEmptyTaskPlaceholders).toBeUndefined();
    expect(graph.nodes.filter((node) => node.kind === 'task')).toHaveLength(12);
    expect(graph.edges.filter((edge) => edge.type === 'ownership')).toHaveLength(12);

    const selectedGraph = buildOrganizationGraphData(viewModel, { selectedNodeId: 'team:3' });
    const selectedProfile = getOrganizationGraphRenderProfile(viewModel, {
      selectedNodeId: 'team:3',
    });

    expect(selectedProfile.hiddenAgentCount).toBe(36);
    expect(selectedGraph.layout?.showTasks).toBe(true);
    expect(
      selectedGraph.nodes.filter((node) => node.kind === 'task').map((node) => node.id)
    ).toContain('agent:3:0');
    expect(
      selectedGraph.edges
        .filter((edge) => edge.type === 'ownership')
        .map((edge) => [edge.source, edge.target])
    ).toContainEqual(['team:3', 'agent:3:0']);
  });

  it('honors explicit layout mode overrides for organization map controls', () => {
    const viewModel = buildOrganizationMapViewModel(buildLargePayload());
    const rowsGraph = buildOrganizationGraphData(viewModel, { layoutMode: 'grid-under-lead' });
    const radialGraph = buildOrganizationGraphData(viewModel, { layoutMode: 'radial' });
    const rowsSlotAssignments = Object.values(rowsGraph.layout?.slotAssignments ?? {});
    const maxGridColumnIndex = Math.max(
      ...rowsSlotAssignments.map((assignment) => assignment.sectorIndex)
    );
    const maxGridRowIndex = Math.max(
      ...rowsSlotAssignments.map((assignment) => assignment.ringIndex)
    );

    expect(rowsGraph.layout?.mode).toBe('grid-under-lead');
    expect(radialGraph.layout?.mode).toBe('radial');
    expect(rowsGraph.nodes.find((node) => node.kind === 'task')?.taskZoomVisibility).toBe(
      'summary'
    );
    expect(radialGraph.nodes.find((node) => node.kind === 'task')?.taskZoomVisibility).toBe(
      'detail'
    );
    expect(maxGridColumnIndex).toBeGreaterThan(1);
    expect(maxGridRowIndex).toBeLessThan(5);
    expect(rowsGraph.layout?.ownerOrder).toEqual(radialGraph.layout?.ownerOrder);
  });

  it('builds a live top-down hierarchy with tasks and communication particles', () => {
    const viewModel = buildOrganizationMapViewModel(buildAllOrganizationsNestedPayload());
    const graph = buildOrganizationGraphData(viewModel, { layoutMode: 'hierarchical' });
    const positions = graph.layout?.nodePositions ?? {};

    expect(graph.layout?.mode).toBe('hierarchical');
    expect(graph.layout?.showTasks).toBe(true);
    expect(graph.groupFrames).toEqual([]);
    expect(graph.nodes.filter((node) => node.kind === 'task')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent:alpha:alice',
          kind: 'task',
          state: 'active',
          ownerId: 'team:alpha',
          sublabel: 'Build org overview',
          taskZoomVisibility: 'summary',
        }),
      ])
    );
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'org:__all-organizations__',
          kind: 'lead',
          hierarchyDepth: 0,
          semanticSummary: expect.any(String),
        }),
        expect.objectContaining({
          id: 'org:product',
          visualVariant: 'organization',
          hierarchyDepth: 1,
        }),
        expect.objectContaining({
          id: 'unit:product:engineering',
          visualVariant: 'container',
          hierarchyDepth: 2,
        }),
        expect.objectContaining({
          id: 'team:alpha',
          visualVariant: 'team',
          state: 'active',
          hierarchyDepth: 3,
          semanticSummary: expect.any(String),
        }),
      ])
    );

    expect(positions['org:product']?.y).toBeGreaterThan(
      positions['org:__all-organizations__']?.y ?? Number.POSITIVE_INFINITY
    );
    expect(positions['unit:product:engineering']?.y).toBeGreaterThan(
      positions['org:product']?.y ?? Number.POSITIVE_INFINITY
    );
    expect(positions['team:alpha']?.y).toBeGreaterThan(
      positions['unit:product:engineering']?.y ?? Number.POSITIVE_INFINITY
    );
    expect(positions['agent:alpha:alice']?.y).toBeGreaterThan(
      positions['team:alpha']?.y ?? Number.POSITIVE_INFINITY
    );
    const hierarchyEdges = graph.edges.filter((edge) => edge.type === 'parent-child');
    expect(hierarchyEdges.length).toBeGreaterThan(0);
    expect(
      hierarchyEdges.every((edge) => edge.routing === 'orthogonal' && edge.alwaysVisible === true)
    ).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'team:alpha',
          target: 'agent:alpha:alice',
          type: 'ownership',
        }),
        expect.objectContaining({
          source: 'team:alpha',
          target: 'team:beta',
          type: 'message',
        }),
      ])
    );
    expect(graph.particles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeId: 'org-message:communicates:team:alpha:team:beta:team:alpha->team:beta',
          kind: 'inbox_message',
        }),
      ])
    );
  });
});
