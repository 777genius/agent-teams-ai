import {
  getOrganizationNodeId,
  getOrgUnitNodeId,
  getRelationId,
  getTeamNodeId,
  normalizeOrganizationId,
} from './organizationIds';
import { projectOrgTeam } from './teamProjection';

import type {
  OrgNodeModel,
  OrgRelationDefinitionModel,
  OrgRelationModel,
  OrgStructureModel,
  OrgSummaryModel,
  OrgTeamCandidate,
  OrgUnitModel,
} from './models';
import type { ProjectOrgTeamOptions } from './teamProjection';

export interface BuildDefaultOrganizationGraphInput extends ProjectOrgTeamOptions {
  organizationId?: string;
  organizationName?: string;
  teams: readonly OrgTeamCandidate[];
  maxTeams: number;
  generatedAt: string;
}

export interface DefaultOrganizationGraphResult {
  organization: OrgSummaryModel;
  nodes: OrgNodeModel[];
  relations: OrgRelationModel[];
  renderedTeamNames: string[];
  truncatedTeams: number;
  warnings: string[];
}

export interface BuildOrganizationGraphInput extends BuildDefaultOrganizationGraphInput {
  structure?: OrgStructureModel | null;
}

const ALL_ORGANIZATIONS_ID = '__all-organizations__';
const ALL_ORGANIZATIONS_ROOT_NODE_ID = 'org:__all-organizations__';

function normalizeParentOrganizationId(
  organization: OrgSummaryModel,
  organizationsById: ReadonlyMap<string, OrgSummaryModel>
): string | null {
  const parentOrganizationId = normalizeOrganizationId(
    organization.parentOrganizationId ?? undefined,
    ''
  );
  if (
    !parentOrganizationId ||
    parentOrganizationId === organization.id ||
    !organizationsById.has(parentOrganizationId)
  ) {
    return null;
  }

  const seen = new Set<string>([organization.id]);
  let currentParentId: string | null = parentOrganizationId;
  while (currentParentId) {
    if (seen.has(currentParentId)) {
      return null;
    }
    seen.add(currentParentId);
    const parent = organizationsById.get(currentParentId);
    currentParentId = parent
      ? normalizeOrganizationId(parent.parentOrganizationId ?? undefined, '')
      : null;
  }

  return parentOrganizationId;
}

function orderOrganizationsByHierarchy(
  organizations: readonly OrgSummaryModel[]
): OrgSummaryModel[] {
  const childrenByParentId = new Map<string | null, OrgSummaryModel[]>();
  for (const organization of organizations) {
    const parentId = organization.parentOrganizationId ?? null;
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(organization);
    childrenByParentId.set(parentId, siblings);
  }

  const ordered: OrgSummaryModel[] = [];
  const visited = new Set<string>();
  const visit = (organization: OrgSummaryModel): void => {
    if (visited.has(organization.id)) {
      return;
    }
    visited.add(organization.id);
    ordered.push(organization);
    for (const child of childrenByParentId.get(organization.id) ?? []) {
      visit(child);
    }
  };

  for (const organization of childrenByParentId.get(null) ?? []) {
    visit(organization);
  }
  for (const organization of organizations) {
    visit(organization);
  }

  return ordered;
}

function getTeamActivityMs(team: OrgTeamCandidate): number {
  let latest = 0;
  for (const task of team.tasks) {
    if (!task.updatedAt) continue;
    const parsed = Date.parse(task.updatedAt);
    if (Number.isFinite(parsed)) {
      latest = Math.max(latest, parsed);
    }
  }
  return latest;
}

function getActiveTaskCount(team: OrgTeamCandidate): number {
  return team.tasks.filter((task) => task.status === 'in_progress').length;
}

function sortTeamsForDefaultOrg(teams: readonly OrgTeamCandidate[]): OrgTeamCandidate[] {
  return teams.slice().sort((left, right) => {
    if (left.isOnline !== right.isOnline) {
      return left.isOnline ? -1 : 1;
    }
    const activeDelta = getActiveTaskCount(right) - getActiveTaskCount(left);
    if (activeDelta !== 0) {
      return activeDelta;
    }
    const activityDelta = getTeamActivityMs(right) - getTeamActivityMs(left);
    if (activityDelta !== 0) {
      return activityDelta;
    }
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
  });
}

function collectReferencedTeamNames(units: readonly OrgUnitModel[]): Set<string> {
  const teamNames = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== 'team') {
      continue;
    }
    const teamName = getTeamNameForUnit(unit);
    if (teamName) {
      teamNames.add(teamName);
    }
  }
  return teamNames;
}

export function buildDefaultOrganizationGraph(
  input: BuildDefaultOrganizationGraphInput
): DefaultOrganizationGraphResult {
  const organizationId = input.organizationId ?? 'default';
  const rootNodeId = getOrganizationNodeId(organizationId);
  const organization: OrgSummaryModel = {
    id: organizationId,
    name: input.organizationName ?? 'All Teams',
    description: 'Default organization generated from local teams.',
    rootNodeId,
    updatedAt: input.generatedAt,
  };

  const sortedTeams = sortTeamsForDefaultOrg(input.teams);
  const visibleTeams = sortedTeams.slice(0, input.maxTeams);
  const nodes: OrgNodeModel[] = [
    {
      id: rootNodeId,
      kind: 'organization',
      label: organization.name,
      description: organization.description,
      color: '#4f8cff',
    },
  ];
  const relations: OrgRelationModel[] = [];

  for (const team of visibleTeams) {
    const teamNodeId = getTeamNodeId(team.teamName);
    nodes.push({
      id: teamNodeId,
      kind: 'team',
      label: team.displayName,
      description: team.description,
      color: team.color,
      team: projectOrgTeam(team, input),
    });
    relations.push({
      id: getRelationId('contains', rootNodeId, teamNodeId),
      sourceNodeId: rootNodeId,
      targetNodeId: teamNodeId,
      kind: 'contains',
      sourceKind: 'inferred',
      weight: 1,
    });
  }

  return {
    organization,
    nodes,
    relations,
    renderedTeamNames: visibleTeams.map((team) => team.teamName),
    truncatedTeams: Math.max(0, sortedTeams.length - visibleTeams.length),
    warnings: [],
  };
}

export function buildOrganizationGraph(
  input: BuildOrganizationGraphInput
): DefaultOrganizationGraphResult {
  if (!input.structure || input.structure.organizations.length === 0) {
    return buildDefaultOrganizationGraph(input);
  }

  const configured = buildConfiguredOrganizationGraph({
    ...input,
    structure: input.structure,
  });
  if (configured && !hasContainmentCycle(configured.relations)) {
    return configured;
  }

  const fallback = buildDefaultOrganizationGraph(input);
  return {
    ...fallback,
    warnings: [
      ...fallback.warnings,
      configured
        ? 'Configured organization contains a containment cycle; rendered the default team map.'
        : 'Configured organization could not be rendered; rendered the default team map.',
    ],
  };
}

export function buildAllOrganizationsGraph(
  input: BuildOrganizationGraphInput
): DefaultOrganizationGraphResult {
  if (!input.structure || input.structure.organizations.length === 0) {
    return buildDefaultOrganizationGraph({
      ...input,
      organizationId: input.organizationId ?? 'default',
      organizationName: input.organizationName ?? 'All Teams',
    });
  }

  const warnings: string[] = [];
  const teamsByName = new Map(input.teams.map((team) => [team.teamName, team]));
  const sortedTeams = sortTeamsForDefaultOrg(input.teams);
  const globallyReferencedTeamNames = collectReferencedTeamNames(input.structure.units);
  const nodeById = new Map<string, OrgNodeModel>();
  const relations: OrgRelationModel[] = [];
  const renderedTeamNames: string[] = [];
  const renderedTeamNameSet = new Set<string>();
  const scopedUnitNodeIdByKey = new Map<string, string>();
  const unitNodeIdsByRawId = new Map<string, Set<string>>();
  const normalizedOrganizations = input.structure.organizations.map((organization) => ({
    ...organization,
    rootNodeId: organization.rootNodeId || getOrganizationNodeId(organization.id),
    updatedAt: organization.updatedAt ?? input.structure?.updatedAt ?? input.generatedAt,
  }));
  const rawOrganizationsById = new Map(
    normalizedOrganizations.map((organization) => [organization.id, organization] as const)
  );
  const organizations = orderOrganizationsByHierarchy(
    normalizedOrganizations.map((organization) => ({
      ...organization,
      parentOrganizationId: normalizeParentOrganizationId(organization, rawOrganizationsById),
    }))
  );

  nodeById.set(ALL_ORGANIZATIONS_ROOT_NODE_ID, {
    id: ALL_ORGANIZATIONS_ROOT_NODE_ID,
    kind: 'organization',
    label: 'Organizations',
    description: 'All configured organizations.',
    color: '#4f8cff',
    parentNodeId: null,
  });

  for (const organization of organizations) {
    const units = normalizeOrganizationUnits(input.structure, organization);
    for (const unit of units) {
      const nodeId = getAllScopeNodeIdForUnit(unit, organization.id);
      scopedUnitNodeIdByKey.set(getScopedUnitKey(organization.id, unit.id), nodeId);
      const rawNodeIds = unitNodeIdsByRawId.get(unit.id) ?? new Set<string>();
      rawNodeIds.add(nodeId);
      unitNodeIdsByRawId.set(unit.id, rawNodeIds);
      if (unit.kind === 'team') {
        const teamName = getTeamNameForUnit(unit);
        scopedUnitNodeIdByKey.set(getScopedUnitKey(organization.id, teamName), nodeId);
        const teamNodeIds = unitNodeIdsByRawId.get(teamName) ?? new Set<string>();
        teamNodeIds.add(nodeId);
        unitNodeIdsByRawId.set(teamName, teamNodeIds);
      }
    }
  }

  for (const organization of organizations) {
    const units = normalizeOrganizationUnits(input.structure, organization);
    const rootNodeId =
      scopedUnitNodeIdByKey.get(getScopedUnitKey(organization.id, organization.rootNodeId)) ??
      getAllScopeOrganizationNodeId(organization.id);

    for (const unit of units) {
      const nodeId =
        scopedUnitNodeIdByKey.get(getScopedUnitKey(organization.id, unit.id)) ??
        getAllScopeNodeIdForUnit(unit, organization.id);
      if (nodeById.has(nodeId)) {
        warnings.push(`Skipped duplicate organization node "${unit.id}".`);
        continue;
      }

      const teamName = unit.kind === 'team' ? getTeamNameForUnit(unit) : undefined;
      const team = teamName ? teamsByName.get(teamName) : undefined;
      const teamPlacementKey = teamName ? `${organization.id}\0${teamName}` : undefined;
      if (teamPlacementKey && renderedTeamNameSet.has(teamPlacementKey)) {
        warnings.push(`Skipped duplicate team reference "${teamName}".`);
        continue;
      }

      const shouldProjectTeam =
        Boolean(team) && renderedTeamNames.length < input.maxTeams && unit.kind === 'team';
      if (teamName && team && !shouldProjectTeam) {
        continue;
      }
      if (teamName && team) {
        renderedTeamNameSet.add(teamPlacementKey!);
        if (shouldProjectTeam) {
          renderedTeamNames.push(teamName);
        }
      }

      const parentNodeId =
        unit.kind === 'organization'
          ? organization.parentOrganizationId
            ? getAllScopeOrganizationNodeId(organization.parentOrganizationId)
            : ALL_ORGANIZATIONS_ROOT_NODE_ID
          : resolveAllScopeParentNodeId({
              organizationId: organization.id,
              parentId: unit.parentId,
              rootNodeId,
              scopedUnitNodeIdByKey,
            });

      nodeById.set(nodeId, {
        id: nodeId,
        structureUnitId: unit.id,
        kind: unit.kind,
        label: unit.kind === 'organization' ? organization.name : unit.label,
        description:
          unit.description ??
          (teamName && !team
            ? `Team "${teamName}" is referenced by the organization but was not found.`
            : undefined),
        color: unit.color ?? team?.color ?? (unit.kind === 'organization' ? '#4f8cff' : undefined),
        parentNodeId,
        title: unit.title,
        tags: unit.tags,
        team: shouldProjectTeam
          ? projectOrgTeam(team!, { ...input, displayNameOverride: unit.label })
          : undefined,
      });

      relations.push({
        id: getRelationId('contains', parentNodeId, nodeId),
        sourceNodeId: parentNodeId,
        targetNodeId: nodeId,
        kind: 'contains',
        sourceKind: unit.kind === 'organization' ? 'inferred' : 'manual',
        weight: 1,
      });
    }
  }

  const remainingSlots = Math.max(0, input.maxTeams - renderedTeamNames.length);
  const unassignedTeams = sortedTeams
    .filter((team) => !globallyReferencedTeamNames.has(team.teamName))
    .slice(0, remainingSlots);
  if (unassignedTeams.length > 0) {
    const unassignedNodeId = getAvailableNodeId(
      getOrgUnitNodeId(`${ALL_ORGANIZATIONS_ID}:unassigned-teams`),
      nodeById
    );
    nodeById.set(unassignedNodeId, {
      id: unassignedNodeId,
      kind: 'container',
      label: 'Unassigned Teams',
      description: 'Teams that are not placed in any organization yet.',
      color: '#64748b',
      parentNodeId: ALL_ORGANIZATIONS_ROOT_NODE_ID,
      tags: ['system', 'unassigned'],
    });
    relations.push({
      id: getRelationId('contains', ALL_ORGANIZATIONS_ROOT_NODE_ID, unassignedNodeId),
      sourceNodeId: ALL_ORGANIZATIONS_ROOT_NODE_ID,
      targetNodeId: unassignedNodeId,
      kind: 'contains',
      sourceKind: 'inferred',
      weight: 1,
    });

    for (const team of unassignedTeams) {
      const teamNodeId = getTeamNodeId(team.teamName);
      if (nodeById.has(teamNodeId)) {
        warnings.push(`Skipped duplicate unassigned team reference "${team.teamName}".`);
        continue;
      }
      nodeById.set(teamNodeId, {
        id: teamNodeId,
        kind: 'team',
        label: team.displayName,
        description: team.description,
        color: team.color,
        parentNodeId: unassignedNodeId,
        team: projectOrgTeam(team, input),
      });
      relations.push({
        id: getRelationId('contains', unassignedNodeId, teamNodeId),
        sourceNodeId: unassignedNodeId,
        targetNodeId: teamNodeId,
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      });
      renderedTeamNames.push(team.teamName);
      renderedTeamNameSet.add(team.teamName);
    }
  }

  relations.push(
    ...projectAllScopeConfiguredRelations({
      relations: input.structure.relations ?? [],
      nodeById,
      scopedUnitNodeIdByKey,
      unitNodeIdsByRawId,
      warnings,
    })
  );

  const result: DefaultOrganizationGraphResult = {
    organization: {
      id: ALL_ORGANIZATIONS_ID,
      name: 'Organizations',
      description: 'All configured organizations.',
      rootNodeId: ALL_ORGANIZATIONS_ROOT_NODE_ID,
      updatedAt: input.structure.updatedAt ?? input.generatedAt,
    },
    nodes: [...nodeById.values()],
    relations,
    renderedTeamNames,
    truncatedTeams: Math.max(0, sortedTeams.length - renderedTeamNames.length),
    warnings,
  };

  if (hasContainmentCycle(result.relations)) {
    const fallback = buildDefaultOrganizationGraph(input);
    return {
      ...fallback,
      warnings: [
        ...fallback.warnings,
        'Configured organizations contain a containment cycle; rendered the default team map.',
      ],
    };
  }

  return result;
}

export function getAllScopeOrganizationNodeId(organizationId: string): string {
  return getOrganizationNodeId(organizationId);
}

function buildConfiguredOrganizationGraph(
  input: BuildOrganizationGraphInput & { structure: OrgStructureModel }
): DefaultOrganizationGraphResult | null {
  const organization = selectOrganization(input.structure, input.organizationId, input.generatedAt);
  if (!organization) {
    return null;
  }

  const warnings: string[] = [];
  const teamsByName = new Map(input.teams.map((team) => [team.teamName, team]));
  const sortedTeams = sortTeamsForDefaultOrg(input.teams);
  const units = normalizeOrganizationUnits(input.structure, organization);
  const referencedTeamNames = collectReferencedTeamNames(units);
  const unitNodeIdById = new Map(units.map((unit) => [unit.id, getNodeIdForUnit(unit)]));
  const rootNodeId = unitNodeIdById.get(organization.rootNodeId) ?? organization.rootNodeId;
  const nodeById = new Map<string, OrgNodeModel>();
  const relations: OrgRelationModel[] = [];
  const renderedTeamNames: string[] = [];
  const renderedTeamNameSet = new Set<string>();

  for (const unit of units) {
    const nodeId = getNodeIdForUnit(unit);
    if (nodeById.has(nodeId)) {
      warnings.push(`Skipped duplicate organization unit "${unit.id}".`);
      continue;
    }

    const teamName = unit.kind === 'team' ? getTeamNameForUnit(unit) : undefined;
    const team = teamName ? teamsByName.get(teamName) : undefined;
    if (teamName && renderedTeamNameSet.has(teamName)) {
      warnings.push(`Skipped duplicate team reference "${teamName}".`);
      continue;
    }

    const shouldProjectTeam =
      Boolean(team) && renderedTeamNames.length < input.maxTeams && unit.kind === 'team';
    if (teamName && team && !shouldProjectTeam) {
      continue;
    }
    if (teamName && team) {
      renderedTeamNameSet.add(teamName);
      if (shouldProjectTeam) {
        renderedTeamNames.push(teamName);
      }
    }

    nodeById.set(nodeId, {
      id: nodeId,
      structureUnitId: unit.id,
      kind: unit.kind,
      label: unit.label,
      description:
        unit.description ??
        (teamName && !team
          ? `Team "${teamName}" is referenced by the organization but was not found.`
          : undefined),
      color: unit.color ?? team?.color,
      parentNodeId: resolveParentNodeId(unit, rootNodeId, unitNodeIdById),
      title: unit.title,
      tags: unit.tags,
      team: shouldProjectTeam
        ? projectOrgTeam(team!, { ...input, displayNameOverride: unit.label })
        : undefined,
    });
  }

  if (!nodeById.has(rootNodeId)) {
    nodeById.set(rootNodeId, {
      id: rootNodeId,
      kind: 'organization',
      label: organization.name,
      description: organization.description,
      color: '#4f8cff',
      parentNodeId: null,
    });
  }

  for (const node of nodeById.values()) {
    if (node.id === rootNodeId) continue;
    const parentNodeId = node.parentNodeId ?? rootNodeId;
    if (!nodeById.has(parentNodeId)) {
      warnings.push(
        `Reattached "${node.label}" to the organization root because its parent is missing.`
      );
      node.parentNodeId = rootNodeId;
    }
    relations.push({
      id: getRelationId('contains', node.parentNodeId ?? rootNodeId, node.id),
      sourceNodeId: node.parentNodeId ?? rootNodeId,
      targetNodeId: node.id,
      kind: 'contains',
      sourceKind: 'manual',
      weight: 1,
    });
  }

  const remainingSlots = Math.max(0, input.maxTeams - renderedTeamNames.length);
  const unassignedTeams = sortedTeams
    .filter((team) => !referencedTeamNames.has(team.teamName))
    .slice(0, remainingSlots);
  if (unassignedTeams.length > 0) {
    const unassignedNodeId = getAvailableNodeId(
      getOrgUnitNodeId(`${organization.id}:unassigned-teams`),
      nodeById
    );
    nodeById.set(unassignedNodeId, {
      id: unassignedNodeId,
      kind: 'container',
      label: 'Unassigned Teams',
      description: 'Teams that are not placed in this organization yet.',
      color: '#64748b',
      parentNodeId: rootNodeId,
      tags: ['system', 'unassigned'],
    });
    relations.push({
      id: getRelationId('contains', rootNodeId, unassignedNodeId),
      sourceNodeId: rootNodeId,
      targetNodeId: unassignedNodeId,
      kind: 'contains',
      sourceKind: 'inferred',
      weight: 1,
    });

    for (const team of unassignedTeams) {
      const teamNodeId = getTeamNodeId(team.teamName);
      nodeById.set(teamNodeId, {
        id: teamNodeId,
        kind: 'team',
        label: team.displayName,
        description: team.description,
        color: team.color,
        parentNodeId: unassignedNodeId,
        team: projectOrgTeam(team, input),
      });
      relations.push({
        id: getRelationId('contains', unassignedNodeId, teamNodeId),
        sourceNodeId: unassignedNodeId,
        targetNodeId: teamNodeId,
        kind: 'contains',
        sourceKind: 'inferred',
        weight: 1,
      });
      renderedTeamNames.push(team.teamName);
    }
  }

  relations.push(
    ...projectConfiguredRelations({
      relations: input.structure.relations ?? [],
      organizationId: organization.id,
      nodeById,
      unitNodeIdById,
      teamsByName,
      warnings,
    })
  );

  return {
    organization: {
      ...organization,
      rootNodeId,
      updatedAt: organization.updatedAt ?? input.structure.updatedAt ?? input.generatedAt,
    },
    nodes: [...nodeById.values()],
    relations,
    renderedTeamNames,
    truncatedTeams: Math.max(0, sortedTeams.length - renderedTeamNames.length),
    warnings,
  };
}

function getAvailableNodeId(
  baseNodeId: string,
  nodeById: ReadonlyMap<string, OrgNodeModel>
): string {
  if (!nodeById.has(baseNodeId)) {
    return baseNodeId;
  }

  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${baseNodeId}-${suffix}`;
    if (!nodeById.has(candidate)) {
      return candidate;
    }
  }

  return `${baseNodeId}-${nodeById.size + 1}`;
}

function getScopedUnitKey(organizationId: string, unitId: string): string {
  return `${organizationId}\0${unitId}`;
}

function getAllScopeNodeIdForUnit(unit: OrgUnitModel, organizationId: string): string {
  if (unit.kind === 'organization') {
    return getAllScopeOrganizationNodeId(organizationId);
  }
  if (unit.kind === 'team') {
    return getOrgUnitNodeId(`${organizationId}:${unit.id}`);
  }
  return getOrgUnitNodeId(`${organizationId}:${unit.id}`);
}

function resolveAllScopeParentNodeId(params: {
  organizationId: string;
  parentId: string | null;
  rootNodeId: string;
  scopedUnitNodeIdByKey: ReadonlyMap<string, string>;
}): string {
  if (!params.parentId) {
    return params.rootNodeId;
  }
  return (
    params.scopedUnitNodeIdByKey.get(getScopedUnitKey(params.organizationId, params.parentId)) ??
    params.rootNodeId
  );
}

function selectOrganization(
  structure: OrgStructureModel,
  requestedOrganizationId: string | undefined,
  generatedAt: string
): OrgSummaryModel | null {
  const requested = requestedOrganizationId
    ? normalizeOrganizationId(requestedOrganizationId)
    : undefined;
  const selected =
    (requested
      ? structure.organizations.find((organization) => organization.id === requested)
      : undefined) ??
    structure.organizations[0] ??
    null;

  if (!selected) return null;

  return {
    ...selected,
    rootNodeId: selected.rootNodeId || getOrganizationNodeId(selected.id),
    updatedAt: selected.updatedAt ?? structure.updatedAt ?? generatedAt,
  };
}

function normalizeOrganizationUnits(
  structure: OrgStructureModel,
  organization: OrgSummaryModel
): OrgUnitModel[] {
  const selectedUnits = structure.units.filter(
    (unit) => unit.organizationId === organization.id || unit.organizationId.length === 0
  );
  const hasRoot = selectedUnits.some((unit) => unit.id === organization.rootNodeId);
  const rootUnit: OrgUnitModel = {
    id: organization.rootNodeId,
    organizationId: organization.id,
    parentId: null,
    kind: 'organization',
    label: organization.name,
    description: organization.description,
    color: '#4f8cff',
  };
  return hasRoot ? selectedUnits : [rootUnit, ...selectedUnits];
}

function getNodeIdForUnit(unit: OrgUnitModel): string {
  if (unit.kind === 'organization') {
    return unit.id.startsWith('org:') ? unit.id : getOrganizationNodeId(unit.id);
  }
  if (unit.kind === 'team') {
    return getTeamNodeId(getTeamNameForUnit(unit));
  }
  return getOrgUnitNodeId(unit.id);
}

function getTeamNameForUnit(unit: OrgUnitModel): string {
  if (unit.teamName) {
    return unit.teamName;
  }
  return unit.id.startsWith('team:') ? unit.id.slice('team:'.length) : unit.id;
}

function resolveParentNodeId(
  unit: OrgUnitModel,
  rootNodeId: string,
  unitNodeIdById: ReadonlyMap<string, string>
): string | null {
  if (!unit.parentId) {
    return unit.kind === 'organization' ? null : rootNodeId;
  }
  return unitNodeIdById.get(unit.parentId) ?? getOrgUnitNodeId(unit.parentId);
}

function resolveRelationNodeId(params: {
  rawNodeId: string;
  nodeById: ReadonlyMap<string, OrgNodeModel>;
  unitNodeIdById: ReadonlyMap<string, string>;
  teamsByName: ReadonlyMap<string, OrgTeamCandidate>;
}): string | null {
  if (params.nodeById.has(params.rawNodeId)) {
    return params.rawNodeId;
  }
  const unitNodeId = params.unitNodeIdById.get(params.rawNodeId);
  if (unitNodeId && params.nodeById.has(unitNodeId)) {
    return unitNodeId;
  }
  if (params.teamsByName.has(params.rawNodeId)) {
    const teamNodeId = getTeamNodeId(params.rawNodeId);
    return params.nodeById.has(teamNodeId) ? teamNodeId : null;
  }
  const genericNodeId = getOrgUnitNodeId(params.rawNodeId);
  return params.nodeById.has(genericNodeId) ? genericNodeId : null;
}

function projectConfiguredRelations(params: {
  relations: readonly OrgRelationDefinitionModel[];
  organizationId: string;
  nodeById: ReadonlyMap<string, OrgNodeModel>;
  unitNodeIdById: ReadonlyMap<string, string>;
  teamsByName: ReadonlyMap<string, OrgTeamCandidate>;
  warnings: string[];
}): OrgRelationModel[] {
  const projected: OrgRelationModel[] = [];
  for (const relation of params.relations) {
    if (relation.organizationId && relation.organizationId !== params.organizationId) {
      continue;
    }
    if (relation.kind === 'contains') {
      continue;
    }

    const sourceNodeId = resolveRelationNodeId({
      rawNodeId: relation.sourceNodeId,
      nodeById: params.nodeById,
      unitNodeIdById: params.unitNodeIdById,
      teamsByName: params.teamsByName,
    });
    const targetNodeId = resolveRelationNodeId({
      rawNodeId: relation.targetNodeId,
      nodeById: params.nodeById,
      unitNodeIdById: params.unitNodeIdById,
      teamsByName: params.teamsByName,
    });

    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
      params.warnings.push(
        `Skipped invalid organization relation "${relation.id ?? relation.kind}".`
      );
      continue;
    }

    projected.push({
      id: relation.id ?? getRelationId(relation.kind, sourceNodeId, targetNodeId),
      sourceNodeId,
      targetNodeId,
      kind: relation.kind,
      sourceKind: relation.sourceKind,
      weight: relation.weight ?? 1,
      label: relation.label,
    });
  }
  return projected;
}

function resolveAllScopeRelationNodeId(params: {
  rawNodeId: string;
  organizationId?: string;
  nodeById: ReadonlyMap<string, OrgNodeModel>;
  scopedUnitNodeIdByKey: ReadonlyMap<string, string>;
  unitNodeIdsByRawId: ReadonlyMap<string, ReadonlySet<string>>;
  warnings: string[];
}): string | null {
  if (params.nodeById.has(params.rawNodeId)) {
    return params.rawNodeId;
  }
  if (params.organizationId) {
    const scopedNodeId = params.scopedUnitNodeIdByKey.get(
      getScopedUnitKey(params.organizationId, params.rawNodeId)
    );
    if (scopedNodeId && params.nodeById.has(scopedNodeId)) {
      return scopedNodeId;
    }
    const organizationNodeId = getAllScopeOrganizationNodeId(params.rawNodeId);
    if (params.nodeById.has(organizationNodeId)) {
      return organizationNodeId;
    }
  }
  const rawUnitMatches = params.unitNodeIdsByRawId.get(params.rawNodeId);
  if (rawUnitMatches?.size === 1) {
    const [nodeId] = rawUnitMatches;
    return nodeId && params.nodeById.has(nodeId) ? nodeId : null;
  }
  if (rawUnitMatches && rawUnitMatches.size > 1) {
    params.warnings.push(`Skipped ambiguous organization relation endpoint "${params.rawNodeId}".`);
    return null;
  }

  const teamNodeId = getTeamNodeId(params.rawNodeId);
  if (params.nodeById.has(teamNodeId)) {
    return teamNodeId;
  }

  const genericNodeId = getOrgUnitNodeId(params.rawNodeId);
  return params.nodeById.has(genericNodeId) ? genericNodeId : null;
}

function projectAllScopeConfiguredRelations(params: {
  relations: readonly OrgRelationDefinitionModel[];
  nodeById: ReadonlyMap<string, OrgNodeModel>;
  scopedUnitNodeIdByKey: ReadonlyMap<string, string>;
  unitNodeIdsByRawId: ReadonlyMap<string, ReadonlySet<string>>;
  warnings: string[];
}): OrgRelationModel[] {
  const projected: OrgRelationModel[] = [];
  for (const relation of params.relations) {
    if (relation.kind === 'contains') {
      continue;
    }

    const sourceNodeId = resolveAllScopeRelationNodeId({
      rawNodeId: relation.sourceNodeId,
      organizationId: relation.organizationId,
      nodeById: params.nodeById,
      scopedUnitNodeIdByKey: params.scopedUnitNodeIdByKey,
      unitNodeIdsByRawId: params.unitNodeIdsByRawId,
      warnings: params.warnings,
    });
    const targetNodeId = resolveAllScopeRelationNodeId({
      rawNodeId: relation.targetNodeId,
      organizationId: relation.organizationId,
      nodeById: params.nodeById,
      scopedUnitNodeIdByKey: params.scopedUnitNodeIdByKey,
      unitNodeIdsByRawId: params.unitNodeIdsByRawId,
      warnings: params.warnings,
    });

    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
      params.warnings.push(
        `Skipped invalid organization relation "${relation.id ?? relation.kind}".`
      );
      continue;
    }

    projected.push({
      id: relation.id ?? getRelationId(relation.kind, sourceNodeId, targetNodeId),
      sourceNodeId,
      targetNodeId,
      kind: relation.kind,
      sourceKind: relation.sourceKind,
      weight: relation.weight ?? 1,
      label: relation.label,
    });
  }
  return projected;
}

export function hasContainmentCycle(relations: readonly OrgRelationModel[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== 'contains') continue;
    const list = adjacency.get(relation.sourceNodeId) ?? [];
    list.push(relation.targetNodeId);
    adjacency.set(relation.sourceNodeId, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visited.has(nodeId)) return false;
    if (visiting.has(nodeId)) return true;
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const nodeId of adjacency.keys()) {
    if (visit(nodeId)) {
      return true;
    }
  }

  return false;
}
