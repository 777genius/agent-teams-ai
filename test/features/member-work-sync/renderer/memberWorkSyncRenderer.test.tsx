import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  MEMBER_WORK_SYNC_STATUS_POLL_MS,
  MemberWorkSyncBadge,
  MemberWorkSyncDetails,
  MemberWorkSyncStatusPanel,
  useMemberWorkSyncStatus,
} from '@features/member-work-sync/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

const apiMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  continueManually: vi.fn(),
  stopAutoResume: vi.fn(),
  resumeAutoResume: vi.fn(),
  isElectronMode: vi.fn(() => true),
}));

vi.mock('@renderer/api', () => ({
  api: {
    memberWorkSync: {
      getStatus: apiMocks.getStatus,
      continueManually: apiMocks.continueManually,
      stopAutoResume: apiMocks.stopAutoResume,
      resumeAutoResume: apiMocks.resumeAutoResume,
    },
  },
  isElectronMode: () => apiMocks.isElectronMode(),
}));

function makeStatus(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      fingerprint: 'agenda:v1:abcdef1234567890',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Ship UI',
          kind: 'work',
          assignee: 'bob',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'bob' },
        },
      ],
      diagnostics: [],
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: true,
      fingerprintChanged: false,
    },
    evaluatedAt: '2026-04-29T00:00:00.000Z',
    diagnostics: ['developer_only'],
    ...overrides,
  };
}

describe('member work sync renderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.isElectronMode.mockReturnValue(true);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads read-only status through the renderer hook', async () => {
    apiMocks.getStatus.mockResolvedValue(makeStatus());
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Harness(): React.ReactElement {
      const state = useMemberWorkSyncStatus({ teamName: 'team-a', memberName: 'bob' });
      return React.createElement('div', null, state.loading ? 'Loading' : state.viewModel.label);
    }

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(apiMocks.getStatus).toHaveBeenCalledWith({ teamName: 'team-a', memberName: 'bob' });
    expect(host.textContent).toContain('Needs sync');
  });

  it('renders neutral diagnostics without exposing raw diagnostics by default', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement(MemberWorkSyncBadge, { status: makeStatus() }),
          React.createElement(MemberWorkSyncDetails, { status: makeStatus() })
        )
      );
    });

    expect(host.textContent).toContain('Needs sync');
    expect(host.textContent).toContain('Shadow would nudge');
    expect(host.textContent).toContain('11111111');
    expect(host.textContent).not.toContain('developer_only');
  });

  it('renders the status panel through the read-only API hook', async () => {
    apiMocks.getStatus.mockResolvedValue(makeStatus());
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncStatusPanel, {
          teamName: 'team-a',
          memberName: 'bob',
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Member work sync');
    expect(host.textContent).toContain('Needs sync');
    expect(host.textContent).toContain('Shadow would nudge');
    expect(apiMocks.getStatus).toHaveBeenCalledWith({ teamName: 'team-a', memberName: 'bob' });
  });

  it('stops and resumes auto-resume through the status panel hook', async () => {
    const attentionHealth = {
      schemaVersion: 1 as const,
      attentionAt: '2026-04-29T00:20:00.000Z',
      episodes: [
        {
          episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
          workKey: 'task-1:bob',
          taskId: 'task-1',
          firstObservedAt: '2026-04-29T00:00:00.000Z',
          dueAt: '2026-04-29T00:20:00.000Z',
          phase: 'attention' as const,
          reason: 'no_progress_deadline' as const,
        },
      ],
    };
    const attention = makeStatus({ recoveryHealth: attentionHealth });
    const stopped = makeStatus({
      recoveryHealth: {
        ...attentionHealth,
        autoResumeStopLatch: {
          stoppedAt: '2026-04-29T00:21:00.000Z',
          reason: 'user_stop',
          controlRevision: 1,
        },
      },
    });
    apiMocks.getStatus.mockResolvedValue(attention);
    apiMocks.stopAutoResume.mockResolvedValue(stopped);
    apiMocks.resumeAutoResume.mockResolvedValue(attention);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncStatusPanel, {
          teamName: 'team-a',
          memberName: 'bob',
        })
      );
      await Promise.resolve();
    });

    const stopButton = host.querySelector(
      '[data-testid="member-work-sync-stop"]'
    ) as HTMLButtonElement | null;
    expect(stopButton).toBeTruthy();
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.stopAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

    const resumeButton = host.querySelector(
      '[data-testid="member-work-sync-resume"]'
    ) as HTMLButtonElement | null;
    expect(resumeButton).toBeTruthy();
    expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
    await act(async () => {
      resumeButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.resumeAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('hides recovery controls in browser mode even when status would permit them', async () => {
    apiMocks.isElectronMode.mockReturnValue(false);
    apiMocks.getStatus.mockResolvedValue(
      makeStatus({
        recoveryHealth: {
          schemaVersion: 1,
          attentionAt: '2026-04-29T00:20:00.000Z',
          episodes: [
            {
              episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
              workKey: 'task-1:bob',
              taskId: 'task-1',
              firstObservedAt: '2026-04-29T00:00:00.000Z',
              dueAt: '2026-04-29T00:20:00.000Z',
              phase: 'attention',
              reason: 'no_progress_deadline',
            },
          ],
        },
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncStatusPanel, {
          teamName: 'team-a',
          memberName: 'bob',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-attention"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-stop"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-resume"]')).toBeNull();
    expect(apiMocks.continueManually).not.toHaveBeenCalled();
    expect(apiMocks.stopAutoResume).not.toHaveBeenCalled();
    expect(apiMocks.resumeAutoResume).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('shows durable attention and sends a manual continue from the details panel', async () => {
    apiMocks.continueManually.mockResolvedValue(makeStatus());
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const status = makeStatus({
      recoveryHealth: {
        schemaVersion: 1,
        attentionAt: '2026-04-29T00:20:00.000Z',
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'attention',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncDetails, {
          status,
          onContinue: apiMocks.continueManually,
          onStop: apiMocks.stopAutoResume,
          onResume: apiMocks.resumeAutoResume,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-attention"]')?.textContent).toContain(
      'No confirmed task progress'
    );
    const continueButton = host.querySelector(
      '[data-testid="member-work-sync-continue"]'
    ) as HTMLButtonElement | null;
    expect(continueButton).toBeTruthy();
    const stopButton = host.querySelector(
      '[data-testid="member-work-sync-stop"]'
    ) as HTMLButtonElement | null;
    expect(stopButton).toBeTruthy();
    expect(host.querySelector('[data-testid="member-work-sync-resume"]')).toBeNull();
    await act(async () => {
      continueButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.continueManually).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.stopAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('hides Continue when auto-resume is stopped', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const status = makeStatus({
      recoveryHealth: {
        schemaVersion: 1,
        attentionAt: '2026-04-29T00:20:00.000Z',
        autoResumeStopLatch: {
          stoppedAt: '2026-04-29T00:21:00.000Z',
          reason: 'user_stop',
          controlRevision: 1,
        },
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'attention',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncDetails, {
          status,
          onContinue: apiMocks.continueManually,
          onStop: apiMocks.stopAutoResume,
          onResume: apiMocks.resumeAutoResume,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-stop"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-stopped"]')?.textContent).toContain(
      'Automatic continuation is stopped'
    );
    const resumeButton = host.querySelector(
      '[data-testid="member-work-sync-resume"]'
    ) as HTMLButtonElement | null;
    expect(resumeButton).toBeTruthy();
    await act(async () => {
      resumeButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.resumeAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps Resume visible after attention has cleared while auto-resume remains stopped', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const status = makeStatus({
      state: 'still_working',
      recoveryHealth: {
        schemaVersion: 1,
        autoResumeStopLatch: {
          stoppedAt: '2026-04-29T00:21:00.000Z',
          reason: 'user_stop',
          controlRevision: 1,
        },
        episodes: [],
      },
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncDetails, {
          status,
          onContinue: apiMocks.continueManually,
          onStop: apiMocks.stopAutoResume,
          onResume: apiMocks.resumeAutoResume,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-attention"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-stop"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-stopped"]')?.textContent).toContain(
      'Automatic continuation is stopped'
    );
    const resumeButton = host.querySelector(
      '[data-testid="member-work-sync-resume"]'
    ) as HTMLButtonElement | null;
    expect(resumeButton).toBeTruthy();
    await act(async () => {
      resumeButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.resumeAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('shows Stop while automatic recovery is observing before attention', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const status = makeStatus({
      recoveryHealth: {
        schemaVersion: 1,
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'observing',
            reason: 'owned_pending_task',
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncDetails, {
          status,
          onContinue: apiMocks.continueManually,
          onStop: apiMocks.stopAutoResume,
          onResume: apiMocks.resumeAutoResume,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-attention"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-resume"]')).toBeNull();
    const stopButton = host.querySelector(
      '[data-testid="member-work-sync-stop"]'
    ) as HTMLButtonElement | null;
    expect(stopButton).toBeTruthy();
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.stopAutoResume).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps the attention explanation without Continue when status is not nudgeable', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const status = makeStatus({
      state: 'still_working',
      recoveryHealth: {
        schemaVersion: 1,
        attentionAt: '2026-04-29T00:20:00.000Z',
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'attention',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncDetails, {
          status,
          onContinue: apiMocks.continueManually,
          onStop: apiMocks.stopAutoResume,
          onResume: apiMocks.resumeAutoResume,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-attention"]')?.textContent).toContain(
      'No confirmed task progress'
    );
    expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-resume"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-work-sync-stop"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it('shows a Continue failure next to the details panel', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const status = makeStatus({
      recoveryHealth: {
        schemaVersion: 1,
        attentionAt: '2026-04-29T00:20:00.000Z',
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'attention',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncDetails, {
          status,
          actionError: 'member_stopped',
          onContinue: apiMocks.continueManually,
          onStop: apiMocks.stopAutoResume,
          onResume: apiMocks.resumeAutoResume,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="member-work-sync-action-error"]')?.textContent).toBe(
      'member_stopped'
    );

    await act(async () => {
      root.unmount();
    });
  });

  it('ignores a stale Continue result after the selected member changes', async () => {
    let resolveContinue!: (status: ReturnType<typeof makeStatus>) => void;
    apiMocks.getStatus.mockImplementation(async (request: { memberName: string }) =>
      makeStatus({
        memberName: request.memberName,
        diagnostics: [`from-${request.memberName}`],
        recoveryHealth: {
          schemaVersion: 1,
          attentionAt: '2026-04-29T00:20:00.000Z',
          episodes: [
            {
              episodeId: `episode:task-1:${request.memberName}:2026-04-29T00:00:00.000Z`,
              workKey: `task-1:${request.memberName}`,
              taskId: 'task-1',
              firstObservedAt: '2026-04-29T00:00:00.000Z',
              dueAt: '2026-04-29T00:20:00.000Z',
              phase: 'attention',
              reason: 'no_progress_deadline',
            },
          ],
        },
      })
    );
    apiMocks.continueManually.mockReturnValue(
      new Promise((resolve) => {
        resolveContinue = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncStatusPanel, {
          teamName: 'team-a',
          memberName: 'bob',
          showDiagnostics: true,
        })
      );
      await Promise.resolve();
    });

    const continueButton = host.querySelector(
      '[data-testid="member-work-sync-continue"]'
    ) as HTMLButtonElement | null;
    expect(continueButton).toBeTruthy();
    await act(async () => {
      continueButton?.click();
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        React.createElement(MemberWorkSyncStatusPanel, {
          teamName: 'team-a',
          memberName: 'alice',
          showDiagnostics: true,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveContinue(
        makeStatus({
          memberName: 'bob',
          diagnostics: ['from-bob-continue'],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('from-alice');
    expect(host.textContent).not.toContain('from-bob-continue');

    await act(async () => {
      root.unmount();
    });
  });

  it('refreshes the status panel while it remains enabled', async () => {
    vi.useFakeTimers();
    const observing = makeStatus({
      recoveryHealth: {
        schemaVersion: 1,
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'expected_wait',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });
    const attention = makeStatus({
      recoveryHealth: {
        schemaVersion: 1,
        attentionAt: '2026-04-29T00:20:00.000Z',
        episodes: [
          {
            episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:bob',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'attention',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });
    apiMocks.getStatus.mockResolvedValueOnce(observing).mockResolvedValueOnce(attention);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          React.createElement(MemberWorkSyncStatusPanel, {
            teamName: 'team-a',
            memberName: 'bob',
          })
        );
        await Promise.resolve();
      });
      expect(host.textContent).toContain('Needs sync');
      expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeNull();
      expect(apiMocks.getStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMBER_WORK_SYNC_STATUS_POLL_MS);
        await Promise.resolve();
      });
      expect(apiMocks.getStatus).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="member-work-sync-attention"]')?.textContent).toContain(
        'No confirmed task progress'
      );
      expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeTruthy();
    } finally {
      await act(async () => {
        root.unmount();
      });
      vi.useRealTimers();
    }
  });

  it('keeps Continue visible when a mixed-case member name polls lowercase status', async () => {
    vi.useFakeTimers();
    const attention = makeStatus({
      memberName: 'olla',
      agenda: {
        teamName: 'team-a',
        memberName: 'olla',
        generatedAt: '2026-04-29T00:00:00.000Z',
        fingerprint: 'agenda:v1:abcdef1234567890',
        items: [
          {
            taskId: 'task-1',
            displayId: '11111111',
            subject: 'Ship UI',
            kind: 'work',
            assignee: 'olla',
            priority: 'normal',
            reason: 'owned_pending_task',
            evidence: { status: 'pending', owner: 'olla' },
          },
        ],
        diagnostics: [],
      },
      recoveryHealth: {
        schemaVersion: 1,
        attentionAt: '2026-04-29T00:20:00.000Z',
        episodes: [
          {
            episodeId: 'episode:task-1:olla:2026-04-29T00:00:00.000Z',
            workKey: 'task-1:olla',
            taskId: 'task-1',
            firstObservedAt: '2026-04-29T00:00:00.000Z',
            dueAt: '2026-04-29T00:20:00.000Z',
            phase: 'attention',
            reason: 'no_progress_deadline',
          },
        ],
      },
    });
    apiMocks.getStatus.mockResolvedValue(attention);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          React.createElement(MemberWorkSyncStatusPanel, {
            teamName: 'team-a',
            memberName: 'Olla',
          })
        );
        await Promise.resolve();
      });
      expect(apiMocks.getStatus).toHaveBeenCalledWith({ teamName: 'team-a', memberName: 'olla' });
      expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMBER_WORK_SYNC_STATUS_POLL_MS);
        await Promise.resolve();
      });
      expect(apiMocks.getStatus).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[data-testid="member-work-sync-continue"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="member-work-sync-attention"]')).toBeTruthy();
    } finally {
      await act(async () => {
        root.unmount();
      });
      vi.useRealTimers();
    }
  });
});
