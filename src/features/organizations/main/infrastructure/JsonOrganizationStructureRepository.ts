import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as path from 'path';

import { normalizeOrganizationId } from '../../core/domain';

import type { OrganizationsLoggerPort, OrganizationsStructurePort } from '../../core/application';
import type {
  OrgNodeKind,
  OrgRelationDefinitionModel,
  OrgRelationSourceKind,
  OrgStructureModel,
  OrgSummaryModel,
  OrgUnitModel,
} from '../../core/domain';

const ORGANIZATION_STRUCTURE_FILE = 'map.json';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(record: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter((entry): entry is string => typeof entry === 'string');
  return result.length > 0 ? result : undefined;
}

function normalizeNodeKind(value: unknown): OrgNodeKind {
  if (value === 'organization' || value === 'team' || value === 'container') {
    return value;
  }
  return 'container';
}

function normalizeSourceKind(value: unknown): OrgRelationSourceKind {
  if (value === 'manual' || value === 'inferred' || value === 'runtime') {
    return value;
  }
  return 'manual';
}

function encodeRelationIdPart(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%/g, '~');
}

function getImportedRelationId(params: {
  organizationId: string | undefined;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  sourceKind: OrgRelationSourceKind;
  label: string | undefined;
}): string {
  return [
    'relation',
    params.organizationId ?? 'unscoped',
    params.sourceKind,
    params.kind,
    params.sourceNodeId,
    params.targetNodeId,
    params.label ?? '',
  ]
    .map(encodeRelationIdPart)
    .join(':');
}

function normalizeOrganization(value: unknown): OrgSummaryModel | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = normalizeOrganizationId(readString(record, ['id', 'organizationId']), '');
  if (!id) return null;

  const name = readString(record, ['name', 'label']) ?? id;
  const rootNodeId =
    readString(record, ['rootNodeId', 'rootUnitId']) ?? `org:${normalizeOrganizationId(id)}`;
  const parentOrganizationId = normalizeOrganizationId(
    readString(record, ['parentOrganizationId', 'parentOrgId']),
    ''
  );

  return {
    id,
    name,
    description: readString(record, ['description']),
    rootNodeId,
    parentOrganizationId: parentOrganizationId || null,
    updatedAt: readString(record, ['updatedAt']),
  };
}

function normalizeUnit(value: unknown, fallbackOrganizationId: string): OrgUnitModel | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readString(record, ['id', 'unitId', 'nodeId']);
  if (!id) return null;

  const kind = normalizeNodeKind(record.kind ?? record.nodeType);
  const teamName = readString(record, ['teamName', 'teamId']);
  const label = readString(record, ['label', 'name', 'title']) ?? teamName ?? id;
  const organizationId = normalizeOrganizationId(
    readString(record, ['organizationId']),
    fallbackOrganizationId
  );
  const parentId = readString(record, ['parentId', 'parentUnitId', 'reportsTo']) ?? null;

  return {
    id,
    organizationId,
    parentId,
    kind,
    label,
    description: readString(record, ['description']),
    color: readString(record, ['color']),
    teamName,
    title: readString(record, ['title']),
    tags: readStringArray(record.tags),
  };
}

function normalizeRelation(
  value: unknown,
  fallbackOrganizationId: string
): OrgRelationDefinitionModel | null {
  const record = asRecord(value);
  if (!record) return null;

  const sourceNodeId = readString(record, ['sourceNodeId', 'sourceUnitId', 'sourceTeamName']);
  const targetNodeId = readString(record, ['targetNodeId', 'targetUnitId', 'targetTeamName']);
  const kind = readString(record, ['kind', 'type']);
  if (!sourceNodeId || !targetNodeId || !kind) return null;

  const weight =
    typeof record.weight === 'number' && Number.isFinite(record.weight) ? record.weight : undefined;
  const rawOrganizationId = readString(record, ['organizationId']);
  const organizationId = rawOrganizationId
    ? normalizeOrganizationId(rawOrganizationId, fallbackOrganizationId)
    : undefined;
  const sourceKind = normalizeSourceKind(record.sourceKind ?? record.source);
  const label = readString(record, ['label']);

  return {
    id:
      readString(record, ['id']) ??
      getImportedRelationId({
        organizationId,
        sourceNodeId,
        targetNodeId,
        kind,
        sourceKind,
        label,
      }),
    organizationId,
    sourceNodeId,
    targetNodeId,
    kind,
    sourceKind,
    weight,
    label,
  };
}

function normalizeStructurePayload(value: unknown): OrgStructureModel | null {
  const record = asRecord(value);
  if (!record) return null;

  const organizations = Array.isArray(record.organizations)
    ? record.organizations
        .map(normalizeOrganization)
        .filter((item): item is OrgSummaryModel => item !== null)
    : [];
  const fallbackOrganizationId = organizations[0]?.id ?? 'default';
  const units = Array.isArray(record.units)
    ? record.units
        .map((unit) => normalizeUnit(unit, fallbackOrganizationId))
        .filter((item): item is OrgUnitModel => item !== null)
    : [];
  const relations = Array.isArray(record.relations)
    ? record.relations
        .map((relation) => normalizeRelation(relation, fallbackOrganizationId))
        .filter((item): item is OrgRelationDefinitionModel => item !== null)
    : [];

  if (organizations.length === 0 && units.length === 0) {
    return null;
  }

  return {
    organizations:
      organizations.length > 0
        ? organizations
        : [
            {
              id: fallbackOrganizationId,
              name: 'Default Organization',
              rootNodeId: `org:${fallbackOrganizationId}`,
            },
          ],
    units,
    relations,
    updatedAt: readString(record, ['updatedAt']),
  };
}

function getStructureFilePath(): string {
  return path.join(getAppDataPath(), 'organizations', ORGANIZATION_STRUCTURE_FILE);
}

export class JsonOrganizationStructureRepository implements OrganizationsStructurePort {
  constructor(private readonly logger: OrganizationsLoggerPort) {}

  async loadStructure(): Promise<OrgStructureModel | null> {
    const filePath = getStructureFilePath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    try {
      return normalizeStructurePayload(JSON.parse(raw));
    } catch (error) {
      this.logger.warn('organizations structure JSON parse failed', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async saveStructure(structure: OrgStructureModel): Promise<OrgStructureModel> {
    const filePath = getStructureFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = {
      schemaVersion: 1,
      organizations: structure.organizations,
      units: structure.units,
      relations: structure.relations ?? [],
      updatedAt: structure.updatedAt,
    };
    await atomicWriteAsync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    return structure;
  }
}
