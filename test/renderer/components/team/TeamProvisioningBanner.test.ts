import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  progress: null as Record<string, unknown> | null,
  cancelProvisioning: vi.fn(),
  selectedTeamName: 'northstar-core',
  selectedTeamData: {
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'reviewer', runtimeAdvisory: undefined },
      { name: 'bob', agentType: 'developer' },
      { name: 'jack', agentType: 'developer' },
    ] as Array<Record<string, unknown>>,
  },
  memberSpawnStatusesByTeam: {
    'northstar-core': {},
  },
  memberSpawnSnapshotsByTeam: {} as Record<string, unknown>,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  getCurrentProvisioningProgressForTeam: () => storeState.progress,
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'button' }, children),
}));

vi.mock('@renderer/components/team/ProvisioningProgressBlock', () => ({
  ProvisioningProgressBlock: ({
    currentStepIndex,
    successMessage,
    successMessageSeverity,
  }: {
    currentStepIndex: number;
    successMessage?: string | null;
    successMessageSeverity?: string;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'progress-block',
        'data-current-step-index': String(currentStepIndex),
        'data-success-severity': successMessageSeverity ?? '',
      },
      successMessage ?? ''
    ),
}));

import { TeamProvisioningBanner } from '@renderer/components/team/TeamProvisioningBanner';

describe('TeamProvisioningBanner launch-step alignment', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    storeState.selectedTeamName = 'northstar-core';
    storeState.progress = {
      runId: 'run-1',
      teamName: 'northstar-core',
      state: 'ready',
      startedAt: '2026-04-08T16:00:00.000Z',
      message: 'Launch completed',
      messageSeverity: undefined,
      pid: 1234,
      cliLogsTail: '',
      assistantOutput: '',
    };
    storeState.memberSpawnStatusesByTeam['northstar-core'] = {};
    storeState.selectedTeamData.members = [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'reviewer', runtimeAdvisory: undefined },
      { name: 'bob', agentType: 'developer', runtimeAdvisory: undefined },
      { name: 'jack', agentType: 'developer', runtimeAdvisory: undefined },
    ];
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = {
      runId: 'run-1',
      expectedMembers: ['alice', 'bob', 'jack'],
      statuses: {},
      summary: {
        confirmedCount: 0,
        pendingCount: 3,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      source: 'merged',
    };
  });

  it('keeps Members joining as the active step while teammates are still starting after ready', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TeamProvisioningBanner, { teamName: 'northstar-core' }));
      await Promise.resolve();
    });

    const block = host.querySelector('[data-testid="progress-block"]');
    expect(block?.getAttribute('data-current-step-index')).toBe('2');
    expect(block?.textContent).toContain('0/3 teammates made contact');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows all steps complete only after teammates actually made contact', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = {
      runId: 'run-1',
      expectedMembers: ['alice', 'bob', 'jack'],
      statuses: {},
      summary: {
        confirmedCount: 3,
        pendingCount: 0,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      source: 'merged',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TeamProvisioningBanner, { teamName: 'northstar-core' }));
      await Promise.resolve();
    });

    const block = host.querySelector('[data-testid="progress-block"]');
    expect(block?.getAttribute('data-current-step-index')).toBe('4');
    expect(block?.textContent).toContain('all 3 teammates made contact');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps warning severity while runtimes are online but teammate contact is still pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = {
      runId: 'run-1',
      expectedMembers: ['alice', 'bob', 'jack'],
      statuses: {},
      summary: {
        confirmedCount: 0,
        pendingCount: 3,
        failedCount: 0,
        runtimeAlivePendingCount: 3,
      },
      source: 'merged',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TeamProvisioningBanner, { teamName: 'northstar-core' }));
      await Promise.resolve();
    });

    const block = host.querySelector('[data-testid="progress-block"]');
    expect(block?.getAttribute('data-current-step-index')).toBe('2');
    expect(block?.getAttribute('data-success-severity')).toBe('warning');
    expect(block?.textContent).toContain('teammates online');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('surfaces provider retry wording when pending runtimes are retrying provider capacity', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.selectedTeamData.members = [
      { name: 'team-lead', agentType: 'team-lead' },
      {
        name: 'alice',
        agentType: 'reviewer',
        runtimeAdvisory: {
          kind: 'sdk_retrying',
          observedAt: '2026-04-09T10:00:00.000Z',
          retryUntil: '2026-04-09T10:00:45.000Z',
          retryDelayMs: 45_000,
        },
      },
      {
        name: 'bob',
        agentType: 'developer',
        runtimeAdvisory: {
          kind: 'sdk_retrying',
          observedAt: '2026-04-09T10:00:00.000Z',
          retryUntil: '2026-04-09T10:00:45.000Z',
          retryDelayMs: 45_000,
        },
      },
      {
        name: 'jack',
        agentType: 'developer',
        runtimeAdvisory: {
          kind: 'sdk_retrying',
          observedAt: '2026-04-09T10:00:00.000Z',
          retryUntil: '2026-04-09T10:00:45.000Z',
          retryDelayMs: 45_000,
        },
      },
    ];
    storeState.memberSpawnStatusesByTeam['northstar-core'] = {
      alice: {
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        updatedAt: '2026-04-09T10:00:00.000Z',
        runtimeAlive: true,
      },
      bob: {
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        updatedAt: '2026-04-09T10:00:00.000Z',
        runtimeAlive: true,
      },
      jack: {
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        updatedAt: '2026-04-09T10:00:00.000Z',
        runtimeAlive: true,
      },
    };
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = {
      runId: 'run-1',
      expectedMembers: ['alice', 'bob', 'jack'],
      statuses: {},
      summary: {
        confirmedCount: 1,
        pendingCount: 3,
        failedCount: 0,
        runtimeAlivePendingCount: 3,
      },
      source: 'merged',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TeamProvisioningBanner, { teamName: 'northstar-core' }));
      await Promise.resolve();
    });

    const block = host.querySelector('[data-testid="progress-block"]');
    expect(block?.textContent).toContain('retrying provider capacity');
    expect(block?.getAttribute('data-success-severity')).toBe('warning');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
