import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/team/members/MemberRoleEditor', () => ({
  MemberRoleEditor: () => null,
}));

import { MemberDetailHeader } from '@renderer/components/team/members/MemberDetailHeader';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  providerId: 'gemini',
  agentType: 'reviewer',
  role: 'Reviewer',
  removedAt: undefined,
};

describe('MemberDetailHeader spawn-aware presence', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows starting from spawn props even when coarse team state would read as idle', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailHeader, {
          member,
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'spawning',
          spawnLaunchState: 'starting',
          spawnRuntimeAlive: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('starting');
    expect(host.textContent).not.toContain('idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows ready instead of idle while launch is still settling after contact', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailHeader, {
          member,
          isTeamAlive: true,
          isTeamProvisioning: false,
          isLaunchSettling: true,
          spawnStatus: 'online',
          spawnLaunchState: 'confirmed_alive',
          spawnRuntimeAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('ready');
    expect(host.textContent).not.toContain('idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows connecting while the runtime is online but bootstrap is still pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailHeader, {
          member,
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'online',
          spawnLaunchState: 'runtime_pending_bootstrap',
          spawnRuntimeAlive: true,
          spawnLivenessSource: 'process',
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('connecting');
    expect(host.textContent).not.toContain('online');
    expect(host.querySelector('[aria-label="connecting"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows runtime retry text after the teammate has already joined', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberDetailHeader, {
          member: {
            ...member,
            runtimeAdvisory: {
              kind: 'sdk_retrying',
              observedAt: '2026-04-07T09:00:00.000Z',
              retryUntil: '2099-04-07T09:00:45.000Z',
              retryDelayMs: 45_000,
              reasonCode: 'quota_exhausted',
              message: 'Gemini cli backend error: capacity exceeded.',
            },
          },
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'online',
          spawnLaunchState: 'confirmed_alive',
          spawnRuntimeAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Gemini quota retry');
    expect(host.textContent).not.toContain('idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
