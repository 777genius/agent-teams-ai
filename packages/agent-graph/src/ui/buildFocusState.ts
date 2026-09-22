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
  selectedEdgeId: string | null,
  nodes: GraphNode[],
  edges: GraphEdge[]
): GraphFocusState {
  if (!selectedNodeId && !selectedEdgeId) {
    return { focusNodeIds: null, focusEdgeIds: null };
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const adjacency = new Map<string, GraphEdge[]>();

  for (const edge of edges) {
    const sourceEdges = adjacency.get(edge.source) ?? [];
    sourceEdges.push(edge);
    adjacency.set(edge.source, sourceEdges);

    const targetEdges = adjacency.get(edge.target) ?? [];
    targetEdges.push(edge);
    adjacency.set(edge.target, targetEdges);
  }

  if (selectedNodeId == null && selectedEdgeId != null) {
    const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
    if (!selectedEdge || selectedEdge.type !== 'blocking') {
      return { focusNodeIds: null, focusEdgeIds: null };
    }

    const sourceNode = nodeById.get(selectedEdge.source);
    const targetNode = nodeById.get(selectedEdge.target);
    if (!sourceNode || !targetNode) {
      return { focusNodeIds: null, focusEdgeIds: null };
    }

    const nodeIds = new Set<string>([selectedEdge.source, selectedEdge.target]);
    const edgeIds = new Set<string>([selectedEdge.id]);
    const queue = [selectedEdge.source, selectedEdge.target];

    while (queue.length > 0) {
      const currentNodeId = queue.shift()!;
      const currentNode = nodeById.get(currentNodeId);
      if (!currentNode || currentNode.kind !== 'task') {
        continue;
      }

      for (const edge of adjacency.get(currentNodeId) ?? []) {
        if (edge.type !== 'blocking') {
          continue;
        }
        if (!edgeIds.has(edge.id)) {
          edgeIds.add(edge.id);
        }
        const neighborId = edge.source === currentNodeId ? edge.target : edge.source;
        if (!nodeIds.has(neighborId)) {
          nodeIds.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    for (const nodeId of Array.from(nodeIds)) {
      const node = nodeById.get(nodeId);
      if (!node || node.kind !== 'task') {
        continue;
      }
      if (node.ownerId) {
        nodeIds.add(node.ownerId);
      }
      if (node.reviewerName) {
        const reviewerNode = nodes.find(
          (candidate) =>
            candidate.kind === 'member' &&
            candidate.domainRef.kind === 'member' &&
            candidate.domainRef.memberName === node.reviewerName
        );
        if (reviewerNode) {
          nodeIds.add(reviewerNode.id);
        }
      }
      for (const edge of adjacency.get(node.id) ?? []) {
        if (edge.type === 'ownership') {
          edgeIds.add(edge.id);
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
    }

    for (const nodeId of Array.from(nodeIds)) {
      const node = nodeById.get(nodeId);
      if (node?.kind !== 'member') continue;
      for (const edge of adjacency.get(nodeId) ?? []) {
        if (edge.type === 'parent-child') {
          edgeIds.add(edge.id);
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
    }

    return {
      focusNodeIds: nodeIds,
      focusEdgeIds: edgeIds,
    };
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

  const nodeIds = new Set<string>([selectedNode.id]);
  const edgeIds = new Set<string>();

  const selectedMemberName =
    selectedNode.domainRef.kind === 'member' || selectedNode.domainRef.kind === 'lead'
      ? selectedNode.domainRef.memberName
      : null;

  if (selectedNode.kind === 'lead') {
    addNodeAndIncidentEdges(nodeIds, edgeIds, selectedNode.id, adjacency);
  } else if (selectedNode.kind === 'member') {
    addNodeAndIncidentEdges(nodeIds, edgeIds, selectedNode.id, adjacency);

    for (const node of nodes) {
      if (node.kind !== 'task') continue;
      if (node.isOverflowStack) {
        if (node.ownerId === selectedNode.id) {
          nodeIds.add(node.id);
          for (const edge of adjacency.get(node.id) ?? []) {
            edgeIds.add(edge.id);
          }
        }
        continue;
      }

      const isOwnedTask = node.ownerId === selectedNode.id;
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

    for (const edge of adjacency.get(selectedNode.id) ?? []) {
      if (edge.type === 'ownership' || edge.type === 'blocking') {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
      }
    }
  }

  const focusedMemberIds = Array.from(nodeIds).filter((nodeId) => {
    const node = nodeById.get(nodeId);
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
