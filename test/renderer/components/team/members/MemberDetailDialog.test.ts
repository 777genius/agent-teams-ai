import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useStore } from '@renderer/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

const memberLogStreamMockState = vi.hoisted(() => ({
  uiEnabled: true,
}));

vi.mock('@renderer/hooks/useMemberStats', () => ({
  useMemberStats: () => ({
    stats: null,
    loading: false,
    error: null,
  }),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tabs', () => {
  let currentValue = '';
  let currentOnValueChange: ((value: string) => void) | null = null;

  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange?: (value: string) => void;
    }) => {
      currentValue = value;
      currentOnValueChange = onValueChange ?? null;
      return React.createElement('div', { 'data-tabs-value': value }, children);
    },
    TabsList: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          'data-state': currentValue === value ? 'active' : 'inactive',
          onClick: () => currentOnValueChange?.(value),
        },
        children
      ),
    TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) =>
      currentValue === value ? React.createElement('div', null, children) : null,
  };
});

vi.mock('@renderer/components/team/members/MemberDetailHeader', () => ({
  MemberDetailHeader: () => React.createElement('div', null, 'header'),
}));

vi.mock('@renderer/components/team/members/MemberDetailStats', () => ({
  MemberDetailStats: ({ activityCount }: { activityCount: number }) =>
    React.createElement(
      'div',
      { 'data-testid': 'member-detail-stats' },
      `activity-count:${activityCount}`
    ),
}));

vi.mock('@renderer/components/team/members/MemberTasksTab', () => ({
  MemberTasksTab: () => React.createElement('div', null, 'tasks-tab'),
}));

vi.mock('@renderer/components/team/members/MemberMessagesTab', () => ({
  MemberMessagesTab: () => React.createElement('div', null, 'activity-tab'),
}));

vi.mock('@renderer/components/team/members/MemberStatsTab', () => ({
  MemberStatsTab: () => React.createElement('div', null, 'stats-tab'),
}));

vi.mock('@renderer/components/team/members/MemberLogsTab', () => ({
  MemberLogsTab: () => React.createElement('div', null, 'logs-tab'),
}));

vi.mock('@features/member-log-stream/renderer', async () => {
  const ReactModule = await import('react');
  return {
    isMemberLogStreamUiEnabled: () => memberLogStreamMockState.uiEnabled,
    MemberLogStreamSection: ({
      onInitialLoadErrorChange,
    }: {
      onInitialLoadErrorChange?: (hasError: boolean) => void;
    }) =>
      ReactModule.createElement(
        'button',
        {
          type: 'button',
          onClick: () => onInitialLoadErrorChange?.(true),
        },
        'member-log-stream'
      ),
  };
});

import { MemberDetailDialog } from '@renderer/components/team/members/MemberDetailDialog';

describe('MemberDetailDialog activity count', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    memberLogStreamMockState.uiEnabled = true;
    useStore.setState({
      teamMessagesByName: {
        'demo-team': {
          canonicalMessages: [],
          optimisticMessages: [],
          feedRevision: 'rev-empty',
          nextCursor: null,
          hasMore: false,
          lastFetchedAt: null,
          loadingHead: false,
          loadingOlder: false,
          headHydrated: true,
        },
      },
    } as never);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    useStore.setState({ teamMessagesByName: {} } as never);
    vi.unstubAllGlobals();
  });

  it('renders legacy member logs directly when the member log stream UI gate is off', async () => {
    memberLogStreamMockState.uiEnabled = false;
    const member: ResolvedTeamMember = {
      name: 'jack',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          members: [member],
          tasks: [],
          initialTab: 'logs',
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('logs-tab');
    expect(host.textContent).not.toContain('member-log-stream');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the stream visible and renders legacy fallback after an initial stream error', async () => {
    const member: ResolvedTeamMember = {
      name: 'jack',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          members: [member],
          tasks: [],
          initialTab: 'logs',
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const streamButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('member-log-stream')
    );
    expect(streamButton).not.toBeUndefined();

    await act(async () => {
      streamButton?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('member-log-stream');
    expect(host.textContent).toContain('Legacy Logs Fallback');
    expect(host.textContent).toContain('logs-tab');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('counts task comments in the Activity badge even when messageCount is zero', async () => {
    const member: ResolvedTeamMember = {
      name: 'jack',
      status: 'active',
      currentTaskId: null,
      taskCount: 1,
      lastActiveAt: null,
      messageCount: 0,
    };
    const members: ResolvedTeamMember[] = [
      {
        name: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
        agentType: 'team-lead',
      },
      member,
    ];
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 'task-1',
        displayId: '#1',
        subject: 'Review patch',
        owner: 'jack',
        status: 'in_progress',
        comments: [
          {
            id: 'comment-1',
            author: 'jack',
            text: 'Left a review note',
            createdAt: '2026-04-17T10:00:00.000Z',
            type: 'regular',
          },
        ],
        reviewState: 'none',
      } as TeamTaskWithKanban,
    ];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          members,
          tasks,
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('activity-count:1');
    expect(host.textContent).toContain('Activity1');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('copies launch diagnostics from the detail footer only for launch errors', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const member: ResolvedTeamMember = {
      name: 'jack',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          runtimeRunId: 'run-42',
          members: [member],
          tasks: [],
          spawnEntry: {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
            livenessKind: 'runtime_process_candidate',
            runtimeDiagnostic: 'runtime process candidate detected',
            runtimeDiagnosticSeverity: 'warning',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          runtimeEntry: {
            memberName: 'jack',
            alive: false,
            restartable: true,
            pid: 4242,
            pidSource: 'tmux_child',
            processCommand: 'node runtime --api-key abc123',
            updatedAt: '2026-04-24T12:00:01.000Z',
          },
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
        })
      );
      await Promise.resolve();
    });

    let copyButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Copy diagnostics')
    );
    expect(copyButton).toBeUndefined();

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          runtimeRunId: 'run-42',
          members: [member],
          tasks: [],
          spawnEntry: {
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'runtime process failed',
            agentToolAccepted: false,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'runtime process failed',
            runtimeDiagnosticSeverity: 'error',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          runtimeEntry: {
            memberName: 'jack',
            alive: false,
            restartable: true,
            pid: 4242,
            pidSource: 'tmux_child',
            processCommand: 'node runtime --api-key abc123',
            updatedAt: '2026-04-24T12:00:01.000Z',
          },
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
        })
      );
      await Promise.resolve();
    });

    copyButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Copy diagnostics')
    );
    expect(copyButton).not.toBeUndefined();

    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const payload = JSON.parse(writeText.mock.calls[0][0] as string) as {
      runId?: string;
      livenessKind?: string;
      processCommand?: string;
    };
    expect(payload.runId).toBe('run-42');
    expect(payload.livenessKind).toBe('not_found');
    expect(payload.processCommand).toContain('--api-key [redacted]');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows Relaunch OpenCode copy for failed OpenCode teammates without runtime evidence', async () => {
    const member: ResolvedTeamMember = {
      name: 'jack',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      providerId: 'opencode',
    };
    const onRestartMember = vi.fn(() => Promise.resolve(undefined));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          members: [member],
          tasks: [],
          isTeamAlive: true,
          spawnEntry: {
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'File lock timeout: lanes.json',
            agentToolAccepted: false,
            livenessKind: 'registered_only',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          runtimeEntry: {
            memberName: 'jack',
            alive: false,
            restartable: true,
            providerId: 'opencode',
            livenessKind: 'registered_only',
            runtimeDiagnostic: 'registered runtime metadata without live process',
            runtimeDiagnosticSeverity: 'warning',
            updatedAt: '2026-04-24T12:00:01.000Z',
          },
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
          onRestartMember,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'No OpenCode runtime session was recorded. Relaunch this teammate to start a fresh OpenCode session.'
    );
    const relaunchButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Relaunch OpenCode')
    );
    expect(relaunchButton).not.toBeUndefined();

    await act(async () => {
      relaunchButton?.click();
      await Promise.resolve();
    });

    expect(onRestartMember).toHaveBeenCalledWith('jack');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows Relaunch OpenCode copy for unsafe provisioned-but-not-alive OpenCode teammates without runtime evidence', async () => {
    const member: ResolvedTeamMember = {
      name: 'jack',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      providerId: 'opencode',
    };
    const onRestartMember = vi.fn(() => Promise.resolve(undefined));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          members: [member],
          tasks: [],
          isTeamAlive: true,
          spawnEntry: {
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
            agentToolAccepted: true,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'Runtime is no longer registered',
            runtimeDiagnosticSeverity: 'warning',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
          onRestartMember,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'No OpenCode runtime session was recorded. Relaunch this teammate to start a fresh OpenCode session.'
    );
    const relaunchButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Relaunch OpenCode')
    );
    expect(relaunchButton).not.toBeUndefined();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows Relaunch OpenCode copy for stalled OpenCode bootstrap', async () => {
    const member: ResolvedTeamMember = {
      name: 'tom',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      providerId: 'opencode',
    };
    const onRestartMember = vi.fn(() => Promise.resolve(undefined));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailDialog, {
          open: true,
          member,
          teamName: 'demo-team',
          members: [member],
          tasks: [],
          isTeamAlive: true,
          spawnEntry: {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
            runtimeDiagnosticSeverity: 'warning',
            bootstrapStalled: true,
            updatedAt: '2026-04-24T12:05:00.000Z',
          },
          runtimeEntry: {
            memberName: 'tom',
            alive: true,
            restartable: true,
            providerId: 'opencode',
            livenessKind: 'runtime_process',
            runtimeDiagnostic: 'OpenCode runtime process detected',
            runtimeDiagnosticSeverity: 'info',
            updatedAt: '2026-04-24T12:05:01.000Z',
          },
          onClose: () => undefined,
          onSendMessage: () => undefined,
          onAssignTask: () => undefined,
          onTaskClick: () => undefined,
          onRestartMember,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'OpenCode process is alive, but bootstrap did not confirm. Relaunch this teammate to start a fresh OpenCode session.'
    );
    const relaunchButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Relaunch OpenCode')
    );
    expect(relaunchButton).not.toBeUndefined();

    await act(async () => {
      relaunchButton?.click();
      await Promise.resolve();
    });

    expect(onRestartMember).toHaveBeenCalledWith('tom');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
