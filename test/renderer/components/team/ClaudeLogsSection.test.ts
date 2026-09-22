import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeLogsController } from '@renderer/components/team/useClaudeLogsController';
import type { ResolvedTeamMember } from '@shared/types';

const sectionState = vi.hoisted(() => ({
  members: [] as ResolvedTeamMember[],
  controllerCalls: [] as { teamName: string; enabled: boolean | undefined }[],
  memberLogStreamCalls: [] as {
    teamName: string;
    memberName: string;
    enabled: boolean | undefined;
  }[],
  memberLogStreamUiEnabled: true,
}));

function createController(): ClaudeLogsController {
  return {
    data: {
      lines: ['{"type":"assistant","content":[{"type":"text","text":"lead output"}]}'],
      total: 1,
      hasMore: false,
    },
    loading: false,
    loadingMore: false,
    error: null,
    pendingNewCount: 0,
    isAlive: true,
    filteredText: '{"type":"assistant","content":[{"type":"text","text":"lead output"}]}',
    online: true,
    badge: '1 raw',
    showMoreVisible: false,
    lastLogPreview: { type: 'output', label: 'Output', summary: 'lead output' },
    searchQuery: '',
    setSearchQuery: vi.fn(),
    filter: { streams: new Set(), kinds: new Set() } as ClaudeLogsController['filter'],
    setFilter: vi.fn(),
    filterOpen: false,
    setFilterOpen: vi.fn(),
    viewerState: {} as ClaudeLogsController['viewerState'],
    onViewerStateChange: vi.fn(),
    applyPending: vi.fn(() => Promise.resolve()),
    loadOlderLogs: vi.fn(() => Promise.resolve()),
    containerRefCallback: vi.fn(),
    handleScroll: vi.fn(),
  };
}

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectResolvedMembersForTeamName: () => sectionState.members,
}));

vi.mock('@renderer/components/team/useClaudeLogsController', () => ({
  useClaudeLogsController: (teamName: string, options?: { enabled?: boolean }) => {
    sectionState.controllerCalls.push({ teamName, enabled: options?.enabled });
    return createController();
  },
}));

vi.mock('@renderer/components/team/ClaudeLogsPanel', () => ({
  ClaudeLogsPanel: ({
    toolbarAccessory,
    toolbarControlsStart,
  }: {
    toolbarAccessory?: React.ReactNode;
    toolbarControlsStart?: React.ReactNode;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'lead-logs-panel',
        'data-has-toolbar-accessory': toolbarAccessory ? 'true' : 'false',
        'data-has-toolbar-controls-start': toolbarControlsStart ? 'true' : 'false',
      },
      toolbarAccessory,
      toolbarControlsStart,
      'lead-panel'
    ),
}));

vi.mock('@renderer/components/team/CollapsibleTeamSection', () => ({
  CollapsibleTeamSection: ({
    children,
    afterBadge,
    badge,
    headerExtra,
  }: {
    children: React.ReactNode;
    afterBadge?: React.ReactNode;
    badge?: string;
    headerExtra?: React.ReactNode;
  }) =>
    React.createElement(
      'section',
      null,
      React.createElement('div', { 'data-testid': 'logs-header' }, badge, afterBadge, headerExtra),
      children
    ),
}));

vi.mock('@renderer/components/ui/MemberSelect', () => ({
  MemberSelect: ({
    members,
    value,
    onChange,
    getMemberLabel,
    searchPlaceholder,
    emptyMessage,
    ariaLabel,
    triggerVariant,
  }: {
    members: ResolvedTeamMember[];
    value: string | null;
    onChange: (value: string | null) => void;
    getMemberLabel?: (member: ResolvedTeamMember) => string;
    searchPlaceholder?: string;
    emptyMessage?: string;
    ariaLabel?: string;
    triggerVariant?: 'default' | 'avatar';
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'member-select',
        'data-search-placeholder': searchPlaceholder,
        'data-empty-message': emptyMessage,
        'data-trigger-variant': triggerVariant ?? 'default',
      },
      React.createElement(
        'select',
        {
          'aria-label': 'Log source',
          'data-trigger-aria-label': ariaLabel,
          value: value ?? '',
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            onChange(event.currentTarget.value || null),
        },
        members.map((member) =>
          React.createElement(
            'option',
            { key: member.name, value: member.name },
            getMemberLabel?.(member) ?? member.name
          )
        )
      )
    ),
}));

vi.mock('@renderer/components/team/members/MemberLogsTab', () => ({
  MemberLogsTab: ({ memberName }: { memberName: string }) =>
    React.createElement('div', { 'data-testid': 'legacy-member-logs' }, memberName),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (open ? React.createElement('div', { 'data-testid': 'logs-dialog' }, children) : null),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

vi.mock('@features/member-log-stream/renderer', () => ({
  isMemberLogStreamUiEnabled: () => sectionState.memberLogStreamUiEnabled,
  MemberLogStreamSection: ({
    teamName,
    member,
    enabled,
    onInitialLoadErrorChange,
  }: {
    teamName: string;
    member: ResolvedTeamMember;
    enabled?: boolean;
    onInitialLoadErrorChange?: (hasError: boolean) => void;
  }) => {
    sectionState.memberLogStreamCalls.push({ teamName, memberName: member.name, enabled });
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'member-log-stream',
        'data-removed': member.removedAt ? 'true' : 'false',
        onClick: () => onInitialLoadErrorChange?.(true),
      },
      member.name
    );
  },
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    'aria-label'?: string;
  }) =>
    React.createElement('button', { type: 'button', onClick, 'aria-label': ariaLabel }, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

import { ClaudeLogsSection } from '@renderer/components/team/ClaudeLogsSection';

describe('ClaudeLogsSection source filtering', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];
    sectionState.controllerCalls = [];
    sectionState.memberLogStreamCalls = [];
    sectionState.memberLogStreamUiEnabled = true;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows lead logs by default and exposes teammate sources', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ClaudeLogsSection, {
          teamName: 'demo-team',
          sidebarViewerMaxHeight: 240,
        })
      );
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(host.textContent).not.toContain('Logs for');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Lead',
      'Builder',
    ]);
    expect(select.value).toBe('team-lead');
    const memberSelect = host.querySelector('[data-testid="member-select"]');
    expect(memberSelect).not.toBeNull();
    expect(memberSelect?.getAttribute('data-search-placeholder')).toBe('Search log sources...');
    expect(select.getAttribute('data-trigger-aria-label')).toBe('Log source');
    expect(host.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect(
      host
        .querySelector('[data-testid="lead-logs-panel"]')
        ?.getAttribute('data-has-toolbar-accessory')
    ).toBe('true');
    expect(
      host
        .querySelector('[data-testid="lead-logs-panel"]')
        ?.getAttribute('data-has-toolbar-controls-start')
    ).toBe('false');
    expect(sectionState.memberLogStreamCalls).toEqual([]);
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      enabled: true,
    });
    expect(memberSelect?.getAttribute('data-trigger-variant')).toBe('avatar');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the lead-only team UI simple without an unnecessary source selector', async () => {
    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    expect(host.querySelector('select[aria-label="Log source"]')).toBeNull();
    expect(host.textContent).not.toContain('Logs for');
    expect(host.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      enabled: true,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reuses the member log stream section when a teammate is selected', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ClaudeLogsSection, {
          teamName: 'demo-team',
          sidebarViewerMaxHeight: 240,
        })
      );
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="lead-logs-panel"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Builder');
    expect(sectionState.memberLogStreamCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      memberName: 'Builder',
      enabled: true,
    });
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      enabled: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('switches back to lead logs from a selected teammate in the compact section', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Builder');

    const teammateSelect = host.querySelector(
      'select[aria-label="Log source"]'
    ) as HTMLSelectElement;
    await act(async () => {
      teammateSelect.value = 'team-lead';
      teammateSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="member-log-stream"]')).toBeNull();
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      enabled: true,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('switches directly between multiple teammate log sources', async () => {
    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Reviewer',
        role: 'reviewer',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    let select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Lead',
      'Builder',
      'Reviewer',
    ]);

    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Builder');

    select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Reviewer';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Reviewer');
    expect(sectionState.memberLogStreamCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      memberName: 'Reviewer',
      enabled: true,
    });
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      enabled: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows the same legacy fallback as the member popup after a stream error', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const streamButton = host.querySelector(
      '[data-testid="member-log-stream"]'
    ) as HTMLButtonElement;
    await act(async () => {
      streamButton.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Builder');
    expect(host.textContent).toContain('Legacy Logs Fallback');
    expect(host.querySelector('[data-testid="legacy-member-logs"]')?.textContent).toBe('Builder');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps removed teammates available for historical logs and labels them', async () => {
    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
        removedAt: 1715000000000,
      },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Lead',
      'Builder (removed)',
    ]);

    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Builder');
    expect(host.textContent).toContain('Builder (removed)');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('deduplicates active and removed teammate sources by name and prefers the active member', async () => {
    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
        removedAt: 1715000000000,
      },
      {
        name: 'Builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Lead',
      'Builder',
    ]);

    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const stream = host.querySelector('[data-testid="member-log-stream"]') as HTMLElement;
    expect(stream.textContent).toBe('Builder');
    expect(stream.getAttribute('data-removed')).toBe('false');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the selected source stable when a teammate name only changes casing', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    let select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];

    await act(async () => {
      root.render(
        React.createElement(ClaudeLogsSection, {
          teamName: 'demo-team',
          sidebarViewerMaxHeight: 240,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    expect(select.value).toBe('builder');
    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('builder');
    expect(host.querySelector('[data-testid="lead-logs-panel"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('resets to lead logs when the team changes even if teammate names overlap', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'team-a' }));
      await Promise.resolve();
    });

    let select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Builder');

    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Builder',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'team-b' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    expect(select.value).toBe('team-lead');
    expect(host.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect(sectionState.memberLogStreamCalls).not.toContainEqual({
      teamName: 'team-b',
      memberName: 'Builder',
      enabled: true,
    });
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'team-b',
      enabled: true,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('falls back to legacy member logs when the stream UI gate is disabled', async () => {
    sectionState.memberLogStreamUiEnabled = false;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ClaudeLogsSection, {
          teamName: 'demo-team',
          sidebarViewerMaxHeight: 240,
        })
      );
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-log-stream"]')).toBeNull();
    expect(host.querySelector('[data-testid="legacy-member-logs"]')?.textContent).toBe('Builder');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens selected teammate logs in fullscreen without switching back to lead', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const fullscreenButton = host.querySelector(
      'button[aria-label="Open fullscreen logs"]'
    ) as HTMLButtonElement;
    await act(async () => {
      fullscreenButton.click();
      await Promise.resolve();
    });

    const dialog = host.querySelector('[data-testid="logs-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Logs');
    expect(dialog.textContent).not.toContain('Logs for');
    expect(
      (dialog.querySelector('select[aria-label="Log source"]') as HTMLSelectElement).value
    ).toBe('Builder');
    expect(dialog.textContent).toContain('Builder');
    expect(host.querySelector('[data-testid="lead-logs-panel"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('can switch log sources from the fullscreen dialog', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const fullscreenButton = host.querySelector(
      'button[aria-label="Open fullscreen logs"]'
    ) as HTMLButtonElement;
    await act(async () => {
      fullscreenButton.click();
      await Promise.resolve();
    });

    const dialog = host.querySelector('[data-testid="logs-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Logs');
    expect(
      (dialog.querySelector('select[aria-label="Log source"]') as HTMLSelectElement).value
    ).toBe('team-lead');
    const dialogMemberSelect = dialog.querySelector(
      '[data-testid="lead-logs-panel"] [data-testid="member-select"]'
    );
    expect(dialogMemberSelect).not.toBeNull();
    expect(dialogMemberSelect?.getAttribute('data-trigger-variant')).toBe('default');

    const dialogSelect = dialog.querySelector(
      'select[aria-label="Log source"]'
    ) as HTMLSelectElement;
    await act(async () => {
      dialogSelect.value = 'Builder';
      dialogSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-log-stream"]')?.textContent).toBe('Builder');
    expect(host.querySelector('[data-testid="lead-logs-panel"]')).toBeNull();
    expect(sectionState.controllerCalls.at(-1)).toEqual({
      teamName: 'demo-team',
      enabled: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('switches back to lead logs from teammate logs in the fullscreen dialog', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const fullscreenButton = host.querySelector(
      'button[aria-label="Open fullscreen logs"]'
    ) as HTMLButtonElement;
    await act(async () => {
      fullscreenButton.click();
      await Promise.resolve();
    });

    const dialog = host.querySelector('[data-testid="logs-dialog"]') as HTMLElement;
    const dialogSelect = dialog.querySelector(
      'select[aria-label="Log source"]'
    ) as HTMLSelectElement;
    expect(dialogSelect.value).toBe('Builder');

    await act(async () => {
      dialogSelect.value = 'team-lead';
      dialogSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(dialog.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="member-log-stream"]')).toBeNull();
    expect(
      (dialog.querySelector('select[aria-label="Log source"]') as HTMLSelectElement).value
    ).toBe('team-lead');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('returns to lead logs when the selected teammate disappears from the roster', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Reviewer',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];

    await act(async () => {
      root.render(
        React.createElement(ClaudeLogsSection, {
          teamName: 'demo-team',
          sidebarViewerMaxHeight: 240,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect((host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement).value).toBe(
      'team-lead'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps fullscreen open and falls back to lead logs when the selected teammate disappears', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ClaudeLogsSection, { teamName: 'demo-team' }));
      await Promise.resolve();
    });

    const select = host.querySelector('select[aria-label="Log source"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'Builder';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const fullscreenButton = host.querySelector(
      'button[aria-label="Open fullscreen logs"]'
    ) as HTMLButtonElement;
    await act(async () => {
      fullscreenButton.click();
      await Promise.resolve();
    });

    sectionState.members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'Reviewer',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];

    await act(async () => {
      root.render(
        React.createElement(ClaudeLogsSection, {
          teamName: 'demo-team',
          sidebarViewerMaxHeight: 240,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialog = host.querySelector('[data-testid="logs-dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(
      (dialog.querySelector('select[aria-label="Log source"]') as HTMLSelectElement).value
    ).toBe('team-lead');
    expect(dialog.querySelector('[data-testid="lead-logs-panel"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="member-log-stream"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
