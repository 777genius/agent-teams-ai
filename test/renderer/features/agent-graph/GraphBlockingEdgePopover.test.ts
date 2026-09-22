import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphBlockingEdgePopover } from '@features/agent-graph/renderer/ui/GraphBlockingEdgePopover';
import { useStore } from '@renderer/store';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => React.createElement('button', { type: 'button', onClick }, children),
}));

const sourceNode: GraphNode = {
  id: 'task:my-team:overflow:alice:todo',
  kind: 'task',
  label: '+2',
  state: 'waiting',
  ownerId: 'member:my-team:alice',
  taskStatus: 'pending',
  reviewState: 'none',
  isOverflowStack: true,
  overflowCount: 2,
  overflowTaskIds: ['task-hidden-1', 'task-hidden-2'],
  domainRef: {
    kind: 'task_overflow',
    teamName: 'my-team',
    ownerMemberName: 'alice',
    columnKey: 'todo',
  },
};

const targetNode: GraphNode = {
  id: 'task:my-team:task-visible',
  kind: 'task',
  label: '#8',
  displayId: '#8',
  sublabel: 'Visible blocked task',
  state: 'waiting',
  ownerId: 'member:my-team:bob',
  taskStatus: 'pending',
  reviewState: 'none',
  domainRef: { kind: 'task', teamName: 'my-team', taskId: 'task-visible' },
};

const edge: GraphEdge = {
  id: 'edge:block:test',
  source: sourceNode.id,
  target: targetNode.id,
  type: 'blocking',
  aggregateCount: 2,
  sourceTaskIds: ['task-hidden-1', 'task-hidden-2'],
  targetTaskIds: ['task-visible'],
};

describe('GraphBlockingEdgePopover', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useStore.setState({
      selectedTeamName: null,
      selectedTeamData: null,
      teamDataCacheByName: {},
    } as never);
    vi.unstubAllGlobals();
  });

  it('renders the participating hidden tasks for aggregated overflow blockers', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [
          {
            id: 'task-hidden-1',
            displayId: '#1',
            subject: 'Hidden blocker one',
            owner: 'alice',
            status: 'pending',
            reviewState: 'none',
          },
          {
            id: 'task-hidden-2',
            displayId: '#2',
            subject: 'Hidden blocker two',
            owner: 'alice',
            status: 'pending',
            reviewState: 'none',
          },
          {
            id: 'task-visible',
            displayId: '#8',
            subject: 'Visible blocked task',
            owner: 'bob',
            status: 'pending',
            reviewState: 'none',
          },
        ],
        members: [],
        messages: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team', members: [], projectPath: '/repo' },
          tasks: [
            {
              id: 'task-hidden-1',
              displayId: '#1',
              subject: 'Hidden blocker one',
              owner: 'alice',
              status: 'pending',
              reviewState: 'none',
            },
            {
              id: 'task-hidden-2',
              displayId: '#2',
              subject: 'Hidden blocker two',
              owner: 'alice',
              status: 'pending',
              reviewState: 'none',
            },
            {
              id: 'task-visible',
              displayId: '#8',
              subject: 'Visible blocked task',
              owner: 'bob',
              status: 'pending',
              reviewState: 'none',
            },
          ],
          members: [],
          messages: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
    } as never);

    const onOpenTaskDetail = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphBlockingEdgePopover, {
          teamName: 'my-team',
          edge,
          sourceNode,
          targetNode,
          onClose: vi.fn(),
          onSelectNode: vi.fn(),
          onOpenTaskDetail,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Blocking hidden tasks');
    expect(host.textContent).toContain('#1 - Hidden blocker one');
    expect(host.textContent).toContain('#2 - Hidden blocker two');

    const hiddenTaskButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('#1 - Hidden blocker one')
    );
    expect(hiddenTaskButton).toBeTruthy();

    await act(async () => {
      hiddenTaskButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenTaskDetail).toHaveBeenCalledWith('task-hidden-1');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
