import type { GraphEdge, GraphNode } from '../ports/types';

export interface GraphFocusState {
  focusNodeIds: ReadonlySet<string> | null;
  focusEdgeIds: ReadonlySet<string> | null;
}

function addNode(nodeIds: Set<string>, nodeId: string | null | undefined): void {
  if (nodeId) {
    nodeIds.add(nodeId);
  }
}

function addNodeAndIncidentEdges(
  nodeIds: Set<string>,
  edgeIds: Set<string>,
  nodeId: string | null | undefined,
  adjacency: Map<string, GraphEdge[]>
): void {
  if (!nodeId) return;
  nodeIds.add(nodeId);
  for (const edge of adjacency.get(nodeId) ?? []) {
    edgeIds.add(edge.id);
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
}

export function buildFocusState(
  selectedNodeId: string | null,
  nodes: GraphNode[],
  edges: GraphEdge[]
): GraphFocusState {
  if (!selectedNodeId) {
    return { focusNodeIds: null, focusEdgeIds: null };
  }

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  if (
    !selectedNode ||
    selectedNode.kind === 'process' ||
    selectedNode.kind === 'crossteam' ||
    selectedNode.isOverflowStack
  ) {
    return { focusNodeIds: null, focusEdgeIds: null };
  }

  const nodeIds = new Set<string>([selectedNodeId]);
  const edgeIds = new Set<string>();
  const adjacency = new Map<string, GraphEdge[]>();

  for (const edge of edges) {
    const sourceEdges = adjacency.get(edge.source) ?? [];
    sourceEdges.push(edge);
    adjacency.set(edge.source, sourceEdges);

    const targetEdges = adjacency.get(edge.target) ?? [];
    targetEdges.push(edge);
    adjacency.set(edge.target, targetEdges);
  }

  const selectedMemberName =
    selectedNode.domainRef.kind === 'member' || selectedNode.domainRef.kind === 'lead'
      ? selectedNode.domainRef.memberName
      : null;

  if (selectedNode.kind === 'lead') {
    addNodeAndIncidentEdges(nodeIds, edgeIds, selectedNodeId, adjacency);
  } else if (selectedNode.kind === 'member') {
    addNodeAndIncidentEdges(nodeIds, edgeIds, selectedNodeId, adjacency);

    for (const node of nodes) {
      if (node.kind !== 'task') continue;
      if (node.isOverflowStack) {
        if (node.ownerId === selectedNodeId) {
          nodeIds.add(node.id);
          for (const edge of adjacency.get(node.id) ?? []) {
            edgeIds.add(edge.id);
          }
        }
        continue;
      }

      const isOwnedTask = node.ownerId === selectedNodeId;
      const isReviewTask =
        selectedMemberName != null &&
        node.reviewerName === selectedMemberName &&
        node.domainRef.kind === 'task' &&
        node.domainRef.taskId !== selectedNode.currentTaskId;
      if (!isOwnedTask && !isReviewTask) continue;

      nodeIds.add(node.id);
      for (const edge of adjacency.get(node.id) ?? []) {
        if (edge.type === 'ownership' || edge.type === 'blocking') {
          edgeIds.add(edge.id);
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
    }
  } else if (selectedNode.kind === 'task') {
    if (selectedNode.ownerId) {
      addNode(nodeIds, selectedNode.ownerId);
    }

    if (selectedNode.reviewerName) {
      const reviewerNode = nodes.find(
        (node) =>
          node.kind === 'member' &&
          node.domainRef.kind === 'member' &&
          node.domainRef.memberName === selectedNode.reviewerName
      );
      if (reviewerNode) {
        nodeIds.add(reviewerNode.id);
      }
    }

    for (const edge of adjacency.get(selectedNodeId) ?? []) {
      if (edge.type === 'ownership' || edge.type === 'blocking') {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
      }
    }
  }

  const focusedMemberIds = Array.from(nodeIds).filter((nodeId) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    return node?.kind === 'member';
  });

  for (const memberId of focusedMemberIds) {
    for (const edge of adjacency.get(memberId) ?? []) {
      if (edge.type === 'parent-child') {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
      }
    }
  }

  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      edgeIds.add(edge.id);
    }
  }

  return {
    focusNodeIds: nodeIds,
    focusEdgeIds: edgeIds,
  };
}
