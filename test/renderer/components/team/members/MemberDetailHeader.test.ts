import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberDetailHeader } from '@renderer/components/team/members/MemberDetailHeader';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({
    children,
    variant: _variant,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & {
    children: React.ReactNode;
    variant?: string;
  }) => React.createElement('span', props, children),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/team/members/MemberRoleEditor', () => ({
  MemberRoleEditor: () => null,
}));

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

  it('exposes the lead runtime edit action', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onEditMember = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(MemberDetailHeader, {
          member: {
            ...member,
            name: 'lead',
            agentType: 'team-lead',
            role: 'Team Lead',
          },
          onEditMember,
        })
      );
      await Promise.resolve();
    });

    const editButton = host.querySelector<HTMLButtonElement>('button');
    expect(editButton).not.toBeNull();
    act(() => editButton?.click());
    expect(onEditMember).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
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

  it('shows waiting for bootstrap while the runtime is online but bootstrap is still pending', async () => {
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

    expect(host.textContent).toContain('waiting for bootstrap');
    expect(host.textContent).not.toContain('online');
    expect(host.querySelector('[aria-label="waiting for bootstrap"]')).not.toBeNull();

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
    expect(host.textContent).toContain('Gemini cli backend error: capacity exceeded.');
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.textContent).not.toContain('idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
