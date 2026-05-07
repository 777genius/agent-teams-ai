import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphMemberLogPreviewHud } from '@features/agent-graph/renderer/ui/GraphMemberLogPreviewHud';

import type { GraphNode } from '@claude-teams/agent-graph';

const basePreviewsByMember = new Map([
  [
    'team-lead',
    {
      memberName: 'team-lead',
      items: [
        {
          id: 'lead-preview-1',
          kind: 'text' as const,
          provider: 'claude_transcript' as const,
          timestamp: '2026-04-03T00:00:00.000Z',
          title: 'Assistant',
          preview: 'lead log preview',
          tone: 'neutral' as const,
        },
      ],
      coverage: [{ provider: 'claude_transcript' as const, status: 'included' as const }],
      warnings: [],
      truncated: false,
      overflowCount: 0,
      generatedAt: '2026-04-03T00:00:00.000Z',
    },
  ],
  [
    'alice',
    {
      memberName: 'alice',
      items: [
        {
          id: 'preview-1',
          kind: 'tool_use' as const,
          provider: 'claude_transcript' as const,
          timestamp: '2026-04-03T00:00:00.000Z',
          title: 'Bash',
          preview: 'pnpm test',
          tone: 'warning' as const,
        },
        {
          id: 'preview-2',
          kind: 'tool_result' as const,
          provider: 'opencode_runtime' as const,
          timestamp: '2026-04-03T00:00:30.000Z',
          title: 'Send message error',
          preview: 'OpenCode tool failed without output',
          tone: 'error' as const,
        },
        {
          id: 'preview-3',
          kind: 'tool_result' as const,
          provider: 'opencode_runtime' as const,
          timestamp: '2026-04-03T00:00:40.000Z',
          title: 'Bash result',
          preview: 'Tests passed',
          tone: 'success' as const,
        },
      ],
      coverage: [{ provider: 'claude_transcript' as const, status: 'included' as const }],
      warnings: [],
      truncated: true,
      overflowCount: 2,
      generatedAt: '2026-04-03T00:00:00.000Z',
    },
  ],
]);
let mockedPreviewsByMember = basePreviewsByMember;

vi.mock('@features/agent-graph/renderer/hooks/useGraphMemberLogPreviews', () => ({
  buildGraphLogPreviewLaneIdsByMember: () => ({ alice: 'secondary:opencode:alice' }),
  useGraphMemberLogPreviews: () => ({
    previewsByMember: mockedPreviewsByMember,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('@features/agent-graph/renderer/hooks/useGraphActivityContext', () => ({
  useGraphActivityContext: () => ({
    teamData: {
      members: [
        {
          name: 'alice',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
          providerId: 'opencode',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:alice',
        },
      ],
    },
  }),
}));

describe('GraphMemberLogPreviewHud', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T00:01:00.000Z'));
    mockedPreviewsByMember = basePreviewsByMember;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens the member profile on the logs tab when a preview row or overflow is clicked', async () => {
    const node: GraphNode = {
      id: 'member:alpha-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'alice' },
    };
    const onOpenMemberProfile = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[node]}
          getLogWorldRect={() => ({
            left: 40,
            top: 80,
            right: 300,
            bottom: 372,
            width: 260,
            height: 292,
          })}
          getCameraZoom={() => 1}
          worldToScreen={(x, y) => ({ x, y })}
          getViewportSize={() => ({ width: 1200, height: 800 })}
          focusNodeIds={null}
          onOpenMemberProfile={onOpenMemberProfile}
        />
      );
      await Promise.resolve();
    });

    const row = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('pnpm test')
    );
    expect(row).not.toBeUndefined();
    expect(row?.querySelector('.float-left')).not.toBeNull();
    expect(row?.querySelector('.line-clamp-3')).toBeNull();
    expect(row?.textContent).toContain('pnpm test');

    const errorRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode tool failed')
    );
    expect(errorRow?.querySelector('svg.text-rose-300')).not.toBeNull();

    const resultRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Tests passed')
    );
    expect(resultRow?.textContent).toContain('Bash');
    expect(resultRow?.textContent).not.toContain('Bash result');

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenMemberProfile).toHaveBeenCalledWith('alice', { initialTab: 'logs' });

    const moreButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('+2 more')
    );
    expect(moreButton).not.toBeUndefined();

    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenMemberProfile).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });

  it('briefly highlights a newly appeared preview row', async () => {
    const node: GraphNode = {
      id: 'member:alpha-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'alice' },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderHud = (): void => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[node]}
          getLogWorldRect={() => ({
            left: 40,
            top: 80,
            right: 300,
            bottom: 372,
            width: 260,
            height: 292,
          })}
          getCameraZoom={() => 1}
          worldToScreen={(x, y) => ({ x, y })}
          getViewportSize={() => ({ width: 1200, height: 800 })}
          focusNodeIds={null}
        />
      );
    };

    await act(async () => {
      renderHud();
      await Promise.resolve();
    });

    const alicePreview = basePreviewsByMember.get('alice')!;
    mockedPreviewsByMember = new Map(basePreviewsByMember);
    mockedPreviewsByMember.set('alice', {
      ...alicePreview,
      items: [
        {
          id: 'preview-new',
          kind: 'text' as const,
          provider: 'claude_transcript' as const,
          timestamp: '2026-04-03T00:01:00.000Z',
          title: 'Assistant',
          preview: 'new compact log',
          tone: 'neutral' as const,
        },
        ...alicePreview.items,
      ],
    });

    await act(async () => {
      renderHud();
      await Promise.resolve();
    });

    const newRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('new compact log')
    );
    expect(newRow?.className).toContain('border-sky-300/70');

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(newRow?.className).not.toContain('border-sky-300/70');

    act(() => {
      root.unmount();
    });
  });

  it('renders lead log previews and opens the lead profile logs tab', async () => {
    const leadNode: GraphNode = {
      id: 'lead:alpha-team',
      kind: 'lead',
      label: 'alpha-team',
      state: 'active',
      domainRef: { kind: 'lead', teamName: 'alpha-team', memberName: 'team-lead' },
    };
    const onOpenMemberProfile = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[leadNode]}
          getLogWorldRect={() => ({
            left: 40,
            top: 80,
            right: 300,
            bottom: 372,
            width: 260,
            height: 292,
          })}
          getCameraZoom={() => 1}
          worldToScreen={(x, y) => ({ x, y })}
          getViewportSize={() => ({ width: 1200, height: 800 })}
          focusNodeIds={null}
          onOpenMemberProfile={onOpenMemberProfile}
        />
      );
      await Promise.resolve();
    });

    const row = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('lead log preview')
    );
    expect(row).not.toBeUndefined();

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenMemberProfile).toHaveBeenCalledWith('team-lead', { initialTab: 'logs' });

    act(() => {
      root.unmount();
    });
  });
});
