import { describe, expect, it } from 'vitest';

import {
  computeAdaptiveParticleBudget,
  selectRenderableParticles,
} from '../../../../packages/agent-graph/src/ui/selectRenderableParticles';

import type { GraphParticle } from '@claude-teams/agent-graph';

function makeParticle(id: string, edgeId: string): GraphParticle {
  return {
    id,
    edgeId,
    progress: 0,
    kind: 'inbox_message',
    color: '#66ccff',
  };
}

describe('selectRenderableParticles', () => {
  it('keeps at least one particle per active visible edge when over budget', () => {
    const particles = [
      makeParticle('p1', 'edge:a'),
      makeParticle('p2', 'edge:a'),
      makeParticle('p3', 'edge:b'),
      makeParticle('p4', 'edge:b'),
      makeParticle('p5', 'edge:c'),
      makeParticle('p6', 'edge:c'),
    ];

    const selected = selectRenderableParticles({
      particles,
      visibleEdgeIds: new Set(['edge:a', 'edge:b', 'edge:c']),
      budget: 3,
    });

    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((particle) => particle.edgeId))).toEqual(
      new Set(['edge:a', 'edge:b', 'edge:c'])
    );
  });

  it('does not spend budget on particles for offscreen edges', () => {
    const selected = selectRenderableParticles({
      particles: [
        makeParticle('p1', 'edge:a'),
        makeParticle('p2', 'edge:b'),
        makeParticle('p3', 'edge:c'),
      ],
      visibleEdgeIds: new Set(['edge:b']),
      budget: 10,
    });

    expect(selected).toEqual([expect.objectContaining({ id: 'p2', edgeId: 'edge:b' })]);
  });
});

describe('computeAdaptiveParticleBudget', () => {
  it('reduces budget when frame time is already high', () => {
    const fastBudget = computeAdaptiveParticleBudget({
      visibleNodeCount: 30,
      visibleEdgeCount: 20,
      frameTimeMs: 8,
      hasFocusedEdges: false,
    });
    const slowBudget = computeAdaptiveParticleBudget({
      visibleNodeCount: 30,
      visibleEdgeCount: 20,
      frameTimeMs: 26,
      hasFocusedEdges: false,
    });

    expect(slowBudget).toBeLessThan(fastBudget);
    expect(slowBudget).toBeGreaterThan(0);
  });
});
