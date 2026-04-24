import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@renderer/store';

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'button' }, children),
}));

vi.mock('@features/agent-graph/renderer/ui/GraphTaskCard', () => ({
  GraphTaskCard: () => React.createElement('div', null, 'task-card'),
}));

import { GraphNodePopover } from '@features/agent-graph/renderer/ui/GraphNodePopover';

import type { GraphNode } from '@claude-teams/agent-graph';

function makeMemberNode(spawnStatus: GraphNode['spawnStatus']): GraphNode {
  return {
    id: 'member:alice',
    kind: 'member',
    label: 'alice',
    role: 'Reviewer',
    runtimeLabel: 'Codex · GPT-5.4 Mini · Medium',
    state: 'idle',
    color: '#60a5fa',
    avatarUrl: undefined,
    domainRef: { kind: 'member', teamName: 'northstar-core', memberName: 'alice' },
    spawnStatus,
    currentTaskId: undefined,
    currentTaskSubject: undefined,
    activeTool: undefined,
  } as GraphNode;
}

function makeOverflowNode(): GraphNode {
  return {
    id: 'task:northstar-core:overflow:alice:review',
    kind: 'task',
    label: '+2',
    state: 'waiting',
    taskStatus: 'in_progress',
    reviewState: 'review',
    isOverflowStack: true,
    overflowCount: 2,
    overflowTaskIds: ['task-1', 'task-2'],
    domainRef: {
      kind: 'task_overflow',
      teamName: 'northstar-core',
      ownerMemberName: 'alice',
      columnKey: 'review',
    },
  };
}

describe('GraphNodePopover spawn badge labels', () => {
  afterEach(async () => {
    await act(async () => {
      useStore.setState({
        selectedTeamName: null,
        selectedTeamData: null,
        teamDataCacheByName: {},
      } as never);
      await Promise.resolve();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows human-readable launch-status labels for waiting and spawning spawn states', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(GraphNodePopover, {
            node: makeMemberNode('waiting'),
            teamName: 'northstar-core',
            onClose: vi.fn(),
          }),
          React.createElement(GraphNodePopover, {
            node: makeMemberNode('spawning'),
            teamName: 'northstar-core',
            onClose: vi.fn(),
          })
        )
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('waiting to start');
    expect(host.textContent).toContain('starting');
    expect(host.textContent).toContain('Codex · GPT-5.4 Mini · Medium');
    expect(host.textContent).not.toContain('spawning');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows compact exception badge for member abnormal states', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphNodePopover, {
          node: {
            ...makeMemberNode('error'),
            exceptionTone: 'error',
            exceptionLabel: 'spawn failed',
          },
          teamName: 'northstar-core',
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('spawn failed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reuses launch-aware presence semantics from cached team data', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await act(async () => {
      useStore.setState({
        teamDataCacheByName: {
          'northstar-core': {
            teamName: 'northstar-core',
            config: { name: 'Northstar', members: [], projectPath: '/repo' },
            members: [
              {
                name: 'alice',
                status: 'active',
                currentTaskId: null,
                taskCount: 0,
                lastActiveAt: null,
                messageCount: 0,
                agentType: 'reviewer',
                providerId: 'codex',
              },
            ],
            tasks: [],
            messages: [],
            kanbanState: { teamName: 'northstar-core', reviewers: [], tasks: {} },
            processes: [],
            isAlive: true,
          },
        },
        memberSpawnStatusesByTeam: {
          'northstar-core': {
            alice: {
              status: 'online',
              launchState: 'runtime_pending_bootstrap',
              livenessSource: 'process',
              runtimeAlive: true,
            },
          },
        },
        memberSpawnSnapshotsByTeam: {},
        currentProvisioningRunIdByTeam: {},
        provisioningRuns: {},
        leadActivityByTeam: {},
      } as never);
      await Promise.resolve();
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphNodePopover, {
          node: makeMemberNode('online'),
          teamName: 'northstar-core',
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('waiting for bootstrap');
    expect(host.textContent).not.toContain('Idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders overflow stack contents instead of the task card and opens task detail from the list', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await act(async () => {
      useStore.setState({
        selectedTeamName: 'northstar-core',
        selectedTeamData: {
          teamName: 'northstar-core',
          config: { name: 'Northstar', members: [], projectPath: '/repo' },
          tasks: [
            {
              id: 'task-1',
              displayId: '#1',
              subject: 'Tighten rollout checklist',
              owner: 'alice',
              reviewer: 'bob',
              status: 'in_progress',
              reviewState: 'review',
              kanbanColumn: 'review',
            },
            {
              id: 'task-2',
              displayId: '#2',
              subject: 'Patch release notes',
              owner: 'alice',
              status: 'pending',
              reviewState: 'none',
            },
          ],
          members: [],
          messages: [],
          kanbanState: {
            teamName: 'northstar-core',
            reviewers: [],
            tasks: {
              'task-1': {
                column: 'review',
                reviewer: 'bob',
                movedAt: '2026-04-12T18:00:00.000Z',
              },
            },
          },
          processes: [],
        },
        teamDataCacheByName: {
          'northstar-core': {
            teamName: 'northstar-core',
            config: { name: 'Northstar', members: [], projectPath: '/repo' },
            tasks: [
              {
                id: 'task-1',
                displayId: '#1',
                subject: 'Tighten rollout checklist',
                owner: 'alice',
                reviewer: 'bob',
                status: 'in_progress',
                reviewState: 'review',
                kanbanColumn: 'review',
              },
              {
                id: 'task-2',
                displayId: '#2',
                subject: 'Patch release notes',
                owner: 'alice',
                status: 'pending',
                reviewState: 'none',
              },
            ],
            members: [],
            messages: [],
            kanbanState: {
              teamName: 'northstar-core',
              reviewers: [],
              tasks: {
                'task-1': {
                  column: 'review',
                  reviewer: 'bob',
                  movedAt: '2026-04-12T18:00:00.000Z',
                },
              },
            },
            processes: [],
          },
        },
      } as never);
      await Promise.resolve();
    });

    const onOpenTaskDetail = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphNodePopover, {
          node: makeOverflowNode(),
          teamName: 'northstar-core',
          onClose: vi.fn(),
          onOpenTaskDetail,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Hidden tasks');
    expect(host.textContent).toContain('Tighten rollout checklist');
    expect(host.textContent).toContain('Patch release notes');
    expect(host.textContent).toContain('bob');
    expect(host.textContent).not.toContain('task-card');

    const taskButtons = host.querySelectorAll('button');
    expect(taskButtons.length).toBeGreaterThan(0);

    await act(async () => {
      taskButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenTaskDetail).toHaveBeenCalledWith('task-1');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
