import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberSpawnStatusEntry, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

vi.mock('@renderer/components/team/members/MemberCard', () => ({
  MemberCard: ({
    member,
    spawnError,
    spawnStatus,
    spawnLaunchState,
    currentTask,
    reviewTask,
    onRestartMember,
    onSkipMemberForLaunch,
  }: {
    member: ResolvedTeamMember;
    spawnError?: string;
    spawnStatus?: string;
    spawnLaunchState?: string;
    currentTask?: TeamTaskWithKanban | null;
    reviewTask?: TeamTaskWithKanban | null;
    onRestartMember?: (memberName: string) => void;
    onSkipMemberForLaunch?: (memberName: string) => void;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': `member-${member.name}` },
      spawnError ?? '',
      currentTask
        ? React.createElement('span', { 'data-testid': `current-${member.name}` }, currentTask.id)
        : null,
      reviewTask
        ? React.createElement('span', { 'data-testid': `review-${member.name}` }, reviewTask.id)
        : null,
      onRestartMember && (spawnStatus === 'error' || spawnLaunchState === 'failed_to_start')
        ? React.createElement(
            'button',
            {
              'data-testid': `retry-${member.name}`,
              type: 'button',
              onClick: () => onRestartMember(member.name),
            },
            'retry'
          )
        : null,
      onSkipMemberForLaunch && (spawnStatus === 'error' || spawnLaunchState === 'failed_to_start')
        ? React.createElement(
            'button',
            {
              'data-testid': `skip-${member.name}`,
              type: 'button',
              onClick: () => onSkipMemberForLaunch(member.name),
            },
            'skip'
          )
        : null
    ),
}));

import { MemberList } from '@renderer/components/team/members/MemberList';

const member: ResolvedTeamMember = {
  name: 'bob',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'developer',
  role: 'Developer',
  providerId: 'opencode',
  model: 'opencode/minimax-m2.5-free',
  removedAt: undefined,
};

function failedSpawnStatus(reason: string): MemberSpawnStatusEntry {
  return {
    status: 'error',
    launchState: 'failed_to_start',
    updatedAt: '2026-04-23T10:00:00.000Z',
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: true,
    hardFailureReason: reason,
    agentToolAccepted: false,
  };
}

function offlineSpawnStatus(): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'confirmed_alive',
    updatedAt: '2026-04-23T10:00:00.000Z',
    runtimeAlive: false,
    bootstrapConfirmed: false,
  };
}

function activeTask(id = 'task-active'): TeamTaskWithKanban {
  return {
    id,
    subject: 'Active task',
    status: 'in_progress',
  };
}

describe('MemberList spawn-status memoization', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe(): void {}
        disconnect(): void {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('rerenders cards when only the hard failure reason changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const members = [member];

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: new Map([['bob', failedSpawnStatus('initial OpenCode failure')]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('initial OpenCode failure');

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: new Map([['bob', failedSpawnStatus('updated OpenCode failure')]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('updated OpenCode failure');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('passes retry callbacks to failed member cards and rerenders when the callback changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const members = [member];
    const firstRestart = vi.fn();
    const secondRestart = vi.fn();
    const spawnStatuses = new Map([['bob', failedSpawnStatus('OpenCode failed')]]);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: spawnStatuses,
          onRestartMember: firstRestart,
        })
      );
      await Promise.resolve();
    });

    const firstRetry = host.querySelector('[data-testid="retry-bob"]') as HTMLButtonElement;
    expect(firstRetry).not.toBeNull();

    await act(async () => {
      firstRetry.click();
      await Promise.resolve();
    });

    expect(firstRestart).toHaveBeenCalledWith('bob');

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: spawnStatuses,
          onRestartMember: secondRestart,
        })
      );
      await Promise.resolve();
    });

    const secondRetry = host.querySelector('[data-testid="retry-bob"]') as HTMLButtonElement;
    expect(secondRetry).not.toBeNull();

    await act(async () => {
      secondRetry.click();
      await Promise.resolve();
    });

    expect(secondRestart).toHaveBeenCalledWith('bob');
    expect(firstRestart).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows a review task when a stale currentTaskId points at the same non-active task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const members: ResolvedTeamMember[] = [{ ...member, currentTaskId: 'task-review' }];
    const reviewTask: TeamTaskWithKanban = {
      id: 'task-review',
      subject: 'Review this',
      status: 'completed',
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'bob',
    };

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          taskMap: new Map([[reviewTask.id, reviewTask]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="current-bob"]')).toBeNull();
    expect(host.querySelector('[data-testid="review-bob"]')?.textContent).toBe('task-review');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not pass active current tasks to cards while the whole team is offline', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const task = activeTask();
    const members: ResolvedTeamMember[] = [{ ...member, currentTaskId: task.id }];

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: false,
          taskMap: new Map([[task.id, task]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="current-bob"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not pass active current tasks to cards for individually offline members', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const task = activeTask();
    const members: ResolvedTeamMember[] = [{ ...member, currentTaskId: task.id }];

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          taskMap: new Map([[task.id, task]]),
          memberSpawnStatuses: new Map([['bob', offlineSpawnStatus()]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="current-bob"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('passes skip callbacks to failed member cards and rerenders when the callback changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const members = [member];
    const firstSkip = vi.fn();
    const secondSkip = vi.fn();
    const spawnStatuses = new Map([['bob', failedSpawnStatus('OpenCode failed')]]);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: spawnStatuses,
          onSkipMemberForLaunch: firstSkip,
        })
      );
      await Promise.resolve();
    });

    const firstButton = host.querySelector('[data-testid="skip-bob"]') as HTMLButtonElement;
    expect(firstButton).not.toBeNull();

    await act(async () => {
      firstButton.click();
      await Promise.resolve();
    });

    expect(firstSkip).toHaveBeenCalledWith('bob');

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: spawnStatuses,
          onSkipMemberForLaunch: secondSkip,
        })
      );
      await Promise.resolve();
    });

    const secondButton = host.querySelector('[data-testid="skip-bob"]') as HTMLButtonElement;
    expect(secondButton).not.toBeNull();

    await act(async () => {
      secondButton.click();
      await Promise.resolve();
    });

    expect(secondSkip).toHaveBeenCalledWith('bob');
    expect(firstSkip).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
