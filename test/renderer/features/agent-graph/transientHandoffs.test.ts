import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GraphParticle } from '@claude-teams/agent-graph';

import {
  createTransientHandoffState,
  selectRenderableTransientHandoffCards,
  updateTransientHandoffState,
} from '../../../../packages/agent-graph/src/ui/transientHandoffs';

const leadNode: GraphNode = {
  id: 'lead:team-a',
  kind: 'lead',
  label: 'team-a',
  state: 'active',
  x: 0,
  y: 0,
  domainRef: { kind: 'lead', teamName: 'team-a', memberName: 'team-lead' },
};

const aliceNode: GraphNode = {
  id: 'member:team-a:alice',
  kind: 'member',
  label: 'alice',
  state: 'active',
  x: 100,
  y: 0,
  domainRef: { kind: 'member', teamName: 'team-a', memberName: 'alice' },
};

const taskNode: GraphNode = {
  id: 'task:team-a:42',
  kind: 'task',
  label: '#42',
  sublabel: 'Fix queue',
  state: 'active',
  x: 200,
  y: 100,
  domainRef: { kind: 'task', teamName: 'team-a', taskId: '42' },
};

const nodeMap = new Map<string, GraphNode>([
  [leadNode.id, leadNode],
  [aliceNode.id, aliceNode],
  [taskNode.id, taskNode],
]);

const edgeMap = new Map<string, GraphEdge>([
  [
    'edge:lead:alice',
    {
      id: 'edge:lead:alice',
      source: leadNode.id,
      target: aliceNode.id,
      type: 'parent-child',
    },
  ],
  [
    'edge:alice:task',
    {
      id: 'edge:alice:task',
      source: aliceNode.id,
      target: taskNode.id,
      type: 'message',
    },
  ],
]);

function makeParticle(overrides?: Partial<GraphParticle>): GraphParticle {
  return {
    id: 'particle-1',
    edgeId: 'edge:lead:alice',
    progress: 0.7,
    kind: 'inbox_message',
    color: '#66ccff',
    label: '✉ Ship the patch after green CI',
    preview: 'Ship the patch after green CI and send the changelog',
    reverse: true,
    ...overrides,
  };
}

describe('transient handoff cards', () => {
  it('creates one readable handoff card when a particle reaches the recipient zone', () => {
    const state = createTransientHandoffState();

    updateTransientHandoffState(state, {
      particles: [makeParticle()],
      edgeMap,
      nodeMap,
      time: 10,
    });

    const cards = selectRenderableTransientHandoffCards(state);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      edgeId: 'edge:lead:alice',
      sourceNodeId: aliceNode.id,
      destinationNodeId: leadNode.id,
      kind: 'inbox_message',
      count: 1,
      preview: 'Ship the patch after green CI and send the changelog',
    });
  });

  it('aggregates repeated sends on the same edge and keeps the latest preview', () => {
    const state = createTransientHandoffState();

    updateTransientHandoffState(state, {
      particles: [makeParticle({ id: 'particle-1' })],
      edgeMap,
      nodeMap,
      time: 20,
    });

    updateTransientHandoffState(state, {
      particles: [
        makeParticle({
          id: 'particle-2',
          label: '✉ Follow-up with the release note diff',
          preview: 'Follow-up with the release note diff and deployment checklist',
        }),
      ],
      edgeMap,
      nodeMap,
      time: 21,
    });

    const cards = selectRenderableTransientHandoffCards(state);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      count: 2,
      preview: 'Follow-up with the release note diff and deployment checklist',
    });
  });

  it('expires old cards and caps renderables per destination', () => {
    const state = createTransientHandoffState();

    updateTransientHandoffState(state, {
      particles: [
        makeParticle({ id: 'comment-1', edgeId: 'edge:alice:task', kind: 'task_comment', reverse: false }),
        makeParticle({ id: 'comment-2', edgeId: 'edge:alice:task', kind: 'task_comment', reverse: false }),
        makeParticle({ id: 'comment-3', edgeId: 'edge:alice:task', kind: 'review_request', reverse: false }),
      ],
      edgeMap,
      nodeMap,
      time: 30,
    });

    const cards = selectRenderableTransientHandoffCards(state);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((card) => card.kind))).toEqual(
      new Set(['task_comment', 'review_request'])
    );

    updateTransientHandoffState(state, {
      particles: [],
      edgeMap,
      nodeMap,
      time: 34,
    });

    expect(selectRenderableTransientHandoffCards(state)).toHaveLength(0);
  });

  it('does not create a card for generic idle inbox noise', () => {
    const state = createTransientHandoffState();

    updateTransientHandoffState(state, {
      particles: [
        makeParticle({
          id: 'idle-1',
          label: 'idle',
          preview: 'idle',
        }),
      ],
      edgeMap,
      nodeMap,
      time: 40,
    });

    expect(selectRenderableTransientHandoffCards(state)).toHaveLength(0);
  });
});
