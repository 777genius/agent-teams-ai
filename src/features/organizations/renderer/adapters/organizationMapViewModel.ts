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

export interface OrganizationOverviewGroup {
  nodeId: string;
  label: string;
  teamCount: number;
}

export interface OrganizationOverviewSummary {
  organizationId: string;
  rootNodeId: string;
  name: string;
  color: string;
  groupCount: number;
  teamCount: number;
  onlineTeamCount: number;
  agentCount: number;
  activeTaskCount: number;
  taskCount: number;
  attentionCount: number;
  healthPercent: number;
  largestGroups: OrganizationOverviewGroup[];
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
  organizationOverviews: OrganizationOverviewSummary[];
  stats: OrganizationMapStats;
}

interface DescendantOverviewStats {
  groupCount: number;
  teamCount: number;
  onlineTeamCount: number;
  agentCount: number;
  activeTaskCount: number;
  taskCount: number;
}

function collectOverviewStats(
  nodeId: string,
  nodeById: ReadonlyMap<string, OrganizationNodeDto>,
  childNodeIdsByParentId: ReadonlyMap<string, readonly string[]>,
  seen = new Set<string>()
): DescendantOverviewStats {
  if (seen.has(nodeId)) {
    return {
      groupCount: 0,
      teamCount: 0,
      onlineTeamCount: 0,
      agentCount: 0,
      activeTaskCount: 0,
      taskCount: 0,
    };
  }
  seen.add(nodeId);

  const node = nodeById.get(nodeId);
  if (node?.kind === 'team') {
    const team = node.team;
    return {
      groupCount: 0,
      teamCount: 1,
      onlineTeamCount: team?.isOnline ? 1 : 0,
      agentCount: team?.memberCount ?? 0,
      activeTaskCount: team?.taskCounts.inProgress ?? 0,
      taskCount: team
        ? team.taskCounts.pending + team.taskCounts.inProgress + team.taskCounts.completed
        : 0,
    };
  }

  return (childNodeIdsByParentId.get(nodeId) ?? []).reduce<DescendantOverviewStats>(
    (total, childNodeId) => {
      const child = collectOverviewStats(childNodeId, nodeById, childNodeIdsByParentId, seen);
      return {
        groupCount: total.groupCount + child.groupCount,
        teamCount: total.teamCount + child.teamCount,
        onlineTeamCount: total.onlineTeamCount + child.onlineTeamCount,
        agentCount: total.agentCount + child.agentCount,
        activeTaskCount: total.activeTaskCount + child.activeTaskCount,
        taskCount: total.taskCount + child.taskCount,
      };
    },
    {
      groupCount: node ? 1 : 0,
      teamCount: 0,
      onlineTeamCount: 0,
      agentCount: 0,
      activeTaskCount: 0,
      taskCount: 0,
    }
  );
}

function buildOrganizationOverviews(
  payload: OrganizationMapPayload,
  nodeById: ReadonlyMap<string, OrganizationNodeDto>,
  childNodeIdsByParentId: ReadonlyMap<string, readonly string[]>
): OrganizationOverviewSummary[] {
  return payload.organizations.flatMap((organization) => {
    const rootNode = nodeById.get(organization.rootNodeId);
    if (!rootNode) return [];

    const stats = collectOverviewStats(rootNode.id, nodeById, childNodeIdsByParentId);
    const groups = (childNodeIdsByParentId.get(rootNode.id) ?? []).flatMap((nodeId) => {
      const node = nodeById.get(nodeId);
      if (!node || node.kind === 'team') return [];
      return [
        {
          nodeId,
          label: getNodeDisplayLabel(node),
          teamCount: collectOverviewStats(nodeId, nodeById, childNodeIdsByParentId).teamCount,
        },
      ];
    });
    const largestGroups = groups
      .toSorted(
        (left, right) => right.teamCount - left.teamCount || left.label.localeCompare(right.label)
      )
      .slice(0, 5);
    const attentionCount = Math.max(0, stats.teamCount - stats.onlineTeamCount);
    const healthPercent =
      stats.teamCount === 0 ? 100 : Math.round((stats.onlineTeamCount / stats.teamCount) * 100);

    return [
      {
        organizationId: organization.id,
        rootNodeId: rootNode.id,
        name: organization.name || getNodeDisplayLabel(rootNode),
        color: rootNode.color ?? '#4f8cff',
        groupCount: Math.max(0, stats.groupCount - 1),
        teamCount: stats.teamCount,
        onlineTeamCount: stats.onlineTeamCount,
        agentCount: stats.agentCount,
        activeTaskCount: stats.activeTaskCount,
        taskCount: stats.taskCount,
        attentionCount,
        healthPercent,
        largestGroups,
      },
    ];
  });
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
  const organizationOverviews = buildOrganizationOverviews(
    payload,
    nodeById,
    childNodeIdsByParentId
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
    organizationOverviews,
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
