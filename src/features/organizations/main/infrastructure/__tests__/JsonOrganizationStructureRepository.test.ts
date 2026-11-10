import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setAppDataBasePath } from '@main/utils/pathDecoder';

import { JsonOrganizationStructureRepository } from '../JsonOrganizationStructureRepository';

import type { OrganizationsLoggerPort } from '../../../core/application';

const logger: OrganizationsLoggerPort = {
  warn: vi.fn(),
  error: vi.fn(),
};

describe('JsonOrganizationStructureRepository', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'org-structure-'));
    setAppDataBasePath(tempDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    setAppDataBasePath(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when no organization map exists', async () => {
    const repository = new JsonOrganizationStructureRepository(logger);

    await expect(repository.loadStructure()).resolves.toBeNull();
  });

  it('normalizes organizations, units, and flexible relation aliases', async () => {
    const repository = new JsonOrganizationStructureRepository(logger);
    const organizationsDir = path.join(tempDir, 'data', 'organizations');
    await mkdir(organizationsDir, { recursive: true });
    await writeFile(
      path.join(organizationsDir, 'map.json'),
      JSON.stringify({
        organizations: [
          { id: 'default', name: 'Default Org', rootUnitId: 'root' },
          {
            id: 'client',
            name: 'Client Org',
            rootUnitId: 'client-root',
            parentOrganizationId: 'default',
          },
        ],
        units: [
          { id: 'root', kind: 'organization', label: 'Default Org' },
          { id: 'engineering', parentId: 'root', kind: 'container', label: 'Engineering' },
          {
            id: 'platform-slot',
            parentUnitId: 'engineering',
            kind: 'team',
            label: 'Platform',
            teamName: 'platform team',
            tags: ['delivery'],
          },
        ],
        relations: [
          {
            sourceTeamName: 'platform team',
            targetTeamName: 'growth',
            kind: 'depends_on',
          },
        ],
      })
    );

    const structure = await repository.loadStructure();

    expect(structure?.organizations[0]).toEqual(
      expect.objectContaining({
        id: 'default',
        name: 'Default Org',
        rootNodeId: 'root',
      })
    );
    expect(structure?.organizations[1]).toEqual(
      expect.objectContaining({
        id: 'client',
        parentOrganizationId: 'default',
      })
    );
    expect(structure?.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'platform-slot',
          parentId: 'engineering',
          kind: 'team',
          teamName: 'platform team',
          tags: ['delivery'],
        }),
      ])
    );
    expect(structure?.relations).toEqual([
      expect.objectContaining({
        sourceNodeId: 'platform team',
        targetNodeId: 'growth',
        kind: 'depends_on',
        sourceKind: 'manual',
      }),
    ]);
  });

  it('saves the editable organization structure as map JSON', async () => {
    const repository = new JsonOrganizationStructureRepository(logger);

    await repository.saveStructure({
      organizations: [
        {
          id: 'default',
          name: 'Default Org',
          rootNodeId: 'default:root',
          parentOrganizationId: null,
        },
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
          id: 'team:platform',
          organizationId: 'default',
          parentId: 'default:root',
          kind: 'team',
          label: 'Platform',
          teamName: 'platform',
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
          weight: 1,
        },
      ],
      updatedAt: '2026-06-24T10:00:00.000Z',
    });

    const raw = await readFile(path.join(tempDir, 'data', 'organizations', 'map.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        organizations: [
          expect.objectContaining({
            id: 'default',
            parentOrganizationId: null,
          }),
        ],
        updatedAt: '2026-06-24T10:00:00.000Z',
      })
    );
    const loaded = await repository.loadStructure();
    expect(loaded?.units.map((unit) => unit.id)).toEqual(['default:root', 'team:platform']);
  });
});
