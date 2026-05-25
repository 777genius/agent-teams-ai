import { describe, expect, it } from 'vitest';

import { filterVisibleGraphEdges } from '../../../../packages/agent-graph/src/ui/GraphView';

import type { GraphEdge } from '@claude-teams/agent-graph';

const parentEdge: GraphEdge = {
  id: 'edge:parent:lead:alice',
  source: 'lead:team',
  target: 'member:team:alice',
  type: 'parent-child',
};

const ownershipEdge: GraphEdge = {
  id: 'edge:own:alice:task-1',
  source: 'member:team:alice',
  target: 'task:team:task-1',
  type: 'ownership',
};

const messageEdge: GraphEdge = {
  id: 'edge:msg:member:team:alice:member:team:bob',
  source: 'member:team:alice',
  target: 'member:team:bob',
  type: 'message',
};

describe('filterVisibleGraphEdges', () => {
  it('keeps only active routes when static edges are hidden', () => {
    const visibleNodeIds = new Set([
      'lead:team',
      'member:team:alice',
      'member:team:bob',
      'task:team:task-1',
    ]);

    expect(
      filterVisibleGraphEdges(
        [parentEdge, ownershipEdge, messageEdge],
        visibleNodeIds,
        false,
        new Set([parentEdge.id, messageEdge.id])
      ).map((edge) => edge.id)
    ).toEqual([parentEdge.id, messageEdge.id]);
  });

  it('hides all idle routes when static edges are hidden', () => {
    const visibleNodeIds = new Set(['lead:team', 'member:team:alice', 'member:team:bob']);

    expect(
      filterVisibleGraphEdges([parentEdge, messageEdge], visibleNodeIds, false).map(
        (edge) => edge.id
      )
    ).toEqual([]);
  });

  it('keeps static routes when edges are enabled', () => {
    const visibleNodeIds = new Set(['lead:team', 'member:team:alice', 'member:team:bob']);

    expect(
      filterVisibleGraphEdges([parentEdge, messageEdge], visibleNodeIds, true).map(
        (edge) => edge.id
      )
    ).toEqual([parentEdge.id, messageEdge.id]);
  });
});
