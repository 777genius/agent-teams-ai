import { describe, expect, it } from 'vitest';

import {
  getGraphSemanticZoomLevel,
  shouldRenderOverviewHierarchyNode,
  shouldRenderParticlesAtZoom,
  shouldRenderTaskAtZoom,
} from '../../../../packages/agent-graph/src/canvas/semantic-zoom';

import type { GraphNode } from '@claude-teams/agent-graph';

function hierarchyNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'org:root',
    kind: 'lead',
    label: 'Organization',
    state: 'active',
    visualVariant: 'organization',
    hierarchyDepth: 0,
    domainRef: { kind: 'lead', teamName: 'root', memberName: 'org:root' },
    ...overrides,
  };
}

describe('semantic zoom', () => {
  it('maps camera scale into overview, summary and detail levels', () => {
    expect(getGraphSemanticZoomLevel(0.08)).toBe('overview');
    expect(getGraphSemanticZoomLevel(0.24)).toBe('summary');
    expect(getGraphSemanticZoomLevel(0.61)).toBe('summary');
    expect(getGraphSemanticZoomLevel(0.62)).toBe('detail');
  });

  it('progressively reveals hierarchy depth without showing teams in overview', () => {
    expect(shouldRenderOverviewHierarchyNode(hierarchyNode(), 0.05)).toBe(true);
    expect(shouldRenderOverviewHierarchyNode(hierarchyNode({ hierarchyDepth: 1 }), 0.05)).toBe(
      false
    );
    expect(shouldRenderOverviewHierarchyNode(hierarchyNode({ hierarchyDepth: 1 }), 0.12)).toBe(
      true
    );
    expect(
      shouldRenderOverviewHierarchyNode(
        hierarchyNode({ visualVariant: 'container', hierarchyDepth: 2 }),
        0.18
      )
    ).toBe(true);
    expect(
      shouldRenderOverviewHierarchyNode(
        hierarchyNode({ visualVariant: 'team', hierarchyDepth: 3 }),
        0.2
      )
    ).toBe(false);
  });

  it('keeps emphasized tasks visible while delaying regular tasks until detail zoom', () => {
    expect(shouldRenderTaskAtZoom(0.4)).toBe(false);
    expect(shouldRenderTaskAtZoom(0.4, true)).toBe(true);
    expect(shouldRenderTaskAtZoom(0.8)).toBe(true);
    expect(shouldRenderTaskAtZoom(0.4, false, 'summary')).toBe(true);
    expect(shouldRenderTaskAtZoom(0.2, false, 'summary')).toBe(false);
  });

  it('keeps hierarchy communication particles animated at overview zoom', () => {
    expect(shouldRenderParticlesAtZoom(0.2)).toBe(false);
    expect(shouldRenderParticlesAtZoom(0.2, true)).toBe(true);
    expect(shouldRenderParticlesAtZoom(0.4)).toBe(true);
  });
});
