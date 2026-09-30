import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedTeamLifecycleControls } from '../../../../src/features/team-lifecycle/renderer/ui/HostedTeamLifecycleControls';
import { parseBootId, parseDeploymentId, parseRevision, parseTeamId, parseWorkspaceId } from '../../../../src/shared/contracts/hosted';

describe('Hosted lifecycle promotion gate', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps Launch disabled until the UI has received Owner admission', async () => {
    const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
    const teamId = parseTeamId(`team_${'2'.repeat(32)}`);
    const state = {
      schemaVersion: 1 as const,
      kind: 'control_state' as const,
      workspaceId,
      teamId,
      deploymentId: parseDeploymentId('deployment_promotion-gate'),
      bootId: parseBootId('boot_promotion-gate'),
      runId: null,
      resourceRevision: parseRevision('revision_promotion-gate'),
      availableActions: ['launch'] as const,
    };
    const execute = vi.fn(async () => ({
      schemaVersion: 1 as const, kind: 'unavailable' as const, retryAfterMs: null,
    }));
    const transport = {
      getControlState: vi.fn(async () => state),
      execute,
      prepare: vi.fn(),
      getProgress: vi.fn(),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (promotionAdmitted: boolean) => {
      await act(async () => {
        root.render(<HostedTeamLifecycleControls
          workspaceId={workspaceId}
          teamId={teamId}
          transport={transport}
          promotionAdmitted={promotionAdmitted}
          healthPollIntervalMs={60_000}
        />);
      });
    };
    await render(false);
    const launch = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch'
    )!;
    expect(launch.disabled).toBe(true);
    await act(async () => launch.click());
    expect(execute).not.toHaveBeenCalled();
    await render(true);
    expect(launch.disabled).toBe(false);
    act(() => root.unmount());
  });
});
