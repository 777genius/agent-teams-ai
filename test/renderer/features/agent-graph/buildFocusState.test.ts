import { describe, expect, it } from 'vitest';

import { buildFocusState } from '../../../../packages/agent-graph/src/ui/buildFocusState';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';

const leadNode: GraphNode = {
  id: 'lead:my-team',
  kind: 'lead',
  label: 'My Team',
  state: 'active',
  domainRef: { kind: 'lead', teamName: 'my-team', memberName: 'team-lead' },
};

const aliceNode: GraphNode = {
  id: 'member:my-team:alice',
  kind: 'member',
  label: 'alice',
  state: 'active',
  currentTaskId: 'task-current',
  domainRef: { kind: 'member', teamName: 'my-team', memberName: 'alice' },
};

const bobNode: GraphNode = {
  id: 'member:my-team:bob',
  kind: 'member',
  label: 'bob',
  state: 'idle',
  currentTaskId: 'task-current',
  domainRef: { kind: 'member', teamName: 'my-team', memberName: 'bob' },
};

const blockerNode: GraphNode = {
  id: 'task:my-team:blocker',
  kind: 'task',
  label: '#1',
  state: 'active',
  ownerId: 'member:my-team:alice',
  taskStatus: 'in_progress',
  reviewState: 'none',
  sublabel: 'Blocker',
  domainRef: { kind: 'task', teamName: 'my-team', taskId: 'blocker' },
};

const reviewTaskNode: GraphNode = {
  id: 'task:my-team:review',
  kind: 'task',
  label: '#2',
  state: 'active',
  ownerId: 'member:my-team:alice',
  taskStatus: 'in_progress',
  reviewState: 'review',
  reviewerName: 'bob',
  reviewMode: 'assigned',
  sublabel: 'Review task',
  domainRef: { kind: 'task', teamName: 'my-team', taskId: 'review' },
};

const overflowNode: GraphNode = {
  id: 'task:my-team:overflow:alice:review',
  kind: 'task',
  label: '+3',
  state: 'waiting',
  ownerId: 'member:my-team:alice',
  taskStatus: 'in_progress',
  reviewState: 'review',
  isOverflowStack: true,
  overflowCount: 3,
  overflowTaskIds: ['hidden-1', 'hidden-2', 'hidden-3'],
  domainRef: {
    kind: 'task_overflow',
    teamName: 'my-team',
    ownerMemberName: 'alice',
    columnKey: 'review',
  },
};

const edges: GraphEdge[] = [
  {
    id: 'edge:parent:lead:alice',
    source: leadNode.id,
    target: aliceNode.id,
    type: 'parent-child',
  },
  {
    id: 'edge:parent:lead:bob',
    source: leadNode.id,
    target: bobNode.id,
    type: 'parent-child',
  },
  {
    id: 'edge:own:alice:blocker',
    source: aliceNode.id,
    target: blockerNode.id,
    type: 'ownership',
  },
  {
    id: 'edge:own:alice:review',
    source: aliceNode.id,
    target: reviewTaskNode.id,
    type: 'ownership',
  },
  {
    id: 'edge:own:alice:overflow',
    source: aliceNode.id,
    target: overflowNode.id,
    type: 'ownership',
  },
  {
    id: 'edge:block:blocker:review',
    source: blockerNode.id,
    target: reviewTaskNode.id,
    type: 'blocking',
  },
];

const nodes = [leadNode, aliceNode, bobNode, blockerNode, reviewTaskNode, overflowNode];

describe('buildFocusState', () => {
  it('focuses task selection on its owner, reviewer, direct blockers, and connecting edges', () => {
    const focus = buildFocusState(reviewTaskNode.id, null, nodes, edges);

    expect(Array.from(focus.focusNodeIds ?? []).sort()).toEqual(
      [
        leadNode.id,
        aliceNode.id,
        bobNode.id,
        blockerNode.id,
        reviewTaskNode.id,
      ].sort()
    );
    expect(focus.focusEdgeIds).toEqual(
      new Set([
        'edge:parent:lead:alice',
        'edge:parent:lead:bob',
        'edge:own:alice:blocker',
        'edge:own:alice:review',
        'edge:block:blocker:review',
      ])
    );
  });

  it('includes review-assigned tasks and owned overflow stacks when focusing a member', () => {
    const focus = buildFocusState(bobNode.id, null, nodes, edges);

    expect(focus.focusNodeIds?.has(bobNode.id)).toBe(true);
    expect(focus.focusNodeIds?.has(reviewTaskNode.id)).toBe(true);
    expect(focus.focusNodeIds?.has(aliceNode.id)).toBe(true);
    expect(focus.focusEdgeIds?.has('edge:parent:lead:bob')).toBe(true);
    expect(focus.focusEdgeIds?.has('edge:own:alice:review')).toBe(true);

    const aliceFocus = buildFocusState(aliceNode.id, null, nodes, edges);
    expect(aliceFocus.focusNodeIds?.has(overflowNode.id)).toBe(true);
  });

  it('focuses a lead on direct neighbors only', () => {
    const focus = buildFocusState(leadNode.id, null, nodes, edges);

    expect(focus.focusNodeIds).toEqual(
      new Set([leadNode.id, aliceNode.id, bobNode.id])
    );
    expect(focus.focusEdgeIds).toEqual(
      new Set(['edge:parent:lead:alice', 'edge:parent:lead:bob'])
    );
  });

  it('does not enable global dimming for overflow stack selections', () => {
    const focus = buildFocusState(overflowNode.id, null, nodes, edges);

    expect(focus.focusNodeIds).toBeNull();
    expect(focus.focusEdgeIds).toBeNull();
  });

  it('focuses the connected blocking chain when a blocking edge is selected', () => {
    const focus = buildFocusState(null, 'edge:block:blocker:review', nodes, edges);

    expect(focus.focusNodeIds).toEqual(
      new Set([leadNode.id, aliceNode.id, bobNode.id, blockerNode.id, reviewTaskNode.id])
    );
    expect(focus.focusEdgeIds).toEqual(
      new Set([
        'edge:block:blocker:review',
        'edge:own:alice:blocker',
        'edge:own:alice:review',
        'edge:parent:lead:alice',
        'edge:parent:lead:bob',
      ])
    );
  });
});
