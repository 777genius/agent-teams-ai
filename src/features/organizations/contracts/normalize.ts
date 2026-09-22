import type {
  AssignOrganizationTeamRequest,
  CreateOrganizationRequest,
  DeleteOrganizationRelationRequest,
  MoveOrganizationUnitRequest,
  OrganizationMapPayload,
  OrganizationMapRequest,
  OrganizationMapScope,
  OrganizationRelationKind,
  OrganizationStructurePayload,
  RemoveOrganizationTeamRequest,
  RemoveOrganizationUnitRequest,
  UpsertOrganizationRelationRequest,
  UpsertOrganizationUnitRequest,
} from './dto';

const DEFAULT_MAX_TEAMS = 120;
const DEFAULT_MAX_AGENTS_PER_TEAM = 8;
const DEFAULT_MAX_TASKS_PER_AGENT = 3;
const DEFAULT_MAX_CROSS_TEAM_MESSAGES = 240;

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(numeric), max));
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function readNullableString(
  record: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value.trim() || null : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return result.length > 0 ? result : undefined;
}

function readWeight(record: Record<string, unknown>): number | undefined {
  const value = record.weight;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0.1, Math.min(value, 100));
}

export function normalizeOrganizationMapRequest(value: unknown): Required<
  Omit<OrganizationMapRequest, 'organizationId' | 'scope'>
> & {
  organizationId?: string;
  scope: OrganizationMapScope;
} {
  const request =
    value && typeof value === 'object' ? (value as Partial<OrganizationMapRequest>) : undefined;
  const scope = request?.scope === 'all' ? 'all' : 'organization';
  return {
    scope,
    organizationId:
      typeof request?.organizationId === 'string' && request.organizationId.trim().length > 0
        ? request.organizationId.trim()
        : undefined,
    includeDeletedTeams: normalizeBoolean(request?.includeDeletedTeams),
    maxTeams: clampPositiveInt(request?.maxTeams, DEFAULT_MAX_TEAMS, 500),
    maxAgentsPerTeam: clampPositiveInt(request?.maxAgentsPerTeam, DEFAULT_MAX_AGENTS_PER_TEAM, 50),
    maxTasksPerAgent: clampPositiveInt(request?.maxTasksPerAgent, DEFAULT_MAX_TASKS_PER_AGENT, 12),
    maxCrossTeamMessages: clampPositiveInt(
      request?.maxCrossTeamMessages,
      DEFAULT_MAX_CROSS_TEAM_MESSAGES,
      1_500
    ),
  };
}

export function normalizeOrganizationMapPayload(value: unknown): OrganizationMapPayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as OrganizationMapPayload;
  if (
    !Array.isArray(payload.organizations) ||
    !Array.isArray(payload.nodes) ||
    !Array.isArray(payload.relations) ||
    !payload.diagnostics ||
    typeof payload.activeOrganizationId !== 'string'
  ) {
    return null;
  }

  return {
    scope: payload.scope === 'all' ? 'all' : 'organization',
    organizations: payload.organizations,
    activeOrganizationId: payload.activeOrganizationId,
    rootNodeId: typeof payload.rootNodeId === 'string' ? payload.rootNodeId : undefined,
    nodes: payload.nodes,
    relations: payload.relations,
    degraded: payload.degraded === true,
    diagnostics: payload.diagnostics,
  };
}

export function normalizeOrganizationStructurePayload(
  value: unknown
): OrganizationStructurePayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as OrganizationStructurePayload;
  if (
    !Array.isArray(payload.organizations) ||
    !Array.isArray(payload.units) ||
    !Array.isArray(payload.relations) ||
    !Array.isArray(payload.availableTeams) ||
    typeof payload.activeOrganizationId !== 'string' ||
    (payload.source !== 'configured' && payload.source !== 'generated')
  ) {
    return null;
  }

  return {
    organizations: payload.organizations,
    activeOrganizationId: payload.activeOrganizationId,
    units: payload.units,
    relations: payload.relations,
    availableTeams: payload.availableTeams,
    source: payload.source,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : undefined,
  };
}

export function normalizeCreateOrganizationRequest(value: unknown): CreateOrganizationRequest {
  const record = asRecord(value);
  return {
    id: readOptionalString(record, 'id'),
    name: readString(record, 'name') ?? 'New Organization',
    description: readOptionalString(record, 'description'),
    parentOrganizationId: readNullableString(record, 'parentOrganizationId'),
  };
}

export function normalizeUpsertOrganizationUnitRequest(
  value: unknown
): UpsertOrganizationUnitRequest {
  const record = asRecord(value);
  const kind = record.kind === 'team' ? 'team' : 'container';
  return {
    organizationId: readString(record, 'organizationId') ?? 'default',
    id: readOptionalString(record, 'id'),
    parentId: readNullableString(record, 'parentId'),
    kind,
    label: readString(record, 'label') ?? (kind === 'team' ? 'Team' : 'New Unit'),
    description: readOptionalString(record, 'description'),
    color: readOptionalString(record, 'color'),
    teamName: readOptionalString(record, 'teamName'),
    title: readOptionalString(record, 'title'),
    tags: readStringArray(record, 'tags'),
  };
}

export function normalizeMoveOrganizationUnitRequest(value: unknown): MoveOrganizationUnitRequest {
  const record = asRecord(value);
  return {
    organizationId: readOptionalString(record, 'organizationId'),
    unitId: readString(record, 'unitId') ?? '',
    parentId: readNullableString(record, 'parentId') ?? null,
  };
}

export function normalizeRemoveOrganizationUnitRequest(
  value: unknown
): RemoveOrganizationUnitRequest {
  const record = asRecord(value);
  return {
    organizationId: readOptionalString(record, 'organizationId'),
    unitId: readString(record, 'unitId') ?? '',
    cascade: normalizeBoolean(record.cascade),
  };
}

export function normalizeAssignOrganizationTeamRequest(
  value: unknown
): AssignOrganizationTeamRequest {
  const record = asRecord(value);
  return {
    organizationId: readString(record, 'organizationId') ?? 'default',
    parentUnitId: readString(record, 'parentUnitId') ?? '',
    teamName: readString(record, 'teamName') ?? '',
    label: readOptionalString(record, 'label'),
  };
}

export function normalizeRemoveOrganizationTeamRequest(
  value: unknown
): RemoveOrganizationTeamRequest {
  const record = asRecord(value);
  return {
    organizationId: readOptionalString(record, 'organizationId'),
    teamName: readString(record, 'teamName') ?? '',
  };
}

export function normalizeUpsertOrganizationRelationRequest(
  value: unknown
): UpsertOrganizationRelationRequest {
  const record = asRecord(value);
  return {
    organizationId: readOptionalString(record, 'organizationId'),
    id: readOptionalString(record, 'id'),
    sourceNodeId: readString(record, 'sourceNodeId') ?? '',
    targetNodeId: readString(record, 'targetNodeId') ?? '',
    kind: (readString(record, 'kind') ?? 'depends_on') as OrganizationRelationKind,
    label: readOptionalString(record, 'label'),
    weight: readWeight(record),
  };
}

export function normalizeDeleteOrganizationRelationRequest(
  value: unknown
): DeleteOrganizationRelationRequest {
  const record = asRecord(value);
  return {
    organizationId: readOptionalString(record, 'organizationId'),
    relationId: readString(record, 'relationId') ?? '',
  };
}
