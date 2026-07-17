import type {
  OrganizationMapPayload,
  OrganizationNodeDto,
  OrganizationRelationDto,
} from '../../contracts';

export interface OrganizationMapStats {
  teamCount: number;
  onlineTeamCount: number;
  agentCount: number;
  activeAgentCount: number;
  communicationEdgeCount: number;
  manualRelationCount: number;
  linkCount: number;
}

export interface OrganizationMapViewModel {
  payload: OrganizationMapPayload;
  rootNode: OrganizationNodeDto | null;
  organizationNodes: OrganizationNodeDto[];
  teamNodes: OrganizationNodeDto[];
  containsRelations: OrganizationRelationDto[];
  communicationRelations: OrganizationRelationDto[];
  manualRelations: OrganizationRelationDto[];
  nodeById: ReadonlyMap<string, OrganizationNodeDto>;
  childNodeIdsByParentId: ReadonlyMap<string, readonly string[]>;
  parentNodeIdByChildId: ReadonlyMap<string, string>;
  nodeDisplayOrder: string[];
  stats: OrganizationMapStats;
}

function getTimeMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildOrganizationMapViewModel(
  payload: OrganizationMapPayload
): OrganizationMapViewModel {
  const nodeById = new Map(payload.nodes.map((node) => [node.id, node]));
  const activeOrganization =
    payload.organizations.find(
      (organization) => organization.id === payload.activeOrganizationId
    ) ?? payload.organizations[0];
  const configuredRootNode = payload.rootNodeId ? nodeById.get(payload.rootNodeId) : undefined;
  const rootNode =
    configuredRootNode ??
    payload.nodes.find((node) => node.id === activeOrganization?.rootNodeId) ??
    payload.nodes.find((node) => node.kind === 'organization') ??
    null;
  const organizationNodes = payload.nodes;
  const teamNodes = payload.nodes.filter((node) => node.kind === 'team' && node.team);
  const containsRelations = payload.relations.filter((relation) => relation.kind === 'contains');
  const childNodeIdsByParentId = buildChildIndex(containsRelations);
  const parentNodeIdByChildId = buildParentIndex(containsRelations);
  const nodeDisplayOrder = buildContainmentOrder({
    rootNodeId: rootNode?.id,
    nodes: payload.nodes,
    childNodeIdsByParentId,
  });
  const communicationRelations = payload.relations
    .filter((relation) => relation.kind === 'communicates' && relation.sourceKind === 'runtime')
    .sort((left, right) => getTimeMs(right.lastActivityAt) - getTimeMs(left.lastActivityAt));
  const manualRelations = payload.relations.filter(
    (relation) => relation.sourceKind === 'manual' && relation.kind !== 'contains'
  );

  let agentCount = 0;
  let activeAgentCount = 0;
  let onlineTeamCount = 0;

  for (const node of teamNodes) {
    const team = node.team;
    if (!team) continue;
    if (team.isOnline) onlineTeamCount += 1;
    agentCount += team.memberCount;
    activeAgentCount += team.agents.filter((agent) => agent.status === 'active').length;
  }

  return {
    payload,
    rootNode,
    organizationNodes,
    teamNodes,
    containsRelations,
    communicationRelations,
    manualRelations,
    nodeById,
    childNodeIdsByParentId,
    parentNodeIdByChildId,
    nodeDisplayOrder,
    stats: {
      teamCount: teamNodes.length,
      onlineTeamCount,
      agentCount,
      activeAgentCount,
      communicationEdgeCount: communicationRelations.length,
      manualRelationCount: manualRelations.length,
      linkCount: communicationRelations.length + manualRelations.length,
    },
  };
}

function buildParentIndex(
  containsRelations: readonly OrganizationRelationDto[]
): Map<string, string> {
  return new Map(
    containsRelations.map((relation) => [relation.targetNodeId, relation.sourceNodeId] as const)
  );
}

function buildChildIndex(
  containsRelations: readonly OrganizationRelationDto[]
): Map<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const relation of containsRelations) {
    const list = index.get(relation.sourceNodeId) ?? [];
    list.push(relation.targetNodeId);
    index.set(relation.sourceNodeId, list);
  }
  for (const [parentId, childIds] of index) {
    index.set(parentId, childIds.slice().sort());
  }
  return index;
}

function buildContainmentOrder(input: {
  rootNodeId: string | undefined;
  nodes: readonly OrganizationNodeDto[];
  childNodeIdsByParentId: ReadonlyMap<string, readonly string[]>;
}): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  const visit = (nodeId: string): void => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    order.push(nodeId);
    for (const childId of input.childNodeIdsByParentId.get(nodeId) ?? []) {
      visit(childId);
    }
  };

  if (input.rootNodeId) {
    visit(input.rootNodeId);
  }

  for (const node of input.nodes) {
    visit(node.id);
  }

  return order;
}

export function getNodeDisplayLabel(node: OrganizationNodeDto | null | undefined): string {
  return node?.team?.displayName || node?.label || '';
}

export function getOrganizationIdForNodeId(
  viewModel: OrganizationMapViewModel,
  nodeId: string | null | undefined
): string | null {
  if (!nodeId) return null;

  const rootNodeId = viewModel.rootNode?.id;
  const rootNodeIdByOrganizationId = new Map(
    viewModel.payload.organizations.map((organization) => [
      organization.rootNodeId,
      organization.id,
    ])
  );
  let currentNodeId: string | undefined = nodeId;
  const seen = new Set<string>();

  while (currentNodeId && !seen.has(currentNodeId)) {
    seen.add(currentNodeId);
    if (currentNodeId !== rootNodeId) {
      const organizationId = rootNodeIdByOrganizationId.get(currentNodeId);
      if (organizationId) {
        return organizationId;
      }
    }
    currentNodeId = viewModel.parentNodeIdByChildId.get(currentNodeId);
  }

  return null;
}
