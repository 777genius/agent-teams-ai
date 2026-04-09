import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'button' }, children),
}));

vi.mock('@renderer/features/agent-graph/ui/GraphTaskCard', () => ({
  GraphTaskCard: () => React.createElement('div', null, 'task-card'),
}));

import { GraphNodePopover } from '@renderer/features/agent-graph/ui/GraphNodePopover';

import type { GraphNode } from '@claude-teams/agent-graph';

function makeMemberNode(spawnStatus: GraphNode['spawnStatus']): GraphNode {
  return {
    id: 'member:alice',
    kind: 'member',
    label: 'alice',
    role: 'Reviewer',
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

describe('GraphNodePopover spawn badge labels', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows human-facing starting for raw waiting/spawning spawn statuses', async () => {
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

    expect(host.textContent).toContain('starting');
    expect(host.textContent).not.toContain('waiting');
    expect(host.textContent).not.toContain('spawning');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
