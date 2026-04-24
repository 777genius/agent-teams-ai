import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

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

const storeState = {
  selectedTeamData: {
    members: [member],
    isAlive: true,
    tasks: [],
  },
  selectedTeamName: 'northstar-core',
  progress: null as Record<string, unknown> | null,
  memberSpawnStatusesByTeam: {
    'northstar-core': {
      alice: {
        status: 'spawning',
        launchState: 'starting',
        updatedAt: '2026-04-09T10:00:00.000Z',
        runtimeAlive: false,
      },
    },
  } as Record<
    string,
    Record<
      string,
      {
        status: string;
        launchState: string;
        updatedAt: string;
        runtimeAlive: boolean;
        livenessSource?: string;
        livenessKind?: string;
        runtimeDiagnostic?: string;
        runtimeDiagnosticSeverity?: string;
        error?: string;
        hardFailure?: boolean;
        hardFailureReason?: string;
      }
    >
  >,
  memberSpawnSnapshotsByTeam: {
    'northstar-core': undefined,
  } as Record<string, unknown>,
  leadActivityByTeam: {},
  teamAgentRuntimeByTeam: {} as Record<
    string,
    {
      runId: string | null;
      members: Record<string, Record<string, unknown>>;
    }
  >,
  openMemberProfile: vi.fn(),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  getCurrentProvisioningProgressForTeam: () => storeState.progress,
  selectResolvedMemberForTeamName: (
    state: typeof storeState,
    teamName: string,
    memberName: string
  ) =>
    (state.selectedTeamName === teamName ? state.selectedTeamData : null)?.members.find(
      (candidate) => candidate.name === memberName
    ) ?? null,
  selectTeamMemberSnapshotsForName: (state: typeof storeState, teamName: string) =>
    (state.selectedTeamName === teamName ? state.selectedTeamData : null)?.members ?? [],
  selectTeamTasksForName: (state: typeof storeState, teamName: string) =>
    (state.selectedTeamName === teamName ? state.selectedTeamData : null)?.tasks ?? [],
  selectTeamIsAliveForName: (state: typeof storeState, teamName: string) =>
    (state.selectedTeamName === teamName ? state.selectedTeamData : null)?.isAlive,
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  HoverCardContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/team/members/CurrentTaskIndicator', () => ({
  CurrentTaskIndicator: () => null,
}));

import { MemberHoverCard } from '@renderer/components/team/members/MemberHoverCard';

describe('MemberHoverCard spawn-aware presence', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    storeState.selectedTeamData.members = [member];
    storeState.selectedTeamData.isAlive = true;
    storeState.selectedTeamData.tasks = [];
    storeState.selectedTeamName = 'northstar-core';
    storeState.progress = null;
    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'spawning',
      launchState: 'starting',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: false,
    };
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = undefined;
    storeState.teamAgentRuntimeByTeam = {};
    storeState.openMemberProfile.mockReset();
  });

  it('shows starting from the team spawn snapshot even when provisioning is no longer active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
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

  it('shows starting for runtime-pending members while launch is still settling', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.progress = {
      runId: 'run-1',
      teamName: 'northstar-core',
      state: 'ready',
      startedAt: '2026-04-09T10:00:00.000Z',
      pid: 4321,
      configReady: true,
    };
    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: true,
      livenessSource: 'process',
    };
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = {
      runId: 'run-1',
      expectedMembers: ['alice'],
      statuses: {},
      summary: {
        confirmedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 1,
      },
      source: 'merged',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('starting');
    expect(host.textContent).not.toContain('online');
    expect(host.querySelector('[aria-label="starting"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows waiting for bootstrap while runtime is online but bootstrap is still pending outside launch settling', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.progress = null;
    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: true,
      livenessSource: 'process',
    };
    storeState.memberSpawnSnapshotsByTeam['northstar-core'] = undefined;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
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

  it('surfaces runtime retry state in the hover card after the teammate has already joined', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.selectedTeamData.members = [
      {
        ...member,
        runtimeAdvisory: {
          kind: 'sdk_retrying',
          observedAt: '2026-04-09T10:00:00.000Z',
          retryUntil: '2099-04-09T10:00:45.000Z',
          retryDelayMs: 45_000,
          reasonCode: 'quota_exhausted',
          message: 'Gemini cli backend error: capacity exceeded.',
        },
      },
    ];
    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'online',
      launchState: 'confirmed_alive',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
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

  it('copies launch diagnostics with the active runtime run id only for launch errors', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: false,
      livenessKind: 'shell_only',
      runtimeDiagnostic: 'tmux pane foreground command is zsh',
      runtimeDiagnosticSeverity: 'warning',
    };
    storeState.teamAgentRuntimeByTeam['northstar-core'] = {
      runId: 'runtime-run-1',
      members: {
        alice: {
          memberName: 'alice',
          alive: false,
          restartable: true,
          livenessKind: 'shell_only',
          pidSource: 'tmux_pane',
          paneCurrentCommand: 'zsh',
          processCommand: 'node runtime --token secret',
          updatedAt: '2026-04-09T10:00:01.000Z',
        },
      },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Copy diagnostics"]')).toBeNull();

    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'error',
      launchState: 'failed_to_start',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: false,
      livenessKind: 'not_found',
      runtimeDiagnostic: 'spawn failed',
      runtimeDiagnosticSeverity: 'error',
      error: 'spawn failed',
      hardFailure: true,
      hardFailureReason: 'spawn failed',
    };

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
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

    const payload = JSON.parse(writeText.mock.calls[0][0] as string) as {
      runId?: string;
      processCommand?: string;
    };
    expect(payload.runId).toBe('runtime-run-1');
    expect(payload.processCommand).toContain('--token [redacted]');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
