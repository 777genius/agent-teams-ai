import { describe, expect, it } from 'vitest';

import { getGraphNodeRenderBounds } from '../../../../packages/agent-graph/src/canvas/node-geometry';
import { calculateGraphCameraFit } from '../../../../packages/agent-graph/src/hooks/useGraphCamera';

import type { GraphNode } from '@claude-teams/agent-graph';

function teamNode(label: string): GraphNode {
  return {
    id: `team:${label}`,
    kind: 'member',
    visualVariant: 'team',
    label,
    state: 'active',
    x: 0,
    y: 0,
    domainRef: { kind: 'member', teamName: label, memberName: label },
  };
}

describe('graph camera geometry', () => {
  it('fits the full adaptive hierarchy card width', () => {
    const shortFit = calculateGraphCameraFit([teamNode('Team')], 500, 1000);
    const longFit = calculateGraphCameraFit(
      [teamNode('A very long team name that reaches the adaptive card limit')],
      500,
      1000
    );

    expect(shortFit).not.toBeNull();
    expect(longFit).not.toBeNull();
    expect(longFit!.zoom).toBeLessThan(shortFit!.zoom);
  });

  it('expands overview culling bounds for screen-sized hierarchy badges', () => {
    const bounds = getGraphNodeRenderBounds(teamNode('Platform'), 0.05);

    expect(bounds.right - bounds.left).toBe(4400);
    expect(bounds.bottom - bounds.top).toBe(640);
  });
});
