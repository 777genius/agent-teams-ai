import { getNodeDisplayLabel } from './organizationMapViewModel';

import type { OrganizationNodeDto, OrganizationRelationDto } from '../../contracts';
import type { OrganizationMapViewModel } from './organizationMapViewModel';
import type { GraphDataPort, GraphEdge } from '@claude-teams/agent-graph';

export type OrganizationGraphFocusMode = 'context' | 'path' | 'connections';

export interface OrganizationSearchResult {
  nodeId: string;
  label: string;
  kind: OrganizationNodeDto['kind'];
  pathLabels: string[];
  matchedTaskSubject?: string;
}

export interface OrganizationGraphFocusState {
  focusNodeIds: ReadonlySet<string> | null;
  focusEdgeIds: ReadonlySet<string> | null;
  connectedTeamCount: number;
}

const RELATION_EDGE_TYPES = new Set<GraphEdge['type']>(['blocking', 'related', 'message']);

function normalizeSearchValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim();
}

function getSearchScore(value: string, query: string, baseScore: number): number | null {
  const normalized = normalizeSearchValue(value);
  if (!normalized.includes(query)) return null;
  if (normalized === query) return baseScore;
  if (normalized.startsWith(query)) return baseScore + 10;
  if (normalized.split(/\s+/).some((part) => part.startsWith(query))) return baseScore + 20;
  return baseScore + 30;
}

export function getOrganizationNodePath(
  viewModel: OrganizationMapViewModel,
  nodeId: string | null | undefined
): OrganizationNodeDto[] {
  const path: OrganizationNodeDto[] = [];
  const seen = new Set<string>();
  let currentNodeId = nodeId ?? undefined;

  while (currentNodeId && !seen.has(currentNodeId)) {
    seen.add(currentNodeId);
    const node = viewModel.nodeById.get(currentNodeId);
    if (!node) break;
    path.push(node);
    currentNodeId = viewModel.parentNodeIdByChildId.get(currentNodeId);
  }

  return path.reverse();
}

export function getOrganizationDescendantNodeIds(
  viewModel: OrganizationMapViewModel,
  nodeId: string,
  includeSelf = true
): Set<string> {
  const result = new Set<string>();
  const visit = (candidateId: string): void => {
    if (result.has(candidateId)) return;
    result.add(candidateId);
    for (const childId of viewModel.childNodeIdsByParentId.get(candidateId) ?? []) {
      visit(childId);
    }
  };

  visit(nodeId);
  if (!includeSelf) result.delete(nodeId);
  return result;
}

function getAnchorTeamNodeIds(
  viewModel: OrganizationMapViewModel,
  selectedNodeId: string
): Set<string> {
  return new Set(
    [...getOrganizationDescendantNodeIds(viewModel, selectedNodeId)].filter(
      (nodeId) => viewModel.nodeById.get(nodeId)?.kind === 'team'
    )
  );
}

function collectConnectedTeamNodeIds(
  viewModel: OrganizationMapViewModel,
  anchorTeamNodeIds: ReadonlySet<string>
): Set<string> {
  const connected = new Set<string>();
  const relations: readonly OrganizationRelationDto[] = [
    ...viewModel.manualRelations,
    ...viewModel.communicationRelations,
  ];

  for (const relation of relations) {
    const sourceIsAnchor = anchorTeamNodeIds.has(relation.sourceNodeId);
    const targetIsAnchor = anchorTeamNodeIds.has(relation.targetNodeId);
    if (!sourceIsAnchor && !targetIsAnchor) continue;
    const otherNodeId = sourceIsAnchor ? relation.targetNodeId : relation.sourceNodeId;
    if (
      !anchorTeamNodeIds.has(otherNodeId) &&
      viewModel.nodeById.get(otherNodeId)?.kind === 'team'
    ) {
      connected.add(otherNodeId);
    }
  }

  return connected;
}

export function searchOrganizationNodes(
  viewModel: OrganizationMapViewModel,
  rawQuery: string,
  limit = 8
): OrganizationSearchResult[] {
  const query = normalizeSearchValue(rawQuery);
  if (!query) return [];

  const displayOrderByNodeId = new Map(
    viewModel.nodeDisplayOrder.map((nodeId, index) => [nodeId, index] as const)
  );

  return viewModel.organizationNodes
    .flatMap((node) => {
      const label = getNodeDisplayLabel(node);
      const fields = [
        [label, 0],
        [node.team?.teamName ?? '', 5],
        [node.title ?? '', 40],
        [node.description ?? node.team?.description ?? '', 50],
        [(node.tags ?? []).join(' '), 60],
        [node.team?.agents.map((agent) => `${agent.name} ${agent.role ?? ''}`).join(' ') ?? '', 70],
      ] as const;
      let score = Number.POSITIVE_INFINITY;
      for (const [value, baseScore] of fields) {
        const fieldScore = getSearchScore(value, query, baseScore);
        if (fieldScore !== null) score = Math.min(score, fieldScore);
      }

      const matchedTask = node.team?.agents
        .flatMap((agent) => agent.currentTasks)
        .map((task) => ({ task, score: getSearchScore(task.subject, query, 15) }))
        .filter(
          (entry): entry is { task: typeof entry.task; score: number } => entry.score !== null
        )
        .sort((left, right) => left.score - right.score)[0];
      if (matchedTask) score = Math.min(score, matchedTask.score);
      if (!Number.isFinite(score)) return [];

      return [
        {
          result: {
            nodeId: node.id,
            label,
            kind: node.kind,
            pathLabels: getOrganizationNodePath(viewModel, node.id).map(getNodeDisplayLabel),
            matchedTaskSubject: matchedTask?.task.subject,
          } satisfies OrganizationSearchResult,
          score,
          order: displayOrderByNodeId.get(node.id) ?? Number.MAX_SAFE_INTEGER,
        },
      ];
    })
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, limit)
    .map(({ result }) => result);
}

function addPathNodeIds(
  target: Set<string>,
  viewModel: OrganizationMapViewModel,
  nodeId: string
): void {
  for (const node of getOrganizationNodePath(viewModel, nodeId)) {
    target.add(node.id);
  }
}

function isRelationEdge(edge: GraphEdge): boolean {
  return RELATION_EDGE_TYPES.has(edge.type);
}

export function buildOrganizationGraphFocusState(
  viewModel: OrganizationMapViewModel,
  graphData: GraphDataPort,
  selectedNodeId: string | null,
  mode: OrganizationGraphFocusMode
): OrganizationGraphFocusState {
  if (!selectedNodeId || !viewModel.nodeById.has(selectedNodeId)) {
    return { focusNodeIds: null, focusEdgeIds: null, connectedTeamCount: 0 };
  }

  const pathNodeIds = new Set(
    getOrganizationNodePath(viewModel, selectedNodeId).map((node) => node.id)
  );
  const descendantNodeIds = getOrganizationDescendantNodeIds(viewModel, selectedNodeId);
  const anchorTeamNodeIds = getAnchorTeamNodeIds(viewModel, selectedNodeId);
  const connectedTeamNodeIds = collectConnectedTeamNodeIds(viewModel, anchorTeamNodeIds);
  const organizationFocusNodeIds = new Set<string>();

  if (mode === 'path') {
    pathNodeIds.forEach((nodeId) => organizationFocusNodeIds.add(nodeId));
  } else if (mode === 'connections') {
    organizationFocusNodeIds.add(selectedNodeId);
    anchorTeamNodeIds.forEach((nodeId) => organizationFocusNodeIds.add(nodeId));
    connectedTeamNodeIds.forEach((nodeId) => organizationFocusNodeIds.add(nodeId));
  } else {
    pathNodeIds.forEach((nodeId) => organizationFocusNodeIds.add(nodeId));
    descendantNodeIds.forEach((nodeId) => organizationFocusNodeIds.add(nodeId));
    connectedTeamNodeIds.forEach((nodeId) => {
      addPathNodeIds(organizationFocusNodeIds, viewModel, nodeId);
    });
  }

  const graphNodeIds = new Set(graphData.nodes.map((node) => node.id));
  const focusNodeIds = new Set(
    [...organizationFocusNodeIds].filter((nodeId) => graphNodeIds.has(nodeId))
  );
  const focusedTeamNodeIds = new Set(
    [...organizationFocusNodeIds].filter(
      (nodeId) => viewModel.nodeById.get(nodeId)?.kind === 'team'
    )
  );

  for (const node of graphData.nodes) {
    if (node.ownerId && focusedTeamNodeIds.has(node.ownerId)) {
      focusNodeIds.add(node.id);
    }
  }

  if (mode !== 'path') {
    for (const edge of graphData.edges) {
      if (!isRelationEdge(edge)) continue;
      if (anchorTeamNodeIds.has(edge.source) || anchorTeamNodeIds.has(edge.target)) {
        focusNodeIds.add(edge.source);
        focusNodeIds.add(edge.target);
      }
    }
  }

  const focusEdgeIds = new Set(
    graphData.edges
      .filter((edge) => {
        if (!focusNodeIds.has(edge.source) || !focusNodeIds.has(edge.target)) return false;
        if (mode !== 'connections' || !isRelationEdge(edge)) return true;
        return anchorTeamNodeIds.has(edge.source) || anchorTeamNodeIds.has(edge.target);
      })
      .map((edge) => edge.id)
  );

  return {
    focusNodeIds,
    focusEdgeIds,
    connectedTeamCount: connectedTeamNodeIds.size,
  };
}
