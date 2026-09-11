import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
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
}));

vi.mock('@renderer/api', () => ({
  api: {
    memberWorkSync: {
      getStatus: apiMocks.getStatus,
      continueManually: apiMocks.continueManually,
    },
  },
  isElectronMode: () => true,
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
    await act(async () => {
      continueButton?.click();
      await Promise.resolve();
    });
    expect(apiMocks.continueManually).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
    });

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
});
