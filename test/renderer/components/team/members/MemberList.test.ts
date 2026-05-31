import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamTaskWithKanban,
} from '@shared/types';

const memberCardRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('@renderer/components/team/members/MemberCard', () => ({
  MemberCard: (props: {
    member: ResolvedTeamMember;
    spawnError?: string;
    spawnStatus?: string;
    spawnLaunchState?: string;
    currentTask?: TeamTaskWithKanban | null;
    reviewTask?: TeamTaskWithKanban | null;
    runtimeEntry?: TeamAgentRuntimeEntry;
    onOpenTask?: () => void;
    onRestartMember?: (memberName: string) => void;
    onSkipMemberForLaunch?: (memberName: string) => void;
    onRestoreMember?: (memberName: string) => void;
    isRemoved?: boolean;
  }) => {
    memberCardRenderSpy(props);
    const {
      member,
      spawnError,
      spawnStatus,
      spawnLaunchState,
      currentTask,
      reviewTask,
      onOpenTask,
      onRestartMember,
      onSkipMemberForLaunch,
      onRestoreMember,
      isRemoved,
    } = props;
    return React.createElement(
      'div',
      { 'data-testid': `member-${member.name}` },
      spawnError ?? '',
      currentTask
        ? React.createElement('span', { 'data-testid': `current-${member.name}` }, currentTask.id)
        : null,
      currentTask && onOpenTask
        ? React.createElement(
            'button',
            {
              'data-testid': `open-task-${member.name}`,
              type: 'button',
              onClick: onOpenTask,
            },
            'open'
          )
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
        : null,
      onRestoreMember && isRemoved
        ? React.createElement(
            'button',
            {
              'data-testid': `restore-${member.name}`,
              type: 'button',
              onClick: () => onRestoreMember(member.name),
            },
            'restore'
          )
        : null
    );
  },
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

function provisionedButNotAliveSpawnStatus(): MemberSpawnStatusEntry {
  return {
    status: 'error',
    launchState: 'failed_to_start',
    updatedAt: '2026-05-25T20:14:02.147Z',
    runtimeAlive: false,
    bootstrapConfirmed: true,
    hardFailure: true,
    hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
    livenessKind: 'confirmed_bootstrap',
  };
}

function activeTask(id = 'task-active'): TeamTaskWithKanban {
  return {
    id,
    subject: 'Active task',
    status: 'in_progress',
  };
}

function liveRuntimeEntry(
  overrides: Partial<TeamAgentRuntimeEntry> = {}
): TeamAgentRuntimeEntry {
  return {
    memberName: 'bob',
    alive: true,
    restartable: true,
    providerId: 'opencode',
    pid: 222,
    rssBytes: 220 * 1024 * 1024,
    cpuPercent: 5,
    processCount: 2,
    runtimeLoadScope: 'process-tree',
    resourceHistory: [
      {
        timestamp: '2026-05-31T10:00:00.000Z',
        rssBytes: 220 * 1024 * 1024,
        cpuPercent: 5,
      },
    ],
    updatedAt: '2026-05-31T10:00:00.000Z',
    ...overrides,
  };
}

describe('MemberList spawn-status memoization', () => {
  beforeEach(() => {
    memberCardRenderSpy.mockClear();
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

  it('does not label an empty roster as solo when the team summary still expects teammates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [],
          expectedTeammateCount: 2,
          isRosterLoading: true,
          isTeamAlive: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Loading team members"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Team members are loading');
    expect(host.textContent).not.toContain('Solo team');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not render a lead-only roster while expected teammates are still loading', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [
            {
              ...member,
              name: 'team-lead',
              agentType: 'team-lead',
              role: 'Team Lead',
            },
          ],
          expectedTeammateCount: 2,
          isRosterLoading: true,
          isTeamAlive: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Loading team members"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Team members are loading');
    expect(host.querySelector('[data-testid="member-team-lead"]')).toBeNull();
    expect(host.textContent).not.toContain('Solo team');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not keep a skeleton for a settled count-only roster summary', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [],
          expectedTeammateCount: 2,
          isRosterLoading: false,
          isTeamProvisioning: false,
          isTeamAlive: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Loading team members"]')).toBeNull();
    expect(host.textContent).toContain('Member roster unavailable');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not keep a skeleton for an offline team with stale settling metadata', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [],
          expectedTeammateCount: 2,
          isLaunchSettling: true,
          isRosterLoading: false,
          isTeamProvisioning: false,
          isTeamAlive: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Loading team members"]')).toBeNull();
    expect(host.textContent).toContain('Member roster unavailable');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders the lead card after loading settles even when summary still expects teammates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [
            {
              ...member,
              name: 'team-lead',
              agentType: 'team-lead',
              role: 'Team Lead',
            },
          ],
          expectedTeammateCount: 2,
          isRosterLoading: false,
          isTeamProvisioning: false,
          isTeamAlive: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Loading team members"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-team-lead"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('refreshes row action handlers when parent callbacks change', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const firstOpenTask = vi.fn();
    const secondOpenTask = vi.fn();
    const task = activeTask();
    const activeMember = { ...member, currentTaskId: task.id };
    const taskMap = new Map([[task.id, task]]);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [activeMember],
          taskMap,
          isTeamAlive: true,
          onOpenTask: firstOpenTask,
        })
      );
      await Promise.resolve();
    });

    host.querySelector<HTMLButtonElement>('[data-testid="open-task-bob"]')?.click();
    expect(firstOpenTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [activeMember],
          taskMap,
          isTeamAlive: true,
          onOpenTask: secondOpenTask,
        })
      );
      await Promise.resolve();
    });

    host.querySelector<HTMLButtonElement>('[data-testid="open-task-bob"]')?.click();
    expect(firstOpenTask).toHaveBeenCalledTimes(1);
    expect(secondOpenTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('rerenders cards when visible member configuration changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [member],
          isTeamAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).toHaveBeenCalledTimes(1);
    memberCardRenderSpy.mockClear();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members: [
            {
              ...member,
              isolation: 'worktree',
              providerBackendId: 'opencode-cli',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              mcpPolicy: { mode: 'appOnly' },
            },
          ],
          isTeamAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
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

  it('does not rerender cards when only cached runtime telemetry changes', async () => {
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
          memberRuntimeEntries: new Map([['bob', liveRuntimeEntry()]]),
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).toHaveBeenCalledTimes(1);
    memberCardRenderSpy.mockClear();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberRuntimeEntries: new Map([
            [
              'bob',
              liveRuntimeEntry({
                resourceHistory: [
                  {
                    timestamp: '2026-05-31T10:00:00.000Z',
                    rssBytes: 220 * 1024 * 1024,
                    cpuPercent: 5,
                  },
                  {
                    timestamp: '2026-05-31T10:00:05.000Z',
                    rssBytes: 220 * 1024 * 1024,
                    cpuPercent: 5,
                  },
                ],
              }),
            ],
          ]),
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).not.toHaveBeenCalled();
    memberCardRenderSpy.mockClear();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberRuntimeEntries: new Map([
            [
              'bob',
              liveRuntimeEntry({
                cpuPercent: 7,
                resourceHistory: [
                  {
                    timestamp: '2026-05-31T10:00:05.000Z',
                    rssBytes: 220 * 1024 * 1024,
                    cpuPercent: 7,
                  },
                ],
              }),
            ],
          ]),
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).not.toHaveBeenCalled();
    memberCardRenderSpy.mockClear();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberRuntimeEntries: new Map([
            [
              'bob',
              liveRuntimeEntry({
                runtimeDiagnosticSeverity: 'error',
                runtimeDiagnostic: 'runtime went stale',
              }),
            ],
          ]),
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps hovered runtime telemetry preview on cached snapshots', async () => {
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
          memberRuntimeEntries: new Map([['bob', liveRuntimeEntry()]]),
        })
      );
      await Promise.resolve();
    });

    const list = host.querySelector('.runtime-telemetry-list');
    expect(list).not.toBeNull();

    await act(async () => {
      list?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).toHaveBeenCalledTimes(2);
    memberCardRenderSpy.mockClear();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberRuntimeEntries: new Map([
            [
              'bob',
              liveRuntimeEntry({
                cpuPercent: 12,
                rssBytes: 240 * 1024 * 1024,
                resourceHistory: [
                  {
                    timestamp: '2026-05-31T10:00:05.000Z',
                    rssBytes: 230 * 1024 * 1024,
                    cpuPercent: 10,
                  },
                  {
                    timestamp: '2026-05-31T10:00:10.000Z',
                    rssBytes: 240 * 1024 * 1024,
                    cpuPercent: 12,
                  },
                ],
              }),
            ],
          ]),
        })
      );
      await Promise.resolve();
    });

    expect(memberCardRenderSpy).not.toHaveBeenCalled();

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

  it('passes restore callbacks to removed member cards and rerenders when the callback changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const members: ResolvedTeamMember[] = [{ ...member, removedAt: 1715000000000 }];
    const firstRestore = vi.fn();
    const secondRestore = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: false,
          onRestoreMember: firstRestore,
        })
      );
      await Promise.resolve();
    });

    const firstButton = host.querySelector('[data-testid="restore-bob"]') as HTMLButtonElement;
    expect(firstButton).not.toBeNull();

    await act(async () => {
      firstButton.click();
      await Promise.resolve();
    });

    expect(firstRestore).toHaveBeenCalledWith('bob');

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: false,
          onRestoreMember: secondRestore,
        })
      );
      await Promise.resolve();
    });

    const secondButton = host.querySelector('[data-testid="restore-bob"]') as HTMLButtonElement;
    expect(secondButton).not.toBeNull();

    await act(async () => {
      secondButton.click();
      await Promise.resolve();
    });

    expect(secondRestore).toHaveBeenCalledWith('bob');
    expect(firstRestore).toHaveBeenCalledTimes(1);

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

  it('keeps tasks visible and suppresses launch actions for healed provisioned-but-not-alive status', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const task = activeTask();
    const members: ResolvedTeamMember[] = [{ ...member, currentTaskId: task.id }];
    const restart = vi.fn();
    const skip = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          taskMap: new Map([[task.id, task]]),
          memberSpawnStatuses: new Map([['bob', provisionedButNotAliveSpawnStatus()]]),
          memberRuntimeEntries: new Map<string, TeamAgentRuntimeEntry>([
            [
              'bob',
              {
                memberName: 'bob',
                alive: false,
                restartable: true,
                livenessKind: 'confirmed_bootstrap',
                runtimeDiagnostic:
                  'runtime pid could not be verified because process table is unavailable',
                runtimeDiagnosticSeverity: 'warning',
                updatedAt: '2026-05-25T20:14:05.411Z',
              },
            ],
          ]),
          onRestartMember: restart,
          onSkipMemberForLaunch: skip,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="current-bob"]')?.textContent).toBe(task.id);
    expect(host.querySelector('[data-testid="retry-bob"]')).toBeNull();
    expect(host.querySelector('[data-testid="skip-bob"]')).toBeNull();
    expect(host.textContent).not.toContain('team provisioned but not alive');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps stopped provisioned-but-not-alive status failed and actionable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const task = activeTask();
    const members: ResolvedTeamMember[] = [{ ...member, currentTaskId: task.id }];
    const restart = vi.fn();
    const skip = vi.fn();
    const spawnEntry = {
      ...provisionedButNotAliveSpawnStatus(),
      livenessKind: 'not_found',
      runtimeDiagnostic: 'Runtime is no longer registered',
      runtimeDiagnosticSeverity: 'warning',
    } satisfies MemberSpawnStatusEntry;

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          taskMap: new Map([[task.id, task]]),
          memberSpawnStatuses: new Map([['bob', spawnEntry]]),
          onRestartMember: restart,
          onSkipMemberForLaunch: skip,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="current-bob"]')).toBeNull();
    expect(host.querySelector('[data-testid="retry-bob"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="skip-bob"]')).not.toBeNull();
    expect(host.textContent).toContain('team provisioned but not alive');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides tasks for healed provisioned-but-not-alive status when runtime has an error', async () => {
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
          memberSpawnStatuses: new Map([['bob', provisionedButNotAliveSpawnStatus()]]),
          memberRuntimeEntries: new Map<string, TeamAgentRuntimeEntry>([
            [
              'bob',
              {
                memberName: 'bob',
                alive: false,
                restartable: true,
                livenessKind: 'confirmed_bootstrap',
                runtimeDiagnostic: 'Runtime process crashed',
                runtimeDiagnosticSeverity: 'error',
                updatedAt: '2026-05-25T20:14:05.411Z',
              },
            ],
          ]),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="current-bob"]')).toBeNull();
    expect(host.querySelector('[data-testid="retry-bob"]')).toBeNull();
    expect(host.querySelector('[data-testid="skip-bob"]')).toBeNull();
    expect(host.textContent).toContain('team provisioned but not alive');

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
