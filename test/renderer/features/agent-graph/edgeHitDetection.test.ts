import { describe, expect, it } from 'vitest';

import {
  collectInteractiveEdgesInViewport,
  findEdgeAt,
  getEdgeMidpoint,
} from '../../../../packages/agent-graph/src/canvas/hit-detection';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';

function makeNode(id: string, x: number, y: number): GraphNode {
  return {
    id,
    kind: id.startsWith('task') ? 'task' : 'member',
    label: id,
    state: 'idle',
    x,
    y,
    domainRef:
      id.startsWith('task')
        ? { kind: 'task', teamName: 'my-team', taskId: id }
        : { kind: 'member', teamName: 'my-team', memberName: id },
  } as GraphNode;
}

describe('edge hit detection', () => {
  it('detects blocking edges near the curve midpoint', () => {
    const nodes = [
      makeNode('member:alice', 0, 0),
      makeNode('task:1', 160, 90),
    ];
    const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
    const edge: GraphEdge = {
      id: 'edge:blocking',
      source: 'member:alice',
      target: 'task:1',
      type: 'blocking',
    };
    const midpoint = getEdgeMidpoint(edge, nodeMap);

    expect(midpoint).not.toBeNull();
    expect(findEdgeAt(midpoint!.x, midpoint!.y, [edge], nodeMap)).toBe('edge:blocking');
  });

  it('prefers the closest edge when multiple curves overlap', () => {
    const nodes = [
      makeNode('member:alice', 0, 0),
      makeNode('task:1', 160, 90),
      makeNode('task:2', 160, 150),
    ];
    const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
    const edges: GraphEdge[] = [
      { id: 'edge:1', source: 'member:alice', target: 'task:1', type: 'ownership' },
      { id: 'edge:2', source: 'member:alice', target: 'task:2', type: 'ownership' },
    ];

    const midpoint = getEdgeMidpoint(edges[0], nodeMap);
    expect(midpoint).not.toBeNull();
    expect(findEdgeAt(midpoint!.x, midpoint!.y, edges, nodeMap)).toBe('edge:1');
  });

  it('only keeps visible blocking edges as interactive hit-test candidates', () => {
    const nodes = [
      makeNode('task:blocker', 0, 0),
      makeNode('task:blocked', 180, 90),
      makeNode('task:offscreen-a', 1200, 1200),
      makeNode('task:offscreen-b', 1360, 1280),
    ];
    const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
    const edges: GraphEdge[] = [
      { id: 'edge:blocking:visible', source: 'task:blocker', target: 'task:blocked', type: 'blocking' },
      { id: 'edge:blocking:hidden', source: 'task:offscreen-a', target: 'task:offscreen-b', type: 'blocking' },
      { id: 'edge:ownership', source: 'task:blocker', target: 'task:blocked', type: 'ownership' },
    ];

    const interactive = collectInteractiveEdgesInViewport(edges, nodeMap, {
      left: -200,
      top: -200,
      right: 400,
      bottom: 260,
    });

    expect(interactive.map((edge) => edge.id)).toEqual(['edge:blocking:visible']);
  });
});
