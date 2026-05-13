import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphMemberLogPreviewHud } from '@features/agent-graph/renderer/ui/GraphMemberLogPreviewHud';

import type { GraphNode } from '@claude-teams/agent-graph';
import type { MemberLogPreviewMember } from '@features/member-log-stream/contracts/dto';

const basePreviewsByMember = new Map<string, MemberLogPreviewMember>([
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
let mockedLoading = false;
let mockedError: string | null = null;

vi.mock('@features/agent-graph/renderer/hooks/useGraphMemberLogPreviews', () => ({
  buildGraphLogPreviewLaneIdsByMember: () => ({ alice: 'secondary:opencode:alice' }),
  useGraphMemberLogPreviews: () => ({
    previewsByMember: mockedPreviewsByMember,
    loading: mockedLoading,
    error: mockedError,
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
    mockedLoading = false;
    mockedError = null;
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
    expect(row?.className).toContain('h-[72px]');
    expect(row?.querySelector('span.text-slate-200')?.className).toContain('leading-5');
    expect(row?.textContent).toContain('pnpm test');

    const errorRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode tool failed')
    );
    expect(errorRow?.className).toContain('border-rose-400/35');
    expect(errorRow?.querySelector('svg.text-rose-300')).not.toBeNull();
    expect(errorRow?.querySelector('.text-rose-100')).not.toBeNull();

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

  it('caps long visible rows while preserving the full preview in the title', async () => {
    const node: GraphNode = {
      id: 'member:alpha-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'alice' },
    };
    const longPreview =
      'to team-lead inbox - #68a3a8cc blocked by dependencies and needs a follow-up investigation before merge final-token';
    const alicePreview = basePreviewsByMember.get('alice')!;
    mockedPreviewsByMember = new Map(basePreviewsByMember);
    mockedPreviewsByMember.set('alice', {
      ...alicePreview,
      items: [
        {
          id: 'preview-long',
          kind: 'tool_use' as const,
          provider: 'claude_transcript' as const,
          timestamp: '2026-04-03T00:00:00.000Z',
          title: 'Send message',
          preview: longPreview,
          tone: 'warning' as const,
        },
      ],
      overflowCount: 0,
    });

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
        />
      );
      await Promise.resolve();
    });

    const row = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Send message')
    );

    expect(row?.textContent).toContain('...');
    expect(row?.textContent).not.toContain('final-token');
    expect(row?.getAttribute('title')).toContain('final-token');

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

  it('does not highlight existing rows when logs are toggled off and on', async () => {
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
    const renderHud = (enabled: boolean): void => {
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
          enabled={enabled}
        />
      );
    };

    await act(async () => {
      renderHud(true);
      await Promise.resolve();
    });

    const initialRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('pnpm test')
    );
    expect(initialRow?.className).not.toContain('border-sky-300/70');

    await act(async () => {
      renderHud(false);
      await Promise.resolve();
    });
    expect(host.querySelectorAll('button')).toHaveLength(0);

    await act(async () => {
      renderHud(true);
      await Promise.resolve();
    });

    const restoredRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('pnpm test')
    );
    expect(restoredRow?.className).not.toContain('border-sky-300/70');

    const alicePreview = basePreviewsByMember.get('alice')!;
    mockedPreviewsByMember = new Map(basePreviewsByMember);
    mockedPreviewsByMember.set('alice', {
      ...alicePreview,
      items: [
        {
          id: 'preview-after-toggle',
          kind: 'text' as const,
          provider: 'claude_transcript' as const,
          timestamp: '2026-04-03T00:01:00.000Z',
          title: 'Assistant',
          preview: 'new log after toggle',
          tone: 'neutral' as const,
        },
        ...alicePreview.items,
      ],
    });

    await act(async () => {
      renderHud(true);
      await Promise.resolve();
    });

    const newRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('new log after toggle')
    );
    expect(newRow?.className).toContain('border-sky-300/70');

    act(() => {
      root.unmount();
    });
  });

  it('scopes new-row highlights by member when preview ids collide', async () => {
    const aliceNode: GraphNode = {
      id: 'member:alpha-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'alice' },
    };
    const bobNode: GraphNode = {
      id: 'member:alpha-team:bob',
      kind: 'member',
      label: 'bob',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'bob' },
    };
    const sharedId = 'preview-shared-id';
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'alice',
        {
          memberName: 'alice',
          items: [
            {
              id: sharedId,
              kind: 'text',
              provider: 'claude_transcript',
              timestamp: '2026-04-03T00:00:00.000Z',
              title: 'Assistant',
              preview: 'alice already known',
              tone: 'neutral',
            },
          ],
          coverage: [{ provider: 'claude_transcript', status: 'included' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
      [
        'bob',
        {
          memberName: 'bob',
          items: [],
          coverage: [{ provider: 'claude_transcript', status: 'included' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderHud = (): void => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[aliceNode, bobNode]}
          getLogWorldRect={(ownerNodeId) => ({
            left: ownerNodeId.includes('bob') ? 360 : 40,
            top: 80,
            right: ownerNodeId.includes('bob') ? 620 : 300,
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

    mockedPreviewsByMember = new Map(mockedPreviewsByMember);
    mockedPreviewsByMember.set('bob', {
      memberName: 'bob',
      items: [
        {
          id: sharedId,
          kind: 'text',
          provider: 'claude_transcript',
          timestamp: '2026-04-03T00:01:00.000Z',
          title: 'Assistant',
          preview: 'bob new shared id',
          tone: 'neutral',
        },
      ],
      coverage: [{ provider: 'claude_transcript', status: 'included' }],
      warnings: [],
      truncated: false,
      overflowCount: 0,
      generatedAt: '2026-04-03T00:01:00.000Z',
    });

    await act(async () => {
      renderHud();
      await Promise.resolve();
    });

    const aliceRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('alice already known')
    );
    const bobRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('bob new shared id')
    );

    expect(aliceRow?.className).not.toContain('border-sky-300/70');
    expect(bobRow?.className).toContain('border-sky-300/70');

    act(() => {
      root.unmount();
    });
  });

  it('renders distinct empty states for unsupported and simply empty members', async () => {
    const codexNode: GraphNode = {
      id: 'member:alpha-team:codex-dev',
      kind: 'member',
      label: 'codex-dev',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'codex-dev' },
    };
    const quietNode: GraphNode = {
      id: 'member:alpha-team:quiet-dev',
      kind: 'member',
      label: 'quiet-dev',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'quiet-dev' },
    };
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'codex-dev',
        {
          memberName: 'codex-dev',
          items: [],
          coverage: [{ provider: 'codex_native_trace', status: 'skipped' }],
          warnings: [
            {
              code: 'codex_member_wide_not_supported',
              message: 'Codex member-wide native trace is not available in this variant yet.',
            },
          ],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
      [
        'quiet-dev',
        {
          memberName: 'quiet-dev',
          items: [],
          coverage: [{ provider: 'claude_transcript', status: 'skipped' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[codexNode, quietNode]}
          getLogWorldRect={(ownerNodeId) => ({
            left: ownerNodeId.includes('quiet') ? 360 : 40,
            top: 80,
            right: ownerNodeId.includes('quiet') ? 620 : 300,
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
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Unsupported provider');
    expect(host.textContent).toContain('No recent logs');

    act(() => {
      root.unmount();
    });
  });

  it('keeps loaded empty previews honest during background loading', async () => {
    const codexNode: GraphNode = {
      id: 'member:alpha-team:codex-dev',
      kind: 'member',
      label: 'codex-dev',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'codex-dev' },
    };
    const quietNode: GraphNode = {
      id: 'member:alpha-team:quiet-dev',
      kind: 'member',
      label: 'quiet-dev',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'quiet-dev' },
    };
    mockedLoading = true;
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'codex-dev',
        {
          memberName: 'codex-dev',
          items: [],
          coverage: [{ provider: 'codex_native_trace', status: 'skipped' }],
          warnings: [
            {
              code: 'codex_member_wide_not_supported',
              message: 'Codex member-wide native trace is not available in this variant yet.',
            },
          ],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
      [
        'quiet-dev',
        {
          memberName: 'quiet-dev',
          items: [],
          coverage: [{ provider: 'claude_transcript', status: 'skipped' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[codexNode, quietNode]}
          getLogWorldRect={(ownerNodeId) => ({
            left: ownerNodeId.includes('quiet') ? 360 : 40,
            top: 80,
            right: ownerNodeId.includes('quiet') ? 620 : 300,
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
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Unsupported provider');
    expect(host.textContent).toContain('No recent logs');
    expect(host.textContent).not.toContain('Loading logs');

    act(() => {
      root.unmount();
    });
  });

  it('does not label Codex members unsupported while transcript coverage can still provide logs', async () => {
    const leadNode: GraphNode = {
      id: 'member:alpha-team:team-lead',
      kind: 'member',
      label: 'team-lead',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'team-lead' },
    };
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'team-lead',
        {
          memberName: 'team-lead',
          items: [],
          coverage: [
            {
              provider: 'claude_transcript',
              status: 'skipped',
              reason: 'no_member_transcripts',
            },
            {
              provider: 'codex_native_trace',
              status: 'skipped',
              reason: 'codex_member_wide_not_supported',
            },
          ],
          warnings: [
            {
              code: 'codex_member_wide_not_supported',
              message: 'Codex member-wide native trace is not available in this variant yet.',
            },
          ],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
    ]);

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
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Unsupported provider');
    expect(host.textContent).toContain('No recent logs');

    act(() => {
      root.unmount();
    });
  });

  it('does not present OpenCode runtime failures as no recent logs', async () => {
    const node: GraphNode = {
      id: 'member:alpha-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'alice' },
    };
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'alice',
        {
          memberName: 'alice',
          items: [],
          coverage: [
            {
              provider: 'opencode_runtime',
              status: 'skipped',
              reason: 'opencode_runtime_timeout',
            },
          ],
          warnings: [
            {
              code: 'opencode_runtime_timeout',
              message: 'OpenCode runtime preview timed out.',
            },
          ],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:00:00.000Z',
        },
      ],
    ]);

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
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Logs unavailable');
    expect(host.textContent).not.toContain('No recent logs');

    act(() => {
      root.unmount();
    });
  });

  it('shows loading only before a member preview has been loaded', async () => {
    const quietNode: GraphNode = {
      id: 'member:alpha-team:quiet-dev',
      kind: 'member',
      label: 'quiet-dev',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'alpha-team', memberName: 'quiet-dev' },
    };
    mockedLoading = true;
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <GraphMemberLogPreviewHud
          teamName="alpha-team"
          nodes={[quietNode]}
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
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Loading logs');
    expect(host.textContent).not.toContain('No recent logs');
    const loadingButton = host.querySelector('button[aria-busy="true"]');
    expect(loadingButton?.className).toContain('flex-1');
    expect(loadingButton?.querySelectorAll('.animate-pulse')).toHaveLength(3);

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

  it('keeps compact event text readable without repeating the title prefix', async () => {
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'alice',
        {
          memberName: 'alice',
          items: [
            {
              id: 'message-sent-preview',
              kind: 'tool_result',
              provider: 'claude_transcript',
              timestamp: '2026-04-03T00:01:00.000Z',
              title: 'Message sent',
              preview: 'Message sent to team-lead - #abc done',
              tone: 'success',
            },
            {
              id: 'generic-tool-result-preview',
              kind: 'tool_result',
              provider: 'claude_transcript',
              timestamp: '2026-04-03T00:00:50.000Z',
              title: 'Tool result',
              preview: 'stored',
              tone: 'success',
            },
            {
              id: 'bash-result-preview',
              kind: 'tool_result',
              provider: 'claude_transcript',
              timestamp: '2026-04-03T00:00:40.000Z',
              title: 'Bash result',
              preview: 'Bash result app/components/Calculator.tsx app/components/Display.tsx',
              tone: 'success',
            },
          ],
          coverage: [{ provider: 'claude_transcript', status: 'included' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:01:00.000Z',
        },
      ],
    ]);
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
        />
      );
      await Promise.resolve();
    });

    const messageRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('#abc done')
    );
    expect(messageRow?.textContent).toContain('Message sent');
    expect(messageRow?.textContent).toContain('to team-lead - #abc done');
    expect(messageRow?.textContent).not.toContain('Message sentMessage sent');
    expect(messageRow?.textContent).not.toContain('Message sent now Message sent');

    const genericResultRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('stored')
    );
    expect(genericResultRow?.textContent).toContain('Tool result');

    const bashResultRow = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('app/components/Calculator.tsx')
    );
    expect(bashResultRow?.textContent).toContain('Bash');
    expect(bashResultRow?.textContent).not.toContain('Bash result');
    expect(bashResultRow?.textContent).not.toContain('result app/components');

    act(() => {
      root.unmount();
    });
  });

  it('truncates long event titles without losing the full tooltip context', async () => {
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'alice',
        {
          memberName: 'alice',
          items: [
            {
              id: 'long-title-preview',
              kind: 'tool_use',
              provider: 'claude_transcript',
              timestamp: '2026-04-03T00:01:00.000Z',
              title: 'Very long custom provider tool name',
              preview:
                'Very long custom provider tool name: compact body should still remain visible',
              tone: 'warning',
            },
          ],
          coverage: [{ provider: 'claude_transcript', status: 'included' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:01:00.000Z',
        },
      ],
    ]);
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
        />
      );
      await Promise.resolve();
    });

    const row = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('compact body')
    );
    expect(row?.textContent).toContain('Very long custom prov...');
    expect(row?.textContent).toContain('compact body should still remain visible');
    expect(row?.textContent).not.toContain('Very long custom provider tool nameVery long');
    expect(row?.getAttribute('title')).toContain('Very long custom provider tool name');
    expect(row?.getAttribute('aria-label')).toContain('Very long custom provider tool name');

    act(() => {
      root.unmount();
    });
  });

  it('uses safe fallback titles for malformed compact events', async () => {
    mockedPreviewsByMember = new Map<string, MemberLogPreviewMember>([
      [
        'alice',
        {
          memberName: 'alice',
          items: [
            {
              id: 'empty-title-result',
              kind: 'tool_result',
              provider: 'claude_transcript',
              timestamp: '2026-04-03T00:01:00.000Z',
              title: '   ',
              preview: 'stored',
              tone: 'success',
            },
            {
              id: 'empty-title-error',
              kind: 'text',
              provider: 'claude_transcript',
              timestamp: 'bad timestamp',
              title: '',
              preview: 'provider returned malformed timestamp',
              tone: 'error',
            },
          ],
          coverage: [{ provider: 'claude_transcript', status: 'included' }],
          warnings: [],
          truncated: false,
          overflowCount: 0,
          generatedAt: '2026-04-03T00:01:00.000Z',
        },
      ],
    ]);
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
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Tool result');
    expect(host.textContent).toContain('stored');
    expect(host.textContent).toContain('Error');
    expect(host.textContent).toContain('provider returned malformed timestamp');
    expect(host.textContent).not.toContain('undefined');

    act(() => {
      root.unmount();
    });
  });
});
