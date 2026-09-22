import {
  buildAllOrganizationsGraph,
  buildDefaultOrganizationGraph,
  buildOrganizationGraph,
  hasContainmentCycle,
  projectCrossTeamRelations,
  projectOrgTeam,
  upsertOrganizationUnit,
} from '..';

import type { OrgRelationModel, OrgTeamCandidate } from '../models';

function buildTeam(overrides: Partial<OrgTeamCandidate> = {}): OrgTeamCandidate {
  return {
    teamName: 'alpha',
    displayName: 'Alpha',
    isOnline: true,
    members: [
      { name: 'lead', role: 'Lead' },
      { name: 'builder', role: 'Engineer' },
    ],
    tasks: [],
    ...overrides,
  };
}

describe('organizations domain', () => {
  it('projects active agent task summaries with caps', () => {
    const projected = projectOrgTeam(
      buildTeam({
        tasks: [
          {
            id: 'a',
            owner: 'builder',
            subject: 'newest active task',
            status: 'in_progress',
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            id: 'b',
            owner: 'builder',
            subject: 'older active task',
            status: 'in_progress',
            updatedAt: '2026-06-24T09:00:00.000Z',
          },
        ],
      }),
      { maxAgentsPerTeam: 4, maxTasksPerAgent: 1 }
    );

    const builder = projected.agents.find((agent) => agent.name === 'builder');
    expect(builder?.status).toBe('active');
    expect(builder?.activeTaskCount).toBe(2);
    expect(builder?.currentTasks).toHaveLength(1);
    expect(builder?.currentTasks[0]?.subject).toBe('newest active task');
  });

  it('prioritizes active members before applying the agent cap', () => {
    const projected = projectOrgTeam(
      buildTeam({
        members: [
          { name: 'lead', role: 'Lead' },
          { name: 'planner', role: 'Planner' },
          { name: 'builder', role: 'Engineer' },
        ],
        tasks: [
          {
            id: 'active-builder',
            owner: 'builder',
            subject: 'finish active implementation',
            status: 'in_progress',
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
        ],
      }),
      { maxAgentsPerTeam: 2, maxTasksPerAgent: 1 }
    );

    expect(projected.agents.map((agent) => agent.name)).toContain('builder');
    expect(projected.agents.find((agent) => agent.name === 'builder')?.currentTasks[0]?.id).toBe(
      'active-builder'
    );
    expect(projected.truncatedAgents).toBe(1);
  });

  it('rejects upserting organization root units', () => {
    expect(() =>
      upsertOrganizationUnit(
        {
          organizations: [
            {
              id: 'default',
              name: 'Default Org',
              rootNodeId: 'root',
            },
          ],
          units: [
            {
              id: 'root',
              organizationId: 'default',
              parentId: null,
              kind: 'organization',
              label: 'Default Org',
            },
          ],
        },
        {
          organizationId: 'default',
          id: 'root',
          kind: 'container',
          label: 'Corrupted Root',
          updatedAt: '2026-06-24T10:00:00.000Z',
        }
      )
    ).toThrow('Organization root units cannot be upserted.');
  });

  it('builds a default organization graph and truncates teams', () => {
    const graph = buildDefaultOrganizationGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 1,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      teams: [
        buildTeam({ teamName: 'offline', displayName: 'Offline', isOnline: false }),
        buildTeam({ teamName: 'online', displayName: 'Online', isOnline: true }),
      ],
    });

    expect(graph.nodes.map((node) => node.id)).toContain('org:default');
    expect(graph.renderedTeamNames).toEqual(['online']);
    expect(graph.truncatedTeams).toBe(1);
  });

  it('builds a flexible configured organization tree with unassigned teams', () => {
    const graph = buildOrganizationGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 4,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      teams: [
        buildTeam({ teamName: 'platform', displayName: 'Platform', isOnline: true }),
        buildTeam({ teamName: 'growth', displayName: 'Growth', isOnline: false }),
      ],
      structure: {
        organizations: [
          {
            id: 'default',
            name: 'Flexible Org',
            rootNodeId: 'root',
          },
        ],
        units: [
          {
            id: 'root',
            organizationId: 'default',
            parentId: null,
            kind: 'organization',
            label: 'Flexible Org',
          },
          {
            id: 'engineering',
            organizationId: 'default',
            parentId: 'root',
            kind: 'container',
            label: 'Engineering',
            tags: ['division'],
          },
          {
            id: 'platform-team',
            organizationId: 'default',
            parentId: 'engineering',
            kind: 'team',
            label: 'Platform Team',
            teamName: 'platform',
          },
        ],
      },
    });

    expect(graph.nodes.map((node) => [node.id, node.kind, node.parentNodeId])).toEqual(
      expect.arrayContaining([
        ['org:root', 'organization', null],
        ['unit:engineering', 'container', 'org:root'],
        ['team:platform', 'team', 'unit:engineering'],
        ['unit:default:unassigned-teams', 'container', 'org:root'],
        ['team:growth', 'team', 'unit:default:unassigned-teams'],
      ])
    );
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: 'unit:engineering',
          targetNodeId: 'team:platform',
          kind: 'contains',
        }),
      ])
    );
    const platformNode = graph.nodes.find((node) => node.id === 'team:platform');
    expect(platformNode?.label).toBe('Platform Team');
    expect(platformNode?.team?.teamName).toBe('platform');
    expect(platformNode?.team?.displayName).toBe('Platform Team');
    expect(graph.renderedTeamNames).toEqual(['platform', 'growth']);
  });

  it('shows teams assigned to other organizations as locally unassigned', () => {
    const graph = buildOrganizationGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 4,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      organizationId: 'default',
      teams: [
        buildTeam({ teamName: 'platform', displayName: 'Platform', isOnline: true }),
        buildTeam({ teamName: 'research', displayName: 'Research', isOnline: false }),
      ],
      structure: {
        organizations: [
          {
            id: 'default',
            name: 'Default Org',
            rootNodeId: 'org:default',
          },
          {
            id: 'labs',
            name: 'Labs Org',
            rootNodeId: 'org:labs',
          },
        ],
        units: [
          {
            id: 'org:default',
            organizationId: 'default',
            parentId: null,
            kind: 'organization',
            label: 'Default Org',
          },
          {
            id: 'team:platform',
            organizationId: 'default',
            parentId: 'org:default',
            kind: 'team',
            label: 'Platform Team',
          },
          {
            id: 'org:labs',
            organizationId: 'labs',
            parentId: null,
            kind: 'organization',
            label: 'Labs Org',
          },
          {
            id: 'team:research',
            organizationId: 'labs',
            parentId: 'org:labs',
            kind: 'team',
            label: 'Research Team',
          },
        ],
      },
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        'org:default',
        'team:platform',
        'unit:default:unassigned-teams',
        'team:research',
      ])
    );
    expect(graph.renderedTeamNames).toEqual(['platform', 'research']);
  });

  it('does not overwrite a configured unit when adding the unassigned teams bucket', () => {
    const graph = buildOrganizationGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 4,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      teams: [
        buildTeam({ teamName: 'platform', displayName: 'Platform', isOnline: true }),
        buildTeam({ teamName: 'growth', displayName: 'Growth', isOnline: false }),
      ],
      structure: {
        organizations: [
          {
            id: 'default',
            name: 'Flexible Org',
            rootNodeId: 'root',
          },
        ],
        units: [
          {
            id: 'root',
            organizationId: 'default',
            parentId: null,
            kind: 'organization',
            label: 'Flexible Org',
          },
          {
            id: 'unit:default:unassigned-teams',
            organizationId: 'default',
            parentId: 'root',
            kind: 'container',
            label: 'Manual Holding Area',
          },
          {
            id: 'platform-slot',
            organizationId: 'default',
            parentId: 'unit:default:unassigned-teams',
            kind: 'team',
            label: 'Platform Team',
            teamName: 'platform',
          },
        ],
      },
    });

    expect(graph.nodes.map((node) => [node.id, node.label, node.parentNodeId])).toEqual(
      expect.arrayContaining([
        ['unit:default:unassigned-teams', 'Manual Holding Area', 'org:root'],
        ['team:platform', 'Platform Team', 'unit:default:unassigned-teams'],
        ['unit:default:unassigned-teams-2', 'Unassigned Teams', 'org:root'],
        ['team:growth', 'Growth', 'unit:default:unassigned-teams-2'],
      ])
    );
    expect(graph.renderedTeamNames).toEqual(['platform', 'growth']);
  });

  it('resolves prefixed team unit ids as team references when teamName is omitted', () => {
    const graph = buildOrganizationGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 4,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      teams: [buildTeam({ teamName: 'platform', displayName: 'Platform', isOnline: true })],
      structure: {
        organizations: [
          {
            id: 'default',
            name: 'Flexible Org',
            rootNodeId: 'root',
          },
        ],
        units: [
          {
            id: 'root',
            organizationId: 'default',
            parentId: null,
            kind: 'organization',
            label: 'Flexible Org',
          },
          {
            id: 'team:platform',
            organizationId: 'default',
            parentId: 'root',
            kind: 'team',
            label: 'Platform Team',
          },
        ],
      },
    });

    expect(graph.nodes.map((node) => [node.id, node.label, Boolean(node.team)])).toEqual(
      expect.arrayContaining([['team:platform', 'Platform Team', true]])
    );
    expect(graph.nodes.map((node) => node.id)).not.toContain('team:team:platform');
    expect(graph.renderedTeamNames).toEqual(['platform']);
    expect(graph.truncatedTeams).toBe(0);
  });

  it('builds an all-organizations graph with scoped containers and global team links', () => {
    const graph = buildAllOrganizationsGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 10,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      teams: [
        buildTeam({ teamName: 'platform', displayName: 'Platform', isOnline: true }),
        buildTeam({ teamName: 'growth', displayName: 'Growth', isOnline: true }),
        buildTeam({ teamName: 'qa', displayName: 'QA', isOnline: false }),
      ],
      structure: {
        organizations: [
          {
            id: 'product',
            name: 'Product Org',
            rootNodeId: 'root',
          },
          {
            id: 'quality',
            name: 'Quality Org',
            rootNodeId: 'root',
          },
        ],
        units: [
          {
            id: 'root',
            organizationId: 'product',
            parentId: null,
            kind: 'organization',
            label: 'Product Org',
          },
          {
            id: 'group',
            organizationId: 'product',
            parentId: 'root',
            kind: 'container',
            label: 'Shared Group Name',
          },
          {
            id: 'platform-slot',
            organizationId: 'product',
            parentId: 'group',
            kind: 'team',
            label: 'Platform Team',
            teamName: 'platform',
          },
          {
            id: 'root',
            organizationId: 'quality',
            parentId: null,
            kind: 'organization',
            label: 'Quality Org',
          },
          {
            id: 'group',
            organizationId: 'quality',
            parentId: 'root',
            kind: 'container',
            label: 'Shared Group Name',
          },
          {
            id: 'growth-slot',
            organizationId: 'quality',
            parentId: 'group',
            kind: 'team',
            label: 'Growth Team',
            teamName: 'growth',
          },
        ],
        relations: [
          {
            sourceNodeId: 'platform',
            targetNodeId: 'growth',
            kind: 'depends_on',
            sourceKind: 'manual',
          },
        ],
      },
    });

    expect(graph.organization.rootNodeId).toBe('org:__all-organizations__');
    expect(graph.nodes.map((node) => [node.id, node.kind, node.parentNodeId])).toEqual(
      expect.arrayContaining([
        ['org:product', 'organization', 'org:__all-organizations__'],
        ['org:quality', 'organization', 'org:__all-organizations__'],
        ['unit:product:group', 'container', 'org:product'],
        ['unit:quality:group', 'container', 'org:quality'],
        ['unit:product:platform-slot', 'team', 'unit:product:group'],
        ['unit:quality:growth-slot', 'team', 'unit:quality:group'],
        ['unit:__all-organizations__:unassigned-teams', 'container', 'org:__all-organizations__'],
        ['team:qa', 'team', 'unit:__all-organizations__:unassigned-teams'],
      ])
    );
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: 'unit:product:platform-slot',
          targetNodeId: 'unit:quality:growth-slot',
          kind: 'depends_on',
        }),
      ])
    );
    expect(graph.renderedTeamNames).toEqual(['platform', 'growth', 'qa']);
  });

  it('builds nested organization hierarchy in all-organizations scope', () => {
    const graph = buildAllOrganizationsGraph({
      generatedAt: '2026-06-24T10:00:00.000Z',
      maxTeams: 10,
      maxAgentsPerTeam: 3,
      maxTasksPerAgent: 1,
      teams: [
        buildTeam({ teamName: 'platform', displayName: 'Platform', isOnline: true }),
        buildTeam({ teamName: 'growth', displayName: 'Growth', isOnline: true }),
      ],
      structure: {
        organizations: [
          {
            id: 'holding',
            name: 'Holding Org',
            rootNodeId: 'holding:root',
          },
          {
            id: 'product',
            name: 'Product Org',
            rootNodeId: 'product:root',
            parentOrganizationId: 'holding',
          },
        ],
        units: [
          {
            id: 'holding:root',
            organizationId: 'holding',
            parentId: null,
            kind: 'organization',
            label: 'Holding Org',
          },
          {
            id: 'team:growth',
            organizationId: 'holding',
            parentId: 'holding:root',
            kind: 'team',
            label: 'Growth Team',
          },
          {
            id: 'product:root',
            organizationId: 'product',
            parentId: null,
            kind: 'organization',
            label: 'Product Org',
          },
          {
            id: 'team:platform',
            organizationId: 'product',
            parentId: 'product:root',
            kind: 'team',
            label: 'Platform Team',
          },
        ],
      },
    });

    expect(graph.nodes.map((node) => [node.id, node.kind, node.parentNodeId])).toEqual(
      expect.arrayContaining([
        ['org:holding', 'organization', 'org:__all-organizations__'],
        ['org:product', 'organization', 'org:holding'],
        ['unit:holding:team:growth', 'team', 'org:holding'],
        ['unit:product:team:platform', 'team', 'org:product'],
      ])
    );
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: 'org:holding',
          targetNodeId: 'org:product',
          kind: 'contains',
        }),
      ])
    );
  });

  it('dedupes and aggregates cross-team relations', () => {
    const result = projectCrossTeamRelations({
      visibleTeamNames: new Set(['alpha', 'beta']),
      maxMessages: 10,
      messages: [
        {
          messageId: 'm1',
          fromTeam: 'alpha',
          toTeam: 'beta',
          summary: 'handoff',
          timestamp: '2026-06-24T10:00:00.000Z',
        },
        {
          messageId: 'm1',
          fromTeam: 'alpha',
          toTeam: 'beta',
          summary: 'duplicate',
          timestamp: '2026-06-24T10:01:00.000Z',
        },
        {
          messageId: 'm2',
          fromTeam: 'alpha',
          toTeam: 'beta',
          summary: 'newer',
          timestamp: '2026-06-24T10:02:00.000Z',
        },
      ],
    });

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.messageCount).toBe(2);
    expect(result.relations[0]?.latestMessagePreview).toBe('newer');
  });

  it('detects containment cycles', () => {
    const relations: OrgRelationModel[] = [
      {
        id: 'ab',
        sourceNodeId: 'a',
        targetNodeId: 'b',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'ba',
        sourceNodeId: 'b',
        targetNodeId: 'a',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
    ];

    expect(hasContainmentCycle(relations)).toBe(true);
  });
});
