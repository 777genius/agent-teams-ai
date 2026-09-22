import { describe, expect, it } from 'vitest';

import { buildTransientHandoffMessage } from '../../../../src/features/agent-graph/renderer/ui/buildTransientHandoffMessage';

import type { TransientHandoffCard } from '@claude-teams/agent-graph';

function buildCard(overrides: Partial<TransientHandoffCard> = {}): TransientHandoffCard {
  return {
    key: 'edge-1:fwd:task_comment',
    edgeId: 'edge-1',
    sourceNodeId: 'member:bob',
    destinationNodeId: 'task:abc',
    anchorNodeId: 'member:bob',
    anchorKind: 'member',
    sourceLabel: 'bob',
    destinationLabel: 'abc12345',
    destinationKind: 'task',
    kind: 'task_comment',
    color: '#22c55e',
    preview: 'Dependency resolved',
    relatedTaskId: 'abc12345def67890',
    relatedTaskDisplayId: 'abc12345',
    count: 1,
    activatedAt: 10,
    updatedAt: 11,
    expiresAt: 15,
    ...overrides,
  };
}

describe('buildTransientHandoffMessage', () => {
  it('builds task comment notifications with task refs', () => {
    const message = buildTransientHandoffMessage('signal-ops-2', buildCard());

    expect(message.messageKind).toBe('task_comment_notification');
    expect(message.from).toBe('bob');
    expect(message.taskRefs).toEqual([
      {
        taskId: 'abc12345def67890',
        displayId: 'abc12345',
        teamName: 'signal-ops-2',
      },
    ]);
  });

  it('builds task assign text that ActivityItem recognizes as task badge', () => {
    const message = buildTransientHandoffMessage(
      'signal-ops-2',
      buildCard({
        key: 'edge-2:fwd:task_assign',
        kind: 'task_assign',
        destinationNodeId: 'member:bob',
        destinationKind: 'member',
        destinationLabel: 'bob',
      })
    );

    expect(message.messageKind).toBe('default');
    expect(message.text.startsWith('New task assigned to you:')).toBe(true);
  });
});
