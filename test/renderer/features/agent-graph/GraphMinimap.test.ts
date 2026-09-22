import { describe, expect, it } from 'vitest';

import {
  calculateGraphMinimapProjection,
  minimapToWorld,
} from '../../../../packages/agent-graph/src/ui/GraphMinimap';

import type { GraphNode } from '@claude-teams/agent-graph';

function teamNode(id: string, x: number, y: number): GraphNode {
  return {
    id,
    kind: 'member',
    visualVariant: 'team',
    label: id,
    state: 'active',
    x,
    y,
    domainRef: { kind: 'member', teamName: id, memberName: id },
  };
}

describe('GraphMinimap geometry', () => {
  it('fits graph bounds into the minimap and preserves coordinate round trips', () => {
    const projection = calculateGraphMinimapProjection(
      [teamNode('left', -500, -200), teamNode('right', 700, 400)],
      [],
      196,
      124
    );
    const minimapPoint = {
      x: 120 * projection.scale + projection.offsetX,
      y: 80 * projection.scale + projection.offsetY,
    };

    expect(projection.scale).toBeGreaterThan(0);
    const worldPoint = minimapToWorld(minimapPoint.x, minimapPoint.y, projection);
    expect(worldPoint.x).toBeCloseTo(120);
    expect(worldPoint.y).toBeCloseTo(80);
  });

  it('includes host-provided layout bounds so navigation covers the complete board', () => {
    const projection = calculateGraphMinimapProjection(
      [teamNode('alpha', 0, 0)],
      [{ left: -1000, top: -800, right: 1400, bottom: 900 }],
      196,
      124
    );

    expect(projection.bounds.left).toBeLessThan(-1000);
    expect(projection.bounds.right).toBeGreaterThan(1400);
    expect(projection.bounds.top).toBeLessThan(-800);
    expect(projection.bounds.bottom).toBeGreaterThan(900);
  });
});
