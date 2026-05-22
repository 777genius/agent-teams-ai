import { describe, expect, it, vi } from 'vitest';

import { drawEdges } from '../../../../packages/agent-graph/src/canvas/draw-edges';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';

function createMockContext(): CanvasRenderingContext2D {
  let fillStyle: string | CanvasGradient | CanvasPattern = '';
  let strokeStyle: string | CanvasGradient | CanvasPattern = '';
  let globalAlpha = 1;

  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    shadowColor: '',
    shadowBlur: 0,
    lineWidth: 1,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = value;
    },
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      strokeStyle = value;
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
    },
  } as unknown as CanvasRenderingContext2D;
}

function createNode(id: string, x: number, y: number): GraphNode {
  return {
    id,
    kind: 'member',
    label: id,
    state: 'active',
    x,
    y,
    domainRef: { kind: 'member', teamName: 'team', memberName: id },
  };
}

const messageEdge: GraphEdge = {
  id: 'edge:msg:member:team:alice:member:team:bob',
  source: 'member:team:alice',
  target: 'member:team:bob',
  type: 'message',
};

describe('drawEdges', () => {
  it('does not draw idle message edges', () => {
    const ctx = createMockContext();
    const nodeMap = new Map([
      [messageEdge.source, createNode(messageEdge.source, 0, 0)],
      [messageEdge.target, createNode(messageEdge.target, 100, 0)],
    ]);

    drawEdges(ctx, [messageEdge], nodeMap, 0, new Set());

    expect(ctx.beginPath).not.toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('draws message edges while a particle is active on them', () => {
    const ctx = createMockContext();
    const nodeMap = new Map([
      [messageEdge.source, createNode(messageEdge.source, 0, 0)],
      [messageEdge.target, createNode(messageEdge.target, 100, 0)],
    ]);

    drawEdges(ctx, [messageEdge], nodeMap, 0, new Set([messageEdge.id]));

    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
  });
});
