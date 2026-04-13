import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hookState = {
  presentation: null as
    | {
        isActive: boolean;
        isFailed: boolean;
        hasMembersStillJoining: boolean;
        failedSpawnCount: number;
        compactTone: 'default' | 'warning' | 'error' | 'success';
        compactTitle: string;
        compactDetail?: string | null;
        currentStepIndex: number;
        progress: { runId: string };
      }
    | null,
  runInstanceKey: 'team:run-1:2026-04-13T10:00:00.000Z',
};

vi.mock('@renderer/components/team/useTeamProvisioningPresentation', () => ({
  useTeamProvisioningPresentation: () => hookState,
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/team/StepProgressBar', () => ({
  StepProgressBar: () => React.createElement('div', { 'data-testid': 'stepper' }, 'stepper'),
}));

vi.mock('@renderer/components/team/TeamProvisioningPanel', () => ({
  TeamProvisioningPanel: ({
    defaultLogsOpen,
  }: {
    defaultLogsOpen?: boolean;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'panel', 'data-default-logs-open': defaultLogsOpen ? 'true' : 'false' },
      'provisioning-panel'
    ),
}));

import { GraphProvisioningHud } from '@renderer/features/agent-graph/ui/GraphProvisioningHud';

const placement = { x: 120, y: 80, scale: 1, visible: true };

describe('GraphProvisioningHud', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    hookState.presentation = null;
    hookState.runInstanceKey = 'team:run-1:2026-04-13T10:00:00.000Z';
  });

  it('keeps successful ready launch summary visible until dismissed', async () => {
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
          leadNodeId: 'lead:northstar-core',
          getLaunchAnchorScreenPlacement: () => placement,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Team launched');
    expect(host.textContent).toContain('All 3 teammates joined');
    expect(host.querySelector('[data-testid="stepper"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('provisioning-panel');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens launch details in a separate dialog when the stepper is clicked', async () => {
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
      progress: { runId: 'run-3' },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphProvisioningHud, {
          teamName: 'northstar-core',
          leadNodeId: 'lead:northstar-core',
          getLaunchAnchorScreenPlacement: () => placement,
        })
      );
      await Promise.resolve();
    });

    const openButton = host.querySelector('button[aria-label="Open full launch details"]');
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('provisioning-panel');
    expect(document.body.querySelector('[data-testid="panel"]')?.getAttribute('data-default-logs-open')).toBe(
      'true'
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
          leadNodeId: 'lead:northstar-core',
          getLaunchAnchorScreenPlacement: () => placement,
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
