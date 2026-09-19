import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { GraphProvisioningHud } from '@features/agent-graph/renderer/ui/GraphProvisioningHud';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  stepperProps: [] as { active?: boolean }[],
}));

const hookState = {
  presentation: null as {
    isActive: boolean;
    isFailed: boolean;
    hasMembersStillJoining: boolean;
    failedSpawnCount: number;
    compactTone: 'default' | 'warning' | 'error' | 'success';
    compactTitle: string;
    compactDetail?: string | null;
    currentStepIndex: number;
    progress: { runId: string };
  } | null,
  runInstanceKey: 'team:run-1:2026-04-13T10:00:00.000Z',
  launchError: null as string | null,
};

vi.mock('@renderer/components/team/useTeamProvisioningPresentation', () => ({
  useTeamProvisioningPresentation: () => hookState,
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/team/StepProgressBar', () => ({
  StepProgressBar: (props: { active?: boolean }) => {
    hoisted.stepperProps.push(props);
    return React.createElement(
      'div',
      {
        'data-testid': 'stepper',
        'data-stepper-active': props.active ? 'true' : 'false',
      },
      'stepper'
    );
  },
}));

vi.mock('@renderer/components/team/TeamProvisioningPanel', () => ({
  TeamProvisioningPanel: ({ defaultLogsOpen }: { defaultLogsOpen?: boolean }) =>
    React.createElement(
      'div',
      { 'data-testid': 'panel', 'data-default-logs-open': defaultLogsOpen ? 'true' : 'false' },
      hookState.launchError ?? 'provisioning-panel'
    ),
}));

describe('GraphProvisioningHud', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    hookState.presentation = null;
    hookState.launchError = null;
    hookState.runInstanceKey = 'team:run-1:2026-04-13T10:00:00.000Z';
    hoisted.stepperProps = [];
  });

  it.each([true, false])(
    'shows an early launch error only on an enabled graph (enabled=%s)',
    async (enabled) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      hookState.launchError = 'Worktree branch mismatch';
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(
          React.createElement(GraphProvisioningHud, { teamName: 'northstar-core', enabled })
        );
      });
      expect(host.textContent).toBe(enabled ? hookState.launchError : '');
      expect(host.querySelector('[data-testid="stepper"]')).toBeNull();
      await act(async () => root.unmount());
    }
  );

  it('hides the graph launch hud once provisioning is ready', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hookState.presentation = {
      isActive: false,
      isFailed: false,
      hasMembersStillJoining: false,
      failedSpawnCount: 0,
      compactTone: 'success',
      compactTitle: 'Team launched',
      compactDetail: 'All 3 teammates joined',
      currentStepIndex: 4,
      progress: { runId: 'run-1' },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphProvisioningHud, {
          teamName: 'northstar-core',
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toBe('');
    expect(host.querySelector('[data-testid="stepper"]')).toBeNull();
    expect(document.body.textContent).not.toContain('provisioning-panel');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens launch details in a separate dialog when the stepper is clicked', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hookState.presentation = {
      isActive: true,
      isFailed: false,
      hasMembersStillJoining: true,
      failedSpawnCount: 0,
      compactTone: 'default',
      compactTitle: 'Launching team',
      compactDetail: '1 teammate still joining',
      currentStepIndex: 2,
      progress: { runId: 'run-3' },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphProvisioningHud, {
          teamName: 'northstar-core',
        })
      );
      await Promise.resolve();
    });

    const openButton = host.querySelector('button[aria-label]');
    expect(openButton).not.toBeNull();
    expect(host.querySelector('[data-testid="stepper"]')?.getAttribute('data-stepper-active')).toBe(
      'true'
    );

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('provisioning-panel');
    expect(
      document.body.querySelector('[data-testid="panel"]')?.getAttribute('data-default-logs-open')
    ).toBe('true');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders the failed graph hud without active stepper animation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hookState.presentation = {
      isActive: false,
      isFailed: true,
      hasMembersStillJoining: false,
      failedSpawnCount: 1,
      compactTone: 'error',
      compactTitle: 'Launch failed',
      compactDetail: 'alice failed to start',
      currentStepIndex: 2,
      progress: { runId: 'run-4' },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphProvisioningHud, {
          teamName: 'northstar-core',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="stepper"]')?.getAttribute('data-stepper-active')).toBe(
      'false'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not render or animate when disabled for an inactive graph tab', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hookState.presentation = {
      isActive: true,
      isFailed: false,
      hasMembersStillJoining: false,
      failedSpawnCount: 0,
      compactTone: 'default',
      compactTitle: 'Launching team',
      compactDetail: 'Waiting for members',
      currentStepIndex: 1,
      progress: { runId: 'run-2' },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphProvisioningHud, {
          teamName: 'northstar-core',
          enabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
