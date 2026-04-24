import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemberSpawnStatusEntry, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({
    children,
    className,
    title,
  }: {
    children: React.ReactNode;
    className?: string;
    title?: string;
  }) => React.createElement('span', { className, title }, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/components/team/members/CurrentTaskIndicator', () => ({
  CurrentTaskIndicator: () => null,
}));

import { MemberCard } from '@renderer/components/team/members/MemberCard';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'reviewer',
  role: 'Reviewer',
  providerId: 'gemini',
  removedAt: undefined,
};

const currentTask: TeamTaskWithKanban = {
  id: 'task-1',
  displayId: 'abc12345',
  subject: 'Build calculator UI',
  status: 'in_progress',
} as unknown as TeamTaskWithKanban;

const failedSpawnEntry: MemberSpawnStatusEntry = {
  status: 'error',
  launchState: 'failed_to_start',
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: true,
  hardFailureReason: 'spawn failed',
  agentToolAccepted: false,
  livenessKind: 'not_found',
  runtimeDiagnostic: 'spawn failed',
  runtimeDiagnosticSeverity: 'error',
  updatedAt: '2026-04-24T12:00:00.000Z',
};

const skippedSpawnEntry: MemberSpawnStatusEntry = {
  status: 'skipped',
  launchState: 'skipped_for_launch',
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  agentToolAccepted: false,
  skippedForLaunch: true,
  skipReason: 'Skipped by user after launch failure: spawn failed',
  skippedAt: '2026-04-24T12:01:00.000Z',
  updatedAt: '2026-04-24T12:01:00.000Z',
};

describe('MemberCard starting-state visuals', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows runtime summary while keeping the starting treatment after provisioning stops', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeSummary: 'Anthropic · haiku · Medium',
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
    expect(host.textContent).toContain('Anthropic · haiku · Medium');
    expect(host.querySelector('.member-waiting-shimmer')).not.toBeNull();
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBe(0);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows provider retry advisory instead of plain online while bootstrap contact is still pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member: {
            ...member,
            runtimeAdvisory: {
              kind: 'sdk_retrying',
              observedAt: '2026-04-07T09:00:00.000Z',
              retryUntil: '2099-04-07T09:00:45.000Z',
              retryDelayMs: 45_000,
              reasonCode: 'quota_exhausted',
            },
          },
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'online',
          spawnLaunchState: 'runtime_pending_bootstrap',
          spawnRuntimeAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Gemini quota retry');
    expect(host.textContent).not.toContain('online');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows a full loading badge for connecting teammates during provisioning', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: false,
          isTeamProvisioning: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('connecting');
    expect(host.querySelector('[aria-label="connecting"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps runtime retry visible even while the teammate already has an active task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member: {
            ...member,
            currentTaskId: currentTask.id,
            runtimeAdvisory: {
              kind: 'sdk_retrying',
              observedAt: '2026-04-07T09:00:00.000Z',
              retryUntil: '2099-04-07T09:00:45.000Z',
              retryDelayMs: 45_000,
              reasonCode: 'quota_exhausted',
              message: 'Gemini cli backend error: capacity exceeded.',
            },
          },
          memberColor: 'blue',
          currentTask,
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

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps runtime-pending accessibility copy honest even when launch badge is hidden by an active task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member: {
            ...member,
            currentTaskId: currentTask.id,
          },
          memberColor: 'blue',
          currentTask,
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

    expect(host.textContent).not.toContain('online');
    expect(host.querySelector('[aria-label="waiting for bootstrap"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the starting treatment and runtime summary visible while a runtime is still joining', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeSummary: 'Anthropic · sonnet · Medium',
          isTeamAlive: true,
          isTeamProvisioning: false,
          isLaunchSettling: true,
          spawnStatus: 'online',
          spawnLaunchState: 'runtime_pending_bootstrap',
          spawnRuntimeAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('starting');
    expect(host.textContent).toContain('Anthropic · sonnet · Medium');
    expect(host.textContent).not.toContain('online');
    expect(host.querySelector('.member-waiting-shimmer')).not.toBeNull();
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBe(0);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows an awaiting permission badge for teammates blocked on runtime permissions', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'online',
          spawnLaunchState: 'runtime_pending_permission',
          spawnRuntimeAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('awaiting permission');
    expect(host.querySelector('[aria-label="awaiting permission"]')).not.toBeNull();
    expect(host.querySelector('.member-waiting-shimmer')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows a waiting-for-bootstrap badge while runtime bootstrap is still pending after the process comes online', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeSummary: 'Gemini · flash · Medium',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'online',
          spawnLaunchState: 'runtime_pending_bootstrap',
          spawnRuntimeAlive: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('waiting for bootstrap');
    expect(host.textContent).not.toContain('ready');
    expect(host.querySelector('[aria-label="waiting for bootstrap"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows ready instead of idle for confirmed teammates while launch is still settling', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeSummary: 'Anthropic · sonnet · Medium',
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

  it('shows member color on the avatar ring instead of a colored card rail', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
        })
      );
      await Promise.resolve();
    });

    const img = host.querySelector('img');
    const avatarRing = img?.parentElement;
    const clickableCard = host.querySelector('[role="button"]') as HTMLElement | null;

    expect(avatarRing).not.toBeNull();
    expect(avatarRing?.style.borderColor).toBe('#3b82f6');
    expect(clickableCard?.style.borderLeft).toBe('');
    expect(clickableCard?.style.background).toBe('');
    expect(clickableCard?.className).not.toContain('px-');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders memory after the role label in the compact runtime summary row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeSummary: '5.2 · Medium · 238.3 MB',
          isTeamAlive: true,
          isTeamProvisioning: false,
        })
      );
      await Promise.resolve();
    });

    const text = host.textContent ?? '';
    expect(text).toContain('5.2 · Medium');
    expect(text).toContain('Reviewer');
    expect(text).toContain('238.3 MB');
    expect(text.indexOf('Reviewer')).toBeLessThan(text.indexOf('238.3 MB'));

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('labels shared OpenCode host memory instead of member-owned runtime memory', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeSummary: 'minimax · via OpenCode · 183.9 MB',
          runtimeEntry: {
            memberName: 'alice',
            alive: true,
            restartable: false,
            providerId: 'opencode',
            pid: 333,
            pidSource: 'opencode_bridge',
            rssBytes: 183.9 * 1024 * 1024,
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          isTeamAlive: true,
          isTeamProvisioning: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[title="RSS source: shared OpenCode host"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('copies bounded launch diagnostics only for launch errors', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeRunId: 'run-42',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'waiting',
          spawnLaunchState: 'runtime_pending_bootstrap',
          spawnRuntimeAlive: false,
          spawnEntry: {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
            livenessKind: 'shell_only',
            runtimeDiagnostic: 'tmux pane foreground command is zsh',
            runtimeDiagnosticSeverity: 'warning',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          runtimeEntry: {
            memberName: 'alice',
            alive: false,
            restartable: true,
            pid: 26676,
            pidSource: 'tmux_pane',
            paneCurrentCommand: 'zsh',
            processCommand: 'node runtime --token super-secret',
            updatedAt: '2026-04-24T12:00:01.000Z',
          },
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Copy diagnostics"]')).toBeNull();

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          runtimeRunId: 'run-42',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: {
            status: 'error',
            launchState: 'failed_to_start',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'spawn failed',
            agentToolAccepted: false,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'spawn failed',
            runtimeDiagnosticSeverity: 'error',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          runtimeEntry: {
            memberName: 'alice',
            alive: false,
            restartable: true,
            pid: 26676,
            pidSource: 'tmux_pane',
            paneCurrentCommand: 'zsh',
            processCommand: 'node runtime --token super-secret',
            updatedAt: '2026-04-24T12:00:01.000Z',
          },
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[aria-label="Copy diagnostics"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeText.mock.calls[0][0] as string) as {
      runId?: string;
      livenessKind?: string;
      processCommand?: string;
    };
    expect(payload.runId).toBe('run-42');
    expect(payload.livenessKind).toBe('not_found');
    expect(payload.processCommand).toContain('--token [redacted]');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders retry for failed teammate launches', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: failedSpawnEntry,
          onRestartMember: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Retry teammate"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders skip for failed teammate launches', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: failedSpawnEntry,
          onSkipMemberForLaunch: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Skip for this launch"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('retries failed teammate launches without opening the member row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClick = vi.fn();
    let resolveRetry!: () => void;
    const retryPromise = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const onRestartMember = vi.fn(() => retryPromise);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: failedSpawnEntry,
          onClick,
          onRestartMember,
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[aria-label="Retry teammate"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(onRestartMember).toHaveBeenCalledWith('alice');
    expect(onClick).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Retrying teammate"]')).not.toBeNull();

    await act(async () => {
      resolveRetry();
      await retryPromise;
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Retry teammate"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('skips failed teammate launches without opening the member row', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClick = vi.fn();
    let resolveSkip!: () => void;
    const skipPromise = new Promise<void>((resolve) => {
      resolveSkip = resolve;
    });
    const onSkipMemberForLaunch = vi.fn(() => skipPromise);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: failedSpawnEntry,
          onClick,
          onSkipMemberForLaunch,
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[aria-label="Skip for this launch"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(onSkipMemberForLaunch).toHaveBeenCalledWith('alice');
    expect(onClick).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Skipping teammate"]')).not.toBeNull();

    await act(async () => {
      resolveSkip();
      await skipPromise;
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Skip for this launch"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps retry available and exposes retry errors after rejection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRestartMember = vi.fn(async () => {
      throw new Error('restart failed');
    });

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: failedSpawnEntry,
          onRestartMember,
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[aria-label="Retry teammate"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRestartMember).toHaveBeenCalledWith('alice');
    expect(host.querySelector('[aria-label="Retry teammate"]')).not.toBeNull();
    expect(host.textContent).toContain('restart failed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps skip available and exposes skip errors after rejection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSkipMemberForLaunch = vi.fn(async () => {
      throw new Error('skip failed');
    });

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'error',
          spawnLaunchState: 'failed_to_start',
          spawnRuntimeAlive: false,
          spawnError: 'spawn failed',
          spawnEntry: failedSpawnEntry,
          onSkipMemberForLaunch,
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[aria-label="Skip for this launch"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSkipMemberForLaunch).toHaveBeenCalledWith('alice');
    expect(host.querySelector('[aria-label="Skip for this launch"]')).not.toBeNull();
    expect(host.textContent).toContain('skip failed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows skipped teammates as skipped and keeps retry available', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberCard, {
          member,
          memberColor: 'blue',
          isTeamAlive: true,
          isTeamProvisioning: false,
          spawnStatus: 'skipped',
          spawnLaunchState: 'skipped_for_launch',
          spawnRuntimeAlive: false,
          spawnEntry: skippedSpawnEntry,
          onRestartMember: vi.fn(),
          onSkipMemberForLaunch: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('skipped');
    expect(host.textContent).toContain('Skipped by user after launch failure');
    expect(host.querySelector('[aria-label="Retry teammate"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Skip for this launch"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
