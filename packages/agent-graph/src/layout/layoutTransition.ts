import type { GraphEdge, GraphNode } from '../ports/types';

export interface GraphLayoutPosition {
  x: number;
  y: number;
}

export interface GraphLayoutTransition {
  elapsed: number;
  duration: number;
  fromByNodeId: Map<string, GraphLayoutPosition>;
  toByNodeId: Map<string, GraphLayoutPosition>;
}

export function captureGraphNodePositions(
  nodes: readonly GraphNode[]
): Map<string, GraphLayoutPosition> {
  const positions = new Map<string, GraphLayoutPosition>();
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    positions.set(node.id, { x: node.x, y: node.y });
  }
  return positions;
}

export function easeGraphLayoutTransition(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

export function createGraphLayoutTransition(args: {
  nodes: GraphNode[];
  edges: readonly GraphEdge[];
  previousPositions: ReadonlyMap<string, GraphLayoutPosition>;
  duration: number;
}): GraphLayoutTransition | null {
  const { nodes, edges, previousPositions, duration } = args;
  if (duration <= 0 || previousPositions.size === 0) return null;

  const toByNodeId = captureGraphNodePositions(nodes);
  if (toByNodeId.size === 0) return null;

  const adjacency = buildStructuralAdjacency(edges);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const fromByNodeId = new Map<string, GraphLayoutPosition>();

  for (const node of nodes) {
    const target = toByNodeId.get(node.id);
    if (!target) continue;
    const start =
      previousPositions.get(node.id) ??
      (node.ownerId ? previousPositions.get(node.ownerId) : undefined) ??
      findNearestPreviousPosition(node.id, adjacency, previousPositions) ??
      target;
    fromByNodeId.set(node.id, start);
    setGraphNodePosition(nodeById.get(node.id), start);
  }

  return {
    elapsed: 0,
    duration,
    fromByNodeId,
    toByNodeId,
  };
}

export function advanceGraphLayoutTransition(
  nodes: GraphNode[],
  transition: GraphLayoutTransition,
  dt: number
): boolean {
  transition.elapsed = Math.min(transition.duration, transition.elapsed + Math.max(0, dt));
  const progress = easeGraphLayoutTransition(transition.elapsed / transition.duration);

  for (const node of nodes) {
    const from = transition.fromByNodeId.get(node.id);
    const target = transition.toByNodeId.get(node.id);
    if (!from || !target) continue;
    setGraphNodePosition(node, {
      x: from.x + (target.x - from.x) * progress,
      y: from.y + (target.y - from.y) * progress,
    });
  }

  return transition.elapsed >= transition.duration;
}

function buildStructuralAdjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.type !== 'parent-child' && edge.type !== 'ownership') continue;
    addNeighbor(adjacency, edge.source, edge.target);
    addNeighbor(adjacency, edge.target, edge.source);
  }
  return adjacency;
}

function addNeighbor(
  adjacency: Map<string, Set<string>>,
  nodeId: string,
  neighborId: string
): void {
  const neighbors = adjacency.get(nodeId) ?? new Set<string>();
  neighbors.add(neighborId);
  adjacency.set(nodeId, neighbors);
}

function findNearestPreviousPosition(
  nodeId: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  previousPositions: ReadonlyMap<string, GraphLayoutPosition>
): GraphLayoutPosition | null {
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];

  for (let depth = 0; depth < 5 && frontier.length > 0; depth += 1) {
    const { nextFrontier, matches } = collectTransitionFrontier(
      frontier,
      adjacency,
      previousPositions,
      visited
    );
    if (matches.length > 0) return averagePositions(matches);
    frontier = nextFrontier;
  }
  return null;
}

function collectTransitionFrontier(
  frontier: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  previousPositions: ReadonlyMap<string, GraphLayoutPosition>,
  visited: Set<string>
): { nextFrontier: string[]; matches: GraphLayoutPosition[] } {
  const nextFrontier: string[] = [];
  const matches: GraphLayoutPosition[] = [];
  for (const currentId of frontier) {
    for (const neighborId of adjacency.get(currentId) ?? []) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      nextFrontier.push(neighborId);
      const position = previousPositions.get(neighborId);
      if (position) matches.push(position);
    }
  }
  return { nextFrontier, matches };
}

function averagePositions(positions: readonly GraphLayoutPosition[]): GraphLayoutPosition {
  const total = positions.reduce(
    (sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }),
    { x: 0, y: 0 }
  );
  return { x: total.x / positions.length, y: total.y / positions.length };
}

function setGraphNodePosition(node: GraphNode | undefined, position: GraphLayoutPosition): void {
  if (!node) return;
  node.x = position.x;
  node.y = position.y;
  node.fx = position.x;
  node.fy = position.y;
  node.vx = 0;
  node.vy = 0;
}
