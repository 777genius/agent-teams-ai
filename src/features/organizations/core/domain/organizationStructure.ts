import { getOrgUnitNodeId, getRelationId, normalizeOrganizationId } from './organizationIds';

import type {
  OrgRelationDefinitionModel,
  OrgRelationKind,
  OrgStructureModel,
  OrgSummaryModel,
  OrgTeamCandidate,
  OrgUnitModel,
} from './models';

export interface BuildDefaultOrganizationStructureInput {
  teams: readonly OrgTeamCandidate[];
  generatedAt: string;
  organizationId?: string;
  organizationName?: string;
}

export interface CreateOrganizationInput {
  id?: string;
  name: string;
  description?: string;
  parentOrganizationId?: string | null;
  updatedAt: string;
}

export interface UpsertOrganizationUnitInput {
  organizationId: string;
  id?: string;
  parentId?: string | null;
  kind: 'container' | 'team';
  label: string;
  description?: string;
  color?: string;
  teamName?: string;
  title?: string;
  tags?: string[];
  updatedAt: string;
}

export interface MoveOrganizationUnitInput {
  organizationId?: string;
  unitId: string;
  parentId: string | null;
  updatedAt: string;
}

export interface RemoveOrganizationUnitInput {
  organizationId?: string;
  unitId: string;
  cascade?: boolean;
  updatedAt: string;
}

export interface AssignTeamToUnitInput {
  organizationId: string;
  parentUnitId: string;
  teamName: string;
  label?: string;
  updatedAt: string;
}

export interface RemoveTeamFromOrganizationInput {
  organizationId?: string;
  teamName: string;
  updatedAt: string;
}

export interface UpsertOrganizationRelationInput {
  organizationId?: string;
  id?: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: OrgRelationKind;
  label?: string;
  weight?: number;
  updatedAt: string;
}

export interface DeleteOrganizationRelationInput {
  organizationId?: string;
  relationId: string;
  updatedAt: string;
}

function cloneStructure(structure: OrgStructureModel): OrgStructureModel {
  return {
    organizations: structure.organizations.map((organization) => ({ ...organization })),
    units: structure.units.map((unit) => ({
      ...unit,
      tags: unit.tags ? [...unit.tags] : undefined,
    })),
    relations: (structure.relations ?? []).map((relation) => ({ ...relation })),
    updatedAt: structure.updatedAt,
  };
}

function slugify(value: string, fallback: string): string {
  return normalizeOrganizationId(value, fallback);
}

function getRootUnitId(organizationId: string): string {
  return `${organizationId}:root`;
}

function getTeamUnitId(teamName: string): string {
  return `team:${slugify(teamName, 'team')}`;
}

function getContainerUnitId(organizationId: string, label: string): string {
  return `unit:${organizationId}:${slugify(label, 'unit')}`;
}

function getAvailableUnitId(structure: OrgStructureModel, baseId: string): string {
  const ids = new Set(structure.units.map((unit) => unit.id));
  if (!ids.has(baseId)) {
    return baseId;
  }

  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    if (!ids.has(candidate)) {
      return candidate;
    }
  }

  return `${baseId}-${ids.size + 1}`;
}

function requireOrganization(
  structure: OrgStructureModel,
  organizationId: string | undefined
): OrgSummaryModel {
  const normalizedId = normalizeOrganizationId(
    organizationId,
    structure.organizations[0]?.id ?? 'default'
  );
  const organization = structure.organizations.find((item) => item.id === normalizedId);
  if (!organization) {
    throw new Error(`Organization "${normalizedId}" was not found.`);
  }
  return organization;
}

function resolveParentOrganizationId(
  structure: OrgStructureModel,
  organizationId: string,
  parentOrganizationId: string | null | undefined
): string | null {
  const normalizedParentId = normalizeOrganizationId(parentOrganizationId ?? undefined, '');
  if (!normalizedParentId) {
    return null;
  }
  if (normalizedParentId === organizationId) {
    throw new Error('Organization cannot be its own parent.');
  }
  requireOrganization(structure, normalizedParentId);
  return normalizedParentId;
}

function findUnit(
  structure: OrgStructureModel,
  unitId: string,
  organizationId?: string
): OrgUnitModel | undefined {
  return structure.units.find(
    (unit) => unit.id === unitId && (!organizationId || unit.organizationId === organizationId)
  );
}

function requireUnit(
  structure: OrgStructureModel,
  unitId: string,
  organizationId?: string
): OrgUnitModel {
  const unit = findUnit(structure, unitId, organizationId);
  if (!unit) {
    throw new Error(`Organization unit "${unitId}" was not found.`);
  }
  return unit;
}

function requireParentUnit(
  structure: OrgStructureModel,
  parentId: string | null,
  organization: OrgSummaryModel
): string | null {
  const effectiveParentId = parentId ?? organization.rootNodeId;
  if (!effectiveParentId) {
    return null;
  }
  requireUnit(structure, effectiveParentId, organization.id);
  return effectiveParentId;
}

function getUnitKey(unit: Pick<OrgUnitModel, 'id' | 'organizationId'>): string {
  return `${unit.organizationId}\0${unit.id}`;
}

function getChildren(
  structure: OrgStructureModel,
  unitId: string,
  organizationId: string
): OrgUnitModel[] {
  return structure.units.filter(
    (unit) => unit.organizationId === organizationId && unit.parentId === unitId
  );
}

function hasDescendant(
  structure: OrgStructureModel,
  organizationId: string,
  ancestorId: string,
  maybeDescendantId: string
): boolean {
  const children = getChildren(structure, ancestorId, organizationId);
  for (const child of children) {
    if (
      child.id === maybeDescendantId ||
      hasDescendant(structure, organizationId, child.id, maybeDescendantId)
    ) {
      return true;
    }
  }
  return false;
}

function isTeamUnitFor(unit: OrgUnitModel, teamName: string): boolean {
  return unit.kind === 'team' && (unit.teamName ?? unit.id.replace(/^team:/, '')) === teamName;
}

function touch(structure: OrgStructureModel, updatedAt: string): OrgStructureModel {
  return {
    ...structure,
    updatedAt,
  };
}

function getRelationReferenceIdsByOrganizationForRemovedUnits(
  units: readonly OrgUnitModel[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const referenceIdsByOrganization = new Map<string, Set<string>>();
  for (const unit of units) {
    const referenceIds = referenceIdsByOrganization.get(unit.organizationId) ?? new Set<string>();
    referenceIds.add(unit.id);
    referenceIds.add(getOrgUnitNodeId(unit.id));
    if (unit.kind === 'team') {
      const teamName = unit.teamName ?? unit.id.replace(/^team:/, '');
      referenceIds.add(teamName);
      referenceIds.add(getTeamUnitId(teamName));
    }
    referenceIdsByOrganization.set(unit.organizationId, referenceIds);
  }
  return referenceIdsByOrganization;
}

function pruneRelationsForRemovedUnits(
  relations: readonly OrgRelationDefinitionModel[],
  removedUnits: readonly OrgUnitModel[]
): OrgRelationDefinitionModel[] {
  const referenceIdsByOrganization =
    getRelationReferenceIdsByOrganizationForRemovedUnits(removedUnits);
  if (referenceIdsByOrganization.size === 0) {
    return [...relations];
  }

  return relations.filter((relation) => {
    const organizationIds = relation.organizationId
      ? [relation.organizationId]
      : [...referenceIdsByOrganization.keys()];
    return !organizationIds.some((organizationId) => {
      const removedReferenceIds = referenceIdsByOrganization.get(organizationId);
      return (
        removedReferenceIds?.has(relation.sourceNodeId) ||
        removedReferenceIds?.has(relation.targetNodeId)
      );
    });
  });
}

export function buildDefaultOrganizationStructure(
  input: BuildDefaultOrganizationStructureInput
): OrgStructureModel {
  const organizationId = normalizeOrganizationId(input.organizationId, 'default');
  const rootNodeId = getRootUnitId(organizationId);
  const organization: OrgSummaryModel = {
    id: organizationId,
    name: input.organizationName ?? 'All Teams',
    description: 'Default editable organization generated from local teams.',
    rootNodeId,
    updatedAt: input.generatedAt,
  };
  const rootUnit: OrgUnitModel = {
    id: rootNodeId,
    organizationId,
    parentId: null,
    kind: 'organization',
    label: organization.name,
    description: organization.description,
    color: '#4f8cff',
  };
  const teamUnits: OrgUnitModel[] = input.teams.map((team) => ({
    id: getTeamUnitId(team.teamName),
    organizationId,
    parentId: rootNodeId,
    kind: 'team',
    label: team.displayName,
    description: team.description,
    color: team.color,
    teamName: team.teamName,
  }));

  return {
    organizations: [organization],
    units: [rootUnit, ...teamUnits],
    relations: [],
    updatedAt: input.generatedAt,
  };
}

export function ensureOrganizationStructureRoots(
  structure: OrgStructureModel,
  updatedAt: string
): OrgStructureModel {
  const next = cloneStructure(structure);
  for (const organization of next.organizations) {
    const hasRoot = next.units.some(
      (unit) => unit.id === organization.rootNodeId && unit.organizationId === organization.id
    );
    if (hasRoot) {
      continue;
    }
    next.units.unshift({
      id: organization.rootNodeId,
      organizationId: organization.id,
      parentId: null,
      kind: 'organization',
      label: organization.name,
      description: organization.description,
      color: '#4f8cff',
    });
  }
  return {
    ...next,
    updatedAt: next.updatedAt ?? updatedAt,
  };
}

export function createOrganization(
  structure: OrgStructureModel,
  input: CreateOrganizationInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const organizationId = normalizeOrganizationId(input.id ?? input.name, 'organization');
  if (next.organizations.some((organization) => organization.id === organizationId)) {
    throw new Error(`Organization "${organizationId}" already exists.`);
  }

  const rootNodeId = getAvailableUnitId(next, getRootUnitId(organizationId));
  const parentOrganizationId = resolveParentOrganizationId(
    next,
    organizationId,
    input.parentOrganizationId
  );
  next.organizations.push({
    id: organizationId,
    name: input.name.trim() || organizationId,
    description: input.description,
    rootNodeId,
    parentOrganizationId,
    updatedAt: input.updatedAt,
  });
  next.units.push({
    id: rootNodeId,
    organizationId,
    parentId: null,
    kind: 'organization',
    label: input.name.trim() || organizationId,
    description: input.description,
    color: '#4f8cff',
  });

  return touch(next, input.updatedAt);
}

export function upsertOrganizationUnit(
  structure: OrgStructureModel,
  input: UpsertOrganizationUnitInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const organization = requireOrganization(next, input.organizationId);
  const id =
    input.id ??
    getAvailableUnitId(
      next,
      input.kind === 'team'
        ? getTeamUnitId(input.teamName ?? input.label)
        : getContainerUnitId(organization.id, input.label)
    );
  const existingIndex = next.units.findIndex(
    (unit) => unit.id === id && unit.organizationId === organization.id
  );
  const existingUnit = existingIndex >= 0 ? next.units[existingIndex] : undefined;
  if (id === organization.rootNodeId || existingUnit?.kind === 'organization') {
    throw new Error('Organization root units cannot be upserted.');
  }
  const parentId = requireParentUnit(
    next,
    input.parentId ?? existingUnit?.parentId ?? organization.rootNodeId,
    organization
  );
  const unit: OrgUnitModel = {
    id,
    organizationId: organization.id,
    parentId,
    kind: input.kind,
    label: input.label,
    description: input.description,
    color: input.color,
    teamName: input.kind === 'team' ? (input.teamName ?? id.replace(/^team:/, '')) : undefined,
    title: input.title,
    tags: input.tags,
  };

  if (existingIndex >= 0) {
    next.units[existingIndex] = unit;
  } else {
    next.units.push(unit);
  }

  return touch(next, input.updatedAt);
}

export function moveOrganizationUnit(
  structure: OrgStructureModel,
  input: MoveOrganizationUnitInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const unit = requireUnit(next, input.unitId, input.organizationId);
  if (unit.kind === 'organization') {
    throw new Error('Organization root units cannot be moved.');
  }

  const organization = requireOrganization(next, unit.organizationId);
  const parentId = requireParentUnit(next, input.parentId, organization);
  if (
    parentId === unit.id ||
    (parentId && hasDescendant(next, unit.organizationId, unit.id, parentId))
  ) {
    throw new Error('Cannot move a unit under itself or one of its descendants.');
  }

  unit.parentId = parentId;
  return touch(next, input.updatedAt);
}

export function removeOrganizationUnit(
  structure: OrgStructureModel,
  input: RemoveOrganizationUnitInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const unit = requireUnit(next, input.unitId, input.organizationId);
  if (unit.kind === 'organization') {
    throw new Error('Organization root units cannot be removed.');
  }

  const children = getChildren(next, unit.id, unit.organizationId);
  if (children.length > 0 && !input.cascade) {
    throw new Error('Cannot remove an organization unit that still has children.');
  }

  const removedIds = new Set<string>([unit.id]);
  if (input.cascade) {
    const collect = (unitId: string): void => {
      for (const child of getChildren(next, unitId, unit.organizationId)) {
        removedIds.add(child.id);
        collect(child.id);
      }
    };
    collect(unit.id);
  }

  const removedUnits = next.units.filter(
    (candidate) => candidate.organizationId === unit.organizationId && removedIds.has(candidate.id)
  );
  const removedUnitKeys = new Set(removedUnits.map(getUnitKey));
  next.units = next.units.filter((candidate) => !removedUnitKeys.has(getUnitKey(candidate)));
  next.relations = pruneRelationsForRemovedUnits(next.relations ?? [], removedUnits);
  return touch(next, input.updatedAt);
}

export function assignTeamToUnit(
  structure: OrgStructureModel,
  input: AssignTeamToUnitInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const organization = requireOrganization(next, input.organizationId);
  const parentId = requireParentUnit(next, input.parentUnitId, organization);
  const teamName = input.teamName.trim();
  if (!teamName) {
    throw new Error('Team name is required.');
  }

  next.units = next.units.filter(
    (unit) => unit.organizationId !== organization.id || !isTeamUnitFor(unit, teamName)
  );
  next.units.push({
    id: getAvailableUnitId(next, getTeamUnitId(teamName)),
    organizationId: organization.id,
    parentId,
    kind: 'team',
    label: input.label?.trim() || teamName,
    teamName,
  });

  return touch(next, input.updatedAt);
}

export function removeTeamFromOrganization(
  structure: OrgStructureModel,
  input: RemoveTeamFromOrganizationInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const organizationId = input.organizationId
    ? requireOrganization(next, input.organizationId).id
    : undefined;
  const removedUnits = next.units.filter(
    (unit) =>
      (!organizationId || unit.organizationId === organizationId) &&
      isTeamUnitFor(unit, input.teamName)
  );

  const removedUnitKeys = new Set(removedUnits.map(getUnitKey));
  next.units = next.units.filter((unit) => !removedUnitKeys.has(getUnitKey(unit)));
  next.relations = pruneRelationsForRemovedUnits(next.relations ?? [], removedUnits);
  return touch(next, input.updatedAt);
}

export function upsertOrganizationRelation(
  structure: OrgStructureModel,
  input: UpsertOrganizationRelationInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  if (!input.sourceNodeId || !input.targetNodeId || input.sourceNodeId === input.targetNodeId) {
    throw new Error('Organization relation requires distinct source and target nodes.');
  }

  const organizationId = input.organizationId
    ? requireOrganization(next, input.organizationId).id
    : next.organizations[0]?.id;
  const relation: OrgRelationDefinitionModel = {
    id: input.id ?? getRelationId(input.kind, input.sourceNodeId, input.targetNodeId),
    organizationId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    kind: input.kind,
    sourceKind: 'manual',
    weight: input.weight ?? 1,
    label: input.label,
  };
  const index = (next.relations ?? []).findIndex(
    (candidate) =>
      candidate.id === relation.id && candidate.organizationId === relation.organizationId
  );
  const relations = next.relations ?? [];
  if (index >= 0) {
    relations[index] = relation;
  } else {
    relations.push(relation);
  }
  next.relations = relations;
  return touch(next, input.updatedAt);
}

export function deleteOrganizationRelation(
  structure: OrgStructureModel,
  input: DeleteOrganizationRelationInput
): OrgStructureModel {
  const next = cloneStructure(structure);
  const organizationId = input.organizationId
    ? requireOrganization(next, input.organizationId).id
    : undefined;
  next.relations = (next.relations ?? []).filter(
    (relation) =>
      relation.id !== input.relationId ||
      (organizationId !== undefined && relation.organizationId !== organizationId)
  );
  return touch(next, input.updatedAt);
}
