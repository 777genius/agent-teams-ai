import { ManageOrganizationStructureUseCase } from '../ManageOrganizationStructureUseCase';

import type { OrgStructureModel, OrgTeamCandidate } from '../../domain';
import type { OrganizationsLoggerPort } from '../ports';

const logger: OrganizationsLoggerPort = {
  warn: vi.fn(),
  error: vi.fn(),
};

const teams: OrgTeamCandidate[] = [
  {
    teamName: 'platform',
    displayName: 'Platform',
    isOnline: true,
    members: [{ name: 'lead' }],
    tasks: [],
  },
  {
    teamName: 'growth',
    displayName: 'Growth',
    isOnline: false,
    members: [{ name: 'lead' }],
    tasks: [],
  },
];

function createUseCase(initialStructure: OrgStructureModel | null = null): {
  useCase: ManageOrganizationStructureUseCase;
  getStored: () => OrgStructureModel | null;
} {
  let stored = initialStructure;
  return {
    useCase: new ManageOrganizationStructureUseCase({
      structure: {
        loadStructure: async () => stored,
        saveStructure: async (structure) => {
          stored = structure;
          return structure;
        },
      },
      teamDirectory: { listTeams: async () => teams },
      clock: { now: () => Date.parse('2026-06-24T10:00:00.000Z') },
      logger,
    }),
    getStored: () => stored,
  };
}

describe('ManageOrganizationStructureUseCase', () => {
  it('generates an editable default structure from existing teams', async () => {
    const { useCase } = createUseCase();

    const payload = await useCase.getStructure();

    expect(payload.source).toBe('generated');
    expect(payload.activeOrganizationId).toBe('default');
    expect(payload.units.map((unit) => [unit.id, unit.kind, unit.parentId])).toEqual(
      expect.arrayContaining([
        ['default:root', 'organization', null],
        ['team:platform', 'team', 'default:root'],
        ['team:growth', 'team', 'default:root'],
      ])
    );
    expect(payload.availableTeams.map((team) => team.teamName)).toEqual(['platform', 'growth']);
  });

  it('assigns a team to a container without creating duplicate team units', async () => {
    const { useCase, getStored } = createUseCase();
    await useCase.upsertUnit({
      organizationId: 'default',
      parentId: 'default:root',
      kind: 'container',
      label: 'Engineering',
    });

    const payload = await useCase.assignTeam({
      organizationId: 'default',
      parentUnitId: 'unit:default:Engineering',
      teamName: 'platform',
      label: 'Platform Team',
    });

    const platformUnits = payload.units.filter((unit) => unit.teamName === 'platform');
    expect(platformUnits).toHaveLength(1);
    expect(platformUnits[0]?.parentId).toBe('unit:default:Engineering');
    expect(getStored()?.updatedAt).toBe('2026-06-24T10:00:00.000Z');
  });

  it('adds a missing root unit for configured structures', async () => {
    const { useCase } = createUseCase({
      organizations: [{ id: 'default', name: 'Default Org', rootNodeId: 'missing-root' }],
      units: [],
      relations: [],
    });

    const payload = await useCase.getStructure();

    expect(payload.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'missing-root',
          organizationId: 'default',
          kind: 'organization',
          parentId: null,
        }),
      ])
    );
  });

  it('returns a newly created organization as the active editable organization', async () => {
    const { useCase } = createUseCase({
      organizations: [{ id: 'default', name: 'Default Org', rootNodeId: 'default:root' }],
      units: [
        {
          id: 'default:root',
          organizationId: 'default',
          parentId: null,
          kind: 'organization',
          label: 'Default Org',
        },
      ],
      relations: [],
    });

    const payload = await useCase.createOrganization({
      name: 'Client Org',
      parentOrganizationId: 'default',
    });

    expect(payload.activeOrganizationId).toBe('Client-Org');
    expect(payload.organizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'Client-Org',
          parentOrganizationId: 'default',
        }),
      ])
    );
    expect(payload.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'Client-Org:root',
          organizationId: 'Client-Org',
          kind: 'organization',
          parentId: null,
        }),
      ])
    );
  });

  it('does not persist the generated All Teams fallback when creating the first root organization', async () => {
    const { useCase, getStored } = createUseCase();

    const payload = await useCase.createOrganization({
      id: 'client',
      name: 'Client Org',
    });

    expect(payload.activeOrganizationId).toBe('client');
    expect(payload.organizations.map((organization) => organization.id)).toEqual(['client']);
    expect(payload.units.map((unit) => [unit.id, unit.kind, unit.teamName])).toEqual([
      ['client:root', 'organization', undefined],
    ]);
    expect(getStored()?.organizations.map((organization) => organization.id)).toEqual(['client']);
  });

  it('prevents moving a unit under its own descendant', async () => {
    const { useCase } = createUseCase();
    await useCase.upsertUnit({
      organizationId: 'default',
      parentId: 'default:root',
      kind: 'container',
      label: 'Engineering',
    });
    await useCase.upsertUnit({
      organizationId: 'default',
      parentId: 'unit:default:Engineering',
      kind: 'container',
      label: 'Platform Area',
    });

    await expect(
      useCase.moveUnit({
        unitId: 'unit:default:Engineering',
        parentId: 'unit:default:Platform-Area',
      })
    ).rejects.toThrow('Cannot move a unit under itself or one of its descendants.');
  });

  it('preserves same manual relation ids in different organizations', async () => {
    const { useCase, getStored } = createUseCase({
      organizations: [
        { id: 'default', name: 'Default Org', rootNodeId: 'default:root' },
        { id: 'client', name: 'Client Org', rootNodeId: 'client:root' },
      ],
      units: [
        {
          id: 'default:root',
          organizationId: 'default',
          parentId: null,
          kind: 'organization',
          label: 'Default Org',
        },
        {
          id: 'client:root',
          organizationId: 'client',
          parentId: null,
          kind: 'organization',
          label: 'Client Org',
        },
      ],
      relations: [],
    });

    await useCase.upsertRelation({
      organizationId: 'default',
      sourceNodeId: 'platform',
      targetNodeId: 'growth',
      kind: 'depends_on',
    });
    await useCase.upsertRelation({
      organizationId: 'client',
      sourceNodeId: 'platform',
      targetNodeId: 'growth',
      kind: 'depends_on',
    });

    expect(getStored()?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: 'default' }),
        expect.objectContaining({ organizationId: 'client' }),
      ])
    );
    expect(getStored()?.relations).toHaveLength(2);
  });

  it('removes manual team relations when a team is removed from an organization', async () => {
    const { useCase, getStored } = createUseCase({
      organizations: [{ id: 'default', name: 'Default Org', rootNodeId: 'default:root' }],
      units: [
        {
          id: 'default:root',
          organizationId: 'default',
          parentId: null,
          kind: 'organization',
          label: 'Default Org',
        },
        {
          id: 'team:platform',
          organizationId: 'default',
          parentId: 'default:root',
          kind: 'team',
          label: 'Platform',
          teamName: 'platform',
        },
        {
          id: 'team:growth',
          organizationId: 'default',
          parentId: 'default:root',
          kind: 'team',
          label: 'Growth',
          teamName: 'growth',
        },
      ],
      relations: [
        {
          id: 'rel:depends_on:platform->growth',
          organizationId: 'default',
          sourceNodeId: 'platform',
          targetNodeId: 'growth',
          kind: 'depends_on',
          sourceKind: 'manual',
        },
      ],
    });

    await useCase.removeTeam({ organizationId: 'default', teamName: 'platform' });

    expect(getStored()?.units.map((unit) => unit.id)).toEqual(['default:root', 'team:growth']);
    expect(getStored()?.relations).toEqual([]);
  });

  it('removes manual unit relations when a container is removed', async () => {
    const { useCase, getStored } = createUseCase({
      organizations: [{ id: 'default', name: 'Default Org', rootNodeId: 'default:root' }],
      units: [
        {
          id: 'default:root',
          organizationId: 'default',
          parentId: null,
          kind: 'organization',
          label: 'Default Org',
        },
        {
          id: 'engineering',
          organizationId: 'default',
          parentId: 'default:root',
          kind: 'container',
          label: 'Engineering',
        },
      ],
      relations: [
        {
          id: 'rel:observes:unit:engineering->team:growth',
          organizationId: 'default',
          sourceNodeId: 'unit:engineering',
          targetNodeId: 'team:growth',
          kind: 'observes',
          sourceKind: 'manual',
        },
      ],
    });

    await useCase.removeUnit({ organizationId: 'default', unitId: 'engineering' });

    expect(getStored()?.units.map((unit) => unit.id)).toEqual(['default:root']);
    expect(getStored()?.relations).toEqual([]);
  });

  it('removes duplicate-id containers only inside the requested organization', async () => {
    const { useCase, getStored } = createUseCase({
      organizations: [
        { id: 'product', name: 'Product Org', rootNodeId: 'root' },
        { id: 'quality', name: 'Quality Org', rootNodeId: 'root' },
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
          label: 'Shared Group',
        },
        {
          id: 'platform-slot',
          organizationId: 'product',
          parentId: 'group',
          kind: 'team',
          label: 'Platform',
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
          label: 'Shared Group',
        },
        {
          id: 'growth-slot',
          organizationId: 'quality',
          parentId: 'group',
          kind: 'team',
          label: 'Growth',
          teamName: 'growth',
        },
      ],
      relations: [
        {
          id: 'rel:observes:group->platform',
          organizationId: 'product',
          sourceNodeId: 'group',
          targetNodeId: 'platform',
          kind: 'observes',
          sourceKind: 'manual',
        },
        {
          id: 'rel:observes:group->growth',
          organizationId: 'quality',
          sourceNodeId: 'group',
          targetNodeId: 'growth',
          kind: 'observes',
          sourceKind: 'manual',
        },
      ],
    });

    await useCase.removeUnit({ organizationId: 'product', unitId: 'group', cascade: true });

    expect(getStored()?.units.map((unit) => [unit.organizationId, unit.id])).toEqual([
      ['product', 'root'],
      ['quality', 'root'],
      ['quality', 'group'],
      ['quality', 'growth-slot'],
    ]);
    expect(getStored()?.relations).toEqual([
      expect.objectContaining({
        id: 'rel:observes:group->growth',
        organizationId: 'quality',
      }),
    ]);
  });

  it('removes duplicate team unit ids only from the requested organization', async () => {
    const { useCase, getStored } = createUseCase({
      organizations: [
        { id: 'product', name: 'Product Org', rootNodeId: 'product:root' },
        { id: 'quality', name: 'Quality Org', rootNodeId: 'quality:root' },
      ],
      units: [
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
          label: 'Platform',
          teamName: 'platform',
        },
        {
          id: 'quality:root',
          organizationId: 'quality',
          parentId: null,
          kind: 'organization',
          label: 'Quality Org',
        },
        {
          id: 'team:platform',
          organizationId: 'quality',
          parentId: 'quality:root',
          kind: 'team',
          label: 'Platform QA',
          teamName: 'platform',
        },
      ],
      relations: [
        {
          id: 'rel:observes:platform->growth',
          organizationId: 'quality',
          sourceNodeId: 'platform',
          targetNodeId: 'growth',
          kind: 'observes',
          sourceKind: 'manual',
        },
      ],
    });

    await useCase.removeTeam({ organizationId: 'product', teamName: 'platform' });

    expect(getStored()?.units.map((unit) => [unit.organizationId, unit.id])).toEqual([
      ['product', 'product:root'],
      ['quality', 'quality:root'],
      ['quality', 'team:platform'],
    ]);
    expect(getStored()?.relations).toEqual([
      expect.objectContaining({
        id: 'rel:observes:platform->growth',
        organizationId: 'quality',
      }),
    ]);
  });
});
