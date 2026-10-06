import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  progress: null as Record<string, unknown> | null,
  cancelProvisioning: vi.fn(),
  provisioningErrorByTeam: {} as Record<string, string>,
  clearProvisioningError: vi.fn(),
  retryFailedOpenCodeSecondaryLanes: vi.fn(),
  selectedTeamName: 'synthetic-cancel-test',
  selectedTeamData: {
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'alice', agentType: 'reviewer', runtimeAdvisory: undefined },
      { name: 'bob', agentType: 'developer' },
      { name: 'jack', agentType: 'developer' },
    ] as Record<string, unknown>[],
  },
  teamDataCacheByName: {
    'synthetic-cancel-test': {
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'alice', agentType: 'reviewer', runtimeAdvisory: undefined },
        { name: 'bob', agentType: 'developer' },
        { name: 'jack', agentType: 'developer' },
      ],
    },
  } as Record<string, { members: Record<string, unknown>[] }>,
  memberSpawnStatusesByTeam: {
    'synthetic-cancel-test': {},
  },
  memberSpawnSnapshotsByTeam: {} as Record<string, unknown>,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  getCurrentProvisioningProgressForTeam: () => storeState.progress,
  selectTeamDataForName: () => storeState.selectedTeamData,
  selectTeamMemberSnapshotsForName: () => storeState.selectedTeamData.members,
  selectResolvedMembersForTeamName: () => storeState.selectedTeamData.members,
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, onClick, 'aria-label': ariaLabel }: React.ComponentProps<'button'>) =>
    React.createElement('button', { type: 'button', onClick, 'aria-label': ariaLabel }, children),
}));

vi.mock('@renderer/components/team/ProvisioningProgressBlock', () => ({
  ProvisioningProgressBlock: ({
    currentStepIndex,
    loading,
    message,
    successMessage,
    successMessageSeverity,
    onCancel,
  }: {
    currentStepIndex: number;
    loading?: boolean;
    message?: string | null;
    successMessage?: string | null;
    successMessageSeverity?: string;
    onCancel?: (() => void) | null;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'progress-block',
        'data-current-step-index': String(currentStepIndex),
        'data-loading': loading ? 'true' : 'false',
        'data-success-severity': successMessageSeverity ?? '',
      },
      [successMessage, message].filter(Boolean).join(' '),
      onCancel
        ? React.createElement('button', { onClick: onCancel, 'data-testid': 'cancel' }, 'Cancel')
        : null
    ),
}));

import { TeamProvisioningPanel } from '@renderer/components/team/TeamProvisioningPanel';

describe('synthetic provisioning cancellation UI ownership', () => {
  beforeEach(() => {
    storeState.cancelProvisioning.mockReset();
    storeState.cancelProvisioning.mockResolvedValue(undefined);
    storeState.progress = {
      runId: 'run-1',
      teamName: 'synthetic-cancel-test',
      state: 'configuring',
      startedAt: '2026-04-08T16:00:00.000Z',
      message: 'Preparing test team',
      configReady: false,
      cliLogsTail: '',
      assistantOutput: '',
    };
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });
  async function settle(action: () => void): Promise<void> {
    await act(async () => {
      action();
      // Flush the observed cancellation continuation before asserting mounted UI state.
      await Promise.resolve();
    });
  }

  function deferredCancellation() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  async function mountCancellablePanel() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.progress = { ...storeState.progress, state: 'configuring', configReady: false };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await settle(() => {
      root.render(
        React.createElement(TeamProvisioningPanel, { teamName: 'synthetic-cancel-test' })
      );
    });
    return { host, root };
  }

  // Red if a rejection is unobserved, repeated clicks dispatch twice, or an old result
  // changes cancellation state belonging to a replacement run.
  it('observes cancellation failure, exposes it and allows an explicit retry', async () => {
    const attempt = deferredCancellation();
    storeState.cancelProvisioning.mockReturnValueOnce(attempt.promise);
    const { host, root } = await mountCancellablePanel();
    try {
      const cancel = host.querySelector('[data-testid="cancel"]');
      expect(cancel).not.toBeNull();
      await settle(() => {
        cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(storeState.cancelProvisioning).toHaveBeenCalledTimes(1);
      expect(storeState.cancelProvisioning).toHaveBeenCalledWith('run-1');
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Cancelling');
      await settle(() => {
        attempt.reject(new Error('Provisioning cannot be cancelled in current state'));
      });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Provisioning cannot be cancelled in current state'
      );
      expect(host.querySelector('[role="status"]')).toBeNull();
      await settle(() => {
        host
          .querySelector('[data-testid="cancel"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(storeState.cancelProvisioning).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      attempt.resolve();
      await settle(() => root.unmount());
    }
  });

  it('keeps a replacement run pending when the old cancellation rejects', async () => {
    const old = deferredCancellation();
    const current = deferredCancellation();
    storeState.cancelProvisioning
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { host, root } = await mountCancellablePanel();
    try {
      await settle(() => {
        host
          .querySelector('[data-testid="cancel"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      // The mounted panel and runId stay the same; startedAt distinguishes the replacement owner.
      storeState.progress = { ...storeState.progress, startedAt: '2026-04-08T16:01:00.000Z' };
      await settle(() => {
        root.render(
          React.createElement(TeamProvisioningPanel, {
            teamName: 'synthetic-cancel-test',
            className: 'replacement-render',
          })
        );
      });
      expect(host.querySelector('[role="status"]')).toBeNull();
      await settle(() => {
        host
          .querySelector('[data-testid="cancel"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(storeState.cancelProvisioning).toHaveBeenCalledTimes(2);
      await settle(() => {
        old.reject(new Error('Old owner cancellation failed'));
      });
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Cancelling');
      await settle(() => {
        current.resolve();
      });
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally {
      old.resolve();
      current.resolve();
      await settle(() => root.unmount());
    }
  });
});
