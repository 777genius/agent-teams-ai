import { GetOrganizationMapUseCase } from '../GetOrganizationMapUseCase';

import type { OrgTeamCandidate } from '../../domain';
import type { OrganizationsLoggerPort } from '../ports';

const logger: OrganizationsLoggerPort = {
  warn: vi.fn(),
  error: vi.fn(),
};

function request() {
  return {
    scope: 'organization' as const,
    includeDeletedTeams: false,
    maxTeams: 20,
    maxAgentsPerTeam: 4,
    maxTasksPerAgent: 2,
    maxCrossTeamMessages: 20,
  };
}

describe('GetOrganizationMapUseCase', () => {
  it('combines teams and cross-team messages into one map payload', async () => {
    const team: OrgTeamCandidate = {
      teamName: 'alpha',
      displayName: 'Alpha',
      isOnline: true,
      members: [{ name: 'lead' }],
      tasks: [],
    };
    const useCase = new GetOrganizationMapUseCase({
      structure: { loadStructure: async () => null, saveStructure: async (structure) => structure },
      teamDirectory: { listTeams: async () => [team] },
      crossTeamMessages: { listRecentMessages: async () => [] },
      clock: { now: () => Date.parse('2026-06-24T10:00:00.000Z') },
      logger,
    });

    const payload = await useCase.execute(request());

    expect(payload.activeOrganizationId).toBe('default');
    expect(payload.nodes.some((node) => node.id === 'team:alpha')).toBe(true);
    expect(payload.diagnostics.renderedTeams).toBe(1);
    expect(payload.degraded).toBe(false);
  });

  it('degrades instead of failing when cross-team messages cannot be read', async () => {
    const useCase = new GetOrganizationMapUseCase({
      structure: { loadStructure: async () => null, saveStructure: async (structure) => structure },
      teamDirectory: {
        listTeams: async () => [
          {
            teamName: 'alpha',
            displayName: 'Alpha',
            isOnline: true,
            members: [{ name: 'lead' }],
            tasks: [],
          },
        ],
      },
      crossTeamMessages: {
        listRecentMessages: async () => {
          throw new Error('outbox failed');
        },
      },
      clock: { now: () => Date.parse('2026-06-24T10:00:00.000Z') },
      logger,
    });

    const payload = await useCase.execute(request());

    expect(payload.degraded).toBe(true);
    expect(payload.diagnostics.warnings).toContain('Failed to load cross-team communication.');
    expect(payload.nodes).toHaveLength(2);
  });

  it('uses configured organization structure when it is available', async () => {
    const useCase = new GetOrganizationMapUseCase({
      structure: {
        saveStructure: async (structure) => structure,
        loadStructure: async () => ({
          organizations: [
            {
              id: 'default',
              name: 'Product Org',
              rootNodeId: 'root',
            },
          ],
          units: [
            {
              id: 'root',
              organizationId: 'default',
              parentId: null,
              kind: 'organization',
              label: 'Product Org',
            },
            {
              id: 'product',
              organizationId: 'default',
              parentId: 'root',
              kind: 'container',
              label: 'Product',
            },
            {
              id: 'alpha-slot',
              organizationId: 'default',
              parentId: 'product',
              kind: 'team',
              label: 'Alpha Slot',
              teamName: 'alpha',
            },
          ],
        }),
      },
      teamDirectory: {
        listTeams: async () => [
          {
            teamName: 'alpha',
            displayName: 'Alpha',
            isOnline: true,
            members: [{ name: 'lead' }],
            tasks: [],
          },
        ],
      },
      crossTeamMessages: { listRecentMessages: async () => [] },
      clock: { now: () => Date.parse('2026-06-24T10:00:00.000Z') },
      logger,
    });

    const payload = await useCase.execute(request());

    expect(payload.organizations[0]?.name).toBe('Product Org');
    expect(payload.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'unit:product', kind: 'container' }),
        expect.objectContaining({
          id: 'team:alpha',
          kind: 'team',
          parentNodeId: 'unit:product',
        }),
      ])
    );
  });

  it('keeps organization summaries while rendering the requested organization', async () => {
    const useCase = new GetOrganizationMapUseCase({
      structure: {
        saveStructure: async (structure) => structure,
        loadStructure: async () => ({
          organizations: [
            {
              id: 'default',
              name: 'Default Org',
              rootNodeId: 'default-root',
            },
            {
              id: 'client',
              name: 'Client Org',
              rootNodeId: 'client-root',
            },
          ],
          units: [
            {
              id: 'default-root',
              organizationId: 'default',
              parentId: null,
              kind: 'organization',
              label: 'Default Org',
            },
            {
              id: 'client-root',
              organizationId: 'client',
              parentId: null,
              kind: 'organization',
              label: 'Client Org',
            },
            {
              id: 'client-alpha',
              organizationId: 'client',
              parentId: 'client-root',
              kind: 'team',
              label: 'Client Alpha',
              teamName: 'alpha',
            },
          ],
        }),
      },
      teamDirectory: {
        listTeams: async () => [
          {
            teamName: 'alpha',
            displayName: 'Alpha',
            isOnline: true,
            members: [{ name: 'lead' }],
            tasks: [],
          },
        ],
      },
      crossTeamMessages: { listRecentMessages: async () => [] },
      clock: { now: () => Date.parse('2026-06-24T10:00:00.000Z') },
      logger,
    });

    const payload = await useCase.execute({ ...request(), organizationId: 'client' });

    expect(payload.activeOrganizationId).toBe('client');
    expect(payload.organizations.map((organization) => organization.id)).toEqual([
      'default',
      'client',
    ]);
    expect(
      payload.organizations.find((organization) => organization.id === 'client')?.rootNodeId
    ).toBe('org:client-root');
    expect(payload.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'org:client-root', kind: 'organization' }),
        expect.objectContaining({ id: 'team:alpha', parentNodeId: 'org:client-root' }),
      ])
    );
  });

  it('renders all configured organizations in all scope', async () => {
    const useCase = new GetOrganizationMapUseCase({
      structure: {
        saveStructure: async (structure) => structure,
        loadStructure: async () => ({
          organizations: [
            {
              id: 'product',
              name: 'Product Org',
              rootNodeId: 'product-root',
            },
            {
              id: 'quality',
              name: 'Quality Org',
              rootNodeId: 'quality-root',
            },
          ],
          units: [
            {
              id: 'product-root',
              organizationId: 'product',
              parentId: null,
              kind: 'organization',
              label: 'Product Org',
            },
            {
              id: 'platform-slot',
              organizationId: 'product',
              parentId: 'product-root',
              kind: 'team',
              label: 'Platform Team',
              teamName: 'platform',
            },
            {
              id: 'quality-root',
              organizationId: 'quality',
              parentId: null,
              kind: 'organization',
              label: 'Quality Org',
            },
            {
              id: 'qa-slot',
              organizationId: 'quality',
              parentId: 'quality-root',
              kind: 'team',
              label: 'QA Team',
              teamName: 'qa',
            },
          ],
        }),
      },
      teamDirectory: {
        listTeams: async () => [
          {
            teamName: 'platform',
            displayName: 'Platform',
            isOnline: true,
            members: [{ name: 'lead' }],
            tasks: [],
          },
          {
            teamName: 'qa',
            displayName: 'QA',
            isOnline: false,
            members: [{ name: 'tester' }],
            tasks: [],
          },
        ],
      },
      crossTeamMessages: {
        listRecentMessages: async () => [
          {
            fromTeam: 'platform',
            toTeam: 'qa',
            summary: 'Please verify release',
            timestamp: '2026-06-24T10:00:00.000Z',
          },
        ],
      },
      clock: { now: () => Date.parse('2026-06-24T10:00:00.000Z') },
      logger,
    });

    const payload = await useCase.execute({ ...request(), scope: 'all' });

    expect(payload.scope).toBe('all');
    expect(payload.rootNodeId).toBe('org:__all-organizations__');
    expect(
      payload.organizations.map((organization) => [organization.id, organization.rootNodeId])
    ).toEqual([
      ['product', 'org:product'],
      ['quality', 'org:quality'],
    ]);
    expect(payload.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'org:__all-organizations__', kind: 'organization' }),
        expect.objectContaining({ id: 'org:product', parentNodeId: 'org:__all-organizations__' }),
        expect.objectContaining({ id: 'org:quality', parentNodeId: 'org:__all-organizations__' }),
        expect.objectContaining({ id: 'unit:product:platform-slot', parentNodeId: 'org:product' }),
        expect.objectContaining({ id: 'unit:quality:qa-slot', parentNodeId: 'org:quality' }),
      ])
    );
    expect(payload.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: 'team:platform',
          targetNodeId: 'team:qa',
          kind: 'communicates',
          sourceKind: 'runtime',
        }),
      ])
    );
  });
});
