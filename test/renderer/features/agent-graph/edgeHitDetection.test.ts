import { describe, expect, it } from 'vitest';

import {
  collectInteractiveEdgesInViewport,
  findEdgeAt,
  findNodeAt,
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
    domainRef: id.startsWith('task')
      ? { kind: 'task', teamName: 'my-team', taskId: id }
      : { kind: 'member', teamName: 'my-team', memberName: id },
  } as GraphNode;
}

describe('edge hit detection', () => {
  it('does not hit nodes hidden by semantic zoom or layout state', () => {
    const task = {
      ...makeNode('task:detail', 0, 0),
      taskZoomVisibility: 'detail' as const,
    };
    const team = {
      ...makeNode('member:team', 0, 0),
      visualVariant: 'team' as const,
    };
    const layoutOnly = { ...makeNode('member:layout', 0, 0), layoutOnly: true };

    expect(findNodeAt(0, 0, [task], 0.3)).toBeNull();
    expect(findNodeAt(0, 0, [task], 0.8)).toBe(task.id);
    expect(findNodeAt(0, 0, [team], 0.1)).toBeNull();
    expect(findNodeAt(0, 0, [layoutOnly], 1)).toBeNull();
  });

  it('detects blocking edges near the curve midpoint', () => {
    const nodes = [makeNode('member:alice', 0, 0), makeNode('task:1', 160, 90)];
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

  it('keeps runtime message edges inspectable at far zoom without widening normal edges', () => {
    const nodes = [makeNode('member:alice', 0, 0), makeNode('member:bob', 180, 0)];
    const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
    const messageEdge: GraphEdge = {
      id: 'edge:message',
      source: 'member:alice',
      target: 'member:bob',
      type: 'message',
    };
    const ownershipEdge: GraphEdge = {
      ...messageEdge,
      id: 'edge:ownership',
      type: 'ownership',
    };
    const midpoint = getEdgeMidpoint(messageEdge, nodeMap);

    expect(midpoint).not.toBeNull();
    const inspectPoint = { x: midpoint!.x, y: midpoint!.y + 30 };

    expect(findEdgeAt(inspectPoint.x, inspectPoint.y, [messageEdge], nodeMap)).toBeNull();
    expect(findEdgeAt(inspectPoint.x, inspectPoint.y, [messageEdge], nodeMap, 0.25)).toBe(
      'edge:message'
    );
    expect(findEdgeAt(inspectPoint.x, inspectPoint.y, [ownershipEdge], nodeMap, 0.25)).toBeNull();
  });

  it('keeps visible graph edges as interactive hit-test candidates', () => {
    const nodes = [
      makeNode('task:blocker', 0, 0),
      makeNode('task:blocked', 180, 90),
      makeNode('task:offscreen-a', 1200, 1200),
      makeNode('task:offscreen-b', 1360, 1280),
      makeNode('task:message-target', 220, 140),
    ];
    const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
    const edges: GraphEdge[] = [
      {
        id: 'edge:blocking:visible',
        source: 'task:blocker',
        target: 'task:blocked',
        type: 'blocking',
      },
      {
        id: 'edge:blocking:hidden',
        source: 'task:offscreen-a',
        target: 'task:offscreen-b',
        type: 'blocking',
      },
      { id: 'edge:ownership', source: 'task:blocker', target: 'task:blocked', type: 'ownership' },
      {
        id: 'edge:message',
        source: 'task:blocker',
        target: 'task:message-target',
        type: 'message',
      },
      {
        id: 'edge:related',
        source: 'task:blocked',
        target: 'task:message-target',
        type: 'related',
      },
    ];

    const interactive = collectInteractiveEdgesInViewport(edges, nodeMap, {
      left: -200,
      top: -200,
      right: 400,
      bottom: 260,
    });

    expect(interactive.map((edge) => edge.id)).toEqual([
      'edge:blocking:visible',
      'edge:ownership',
      'edge:message',
      'edge:related',
    ]);
  });

  it('excludes ownership edges from hit testing outside detail zoom', () => {
    const nodes = [makeNode('member:alice', 0, 0), makeNode('task:1', 160, 90)];
    const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
    const edge: GraphEdge = {
      id: 'edge:ownership',
      source: 'member:alice',
      target: 'task:1',
      type: 'ownership',
    };
    const midpoint = getEdgeMidpoint(edge, nodeMap)!;
    const viewport = { left: -200, top: -200, right: 400, bottom: 300 };

    expect(findEdgeAt(midpoint.x, midpoint.y, [edge], nodeMap, 0.4)).toBeNull();
    expect(collectInteractiveEdgesInViewport([edge], nodeMap, viewport, 0.4)).toEqual([]);
    expect(findEdgeAt(midpoint.x, midpoint.y, [edge], nodeMap, 0.8)).toBe(edge.id);
  });

  it('hit-tests orthogonal hierarchy connectors by their routed segments', () => {
    const source = {
      ...makeNode('org:root', 0, 0),
      visualVariant: 'organization' as const,
    };
    const target = {
      ...makeNode('team:alpha', 220, 164),
      visualVariant: 'team' as const,
    };
    const nodeMap = new Map<string, GraphNode>([
      [source.id, source],
      [target.id, target],
    ]);
    const edge: GraphEdge = {
      id: 'contains:root:alpha',
      source: source.id,
      target: target.id,
      type: 'parent-child',
      routing: 'orthogonal',
    };
    const midpoint = getEdgeMidpoint(edge, nodeMap);

    expect(midpoint).not.toBeNull();
    expect(findEdgeAt(midpoint!.x, midpoint!.y, [edge], nodeMap)).toBe(edge.id);
  });
});
