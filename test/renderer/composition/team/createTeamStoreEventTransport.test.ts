import { createTeamStoreEventTransport } from '@renderer/composition/team/createTeamStoreEventTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectBranchChangeEvent, TeamChangeEvent, ToolApprovalEvent } from '@shared/types';
import type { TeamsAPI } from '@shared/types/api';

const mocks = vi.hoisted(() => {
  const setChangePresenceTracking = vi.fn();
  const setTaskLogStreamTracking = vi.fn();
  const setToolActivityTracking = vi.fn();
  const onProjectBranchChange = vi.fn();
  const onTeamChange = vi.fn();
  const onToolApprovalEvent = vi.fn();

  const teams = {
    onProjectBranchChange,
    onTeamChange,
    onToolApprovalEvent,
    setChangePresenceTracking,
    setTaskLogStreamTracking,
    setToolActivityTracking,
  };

  return {
    installedTeams: teams as Partial<TeamsAPI> | undefined,
    onProjectBranchChange,
    onTeamChange,
    onToolApprovalEvent,
    setChangePresenceTracking,
    setTaskLogStreamTracking,
    setToolActivityTracking,
    teams,
    teamsReadCount: 0,
  };
});

vi.mock('@renderer/api', () => ({
  api: {
    get teams() {
      mocks.teamsReadCount += 1;
      return mocks.installedTeams;
    },
  },
}));

describe('createTeamStoreEventTransport', () => {
  beforeEach(() => {
    Object.assign(mocks.teams, {
      onProjectBranchChange: mocks.onProjectBranchChange,
      onTeamChange: mocks.onTeamChange,
      onToolApprovalEvent: mocks.onToolApprovalEvent,
      setChangePresenceTracking: mocks.setChangePresenceTracking,
      setTaskLogStreamTracking: mocks.setTaskLogStreamTracking,
      setToolActivityTracking: mocks.setToolActivityTracking,
    });
    mocks.installedTeams = mocks.teams;
    mocks.teamsReadCount = 0;
    vi.clearAllMocks();
  });

  it('defers acquisition and uses a team transport installed after creation', async () => {
    let lateTeams: Partial<TeamsAPI>;
    const lateTaskLogTracking = vi.fn(async function (
      this: Partial<TeamsAPI>,
      _teamName: string,
      _enabled: boolean
    ) {
      expect(this).toBe(lateTeams);
    });
    lateTeams = { ...mocks.teams, setTaskLogStreamTracking: lateTaskLogTracking };
    mocks.installedTeams = undefined;

    const transport = createTeamStoreEventTransport();

    expect(mocks.teamsReadCount).toBe(0);
    mocks.installedTeams = lateTeams;

    await transport.trackTaskLogs?.('sandbox-team', true);

    expect(mocks.teamsReadCount).toBe(1);
    expect(lateTaskLogTracking).toHaveBeenCalledWith('sandbox-team', true);
  });

  it('resolves every captured operation against the current transport and its cleanup', async () => {
    const projectBranchChange: ProjectBranchChangeEvent = {
      branch: 'feature/current-transport',
      projectPath: '/sandbox/current',
    };
    const teamChange: TeamChangeEvent = { type: 'task', teamName: 'sandbox-team' };
    const toolApproval: ToolApprovalEvent = {
      receivedAt: '2026-09-14T12:00:00.000Z',
      requestId: 'approval-current',
      runId: 'run-current',
      source: 'lead',
      teamName: 'sandbox-team',
      toolInput: { command: 'pwd' },
      toolName: 'Bash',
    };
    const cleanupProjectBranchChange = vi.fn();
    const cleanupTeamChange = vi.fn();
    const cleanupToolApproval = vi.fn();
    const currentTeams = {
      onProjectBranchChange: vi.fn(function (
        this: unknown,
        listener: (event: unknown, data: ProjectBranchChangeEvent) => void
      ) {
        expect(this).toBe(currentTeams);
        listener({ sender: 'current' }, projectBranchChange);
        return cleanupProjectBranchChange;
      }),
      onTeamChange: vi.fn(function (
        this: unknown,
        listener: (event: unknown, data: TeamChangeEvent) => void
      ) {
        expect(this).toBe(currentTeams);
        listener({ sender: 'current' }, teamChange);
        return cleanupTeamChange;
      }),
      onToolApprovalEvent: vi.fn(function (
        this: unknown,
        listener: (event: unknown, data: ToolApprovalEvent) => void
      ) {
        expect(this).toBe(currentTeams);
        listener({ sender: 'current' }, toolApproval);
        return cleanupToolApproval;
      }),
      setChangePresenceTracking: vi.fn(async function (this: unknown) {
        expect(this).toBe(currentTeams);
      }),
      setTaskLogStreamTracking: vi.fn(async function (this: unknown) {
        expect(this).toBe(currentTeams);
      }),
      setToolActivityTracking: vi.fn(async function (this: unknown) {
        expect(this).toBe(currentTeams);
      }),
    };
    const transport = createTeamStoreEventTransport();
    const trackChangePresence = transport.trackChangePresence;
    const trackTaskLogs = transport.trackTaskLogs;
    const trackToolActivity = transport.trackToolActivity;
    const subscribeToProjectBranchChanges = transport.subscribeToProjectBranchChanges;
    const subscribeToTeamChanges = transport.subscribeToTeamChanges;
    const subscribeToToolApprovalEvents = transport.subscribeToToolApprovalEvents;

    expect(mocks.teamsReadCount).toBe(0);
    mocks.installedTeams = currentTeams;

    await trackChangePresence?.('sandbox-team', true);
    await trackTaskLogs?.('sandbox-team', false);
    await trackToolActivity?.('sandbox-team', true);
    const projectListener = vi.fn();
    const teamListener = vi.fn();
    const approvalListener = vi.fn();
    const cleanupProject = subscribeToProjectBranchChanges?.(projectListener);
    const cleanupTeam = subscribeToTeamChanges?.(teamListener);
    const cleanupApproval = subscribeToToolApprovalEvents?.(approvalListener);

    expect(currentTeams.setChangePresenceTracking).toHaveBeenCalledWith('sandbox-team', true);
    expect(currentTeams.setTaskLogStreamTracking).toHaveBeenCalledWith('sandbox-team', false);
    expect(currentTeams.setToolActivityTracking).toHaveBeenCalledWith('sandbox-team', true);
    expect(projectListener).toHaveBeenCalledWith(projectBranchChange);
    expect(teamListener).toHaveBeenCalledWith(teamChange);
    expect(approvalListener).toHaveBeenCalledWith(toolApproval);

    mocks.installedTeams = mocks.teams;
    cleanupProject?.();
    cleanupTeam?.();
    cleanupApproval?.();

    expect(cleanupProjectBranchChange).toHaveBeenCalledTimes(1);
    expect(cleanupTeamChange).toHaveBeenCalledTimes(1);
    expect(cleanupToolApproval).toHaveBeenCalledTimes(1);
    expect(mocks.teamsReadCount).toBe(6);
  });

  it('exposes only provider-neutral tracking and subscription capabilities', () => {
    const transport = createTeamStoreEventTransport();

    expect(Object.keys(transport).sort()).toEqual([
      'subscribeToProjectBranchChanges',
      'subscribeToTeamChanges',
      'subscribeToToolApprovalEvents',
      'trackChangePresence',
      'trackTaskLogs',
      'trackToolActivity',
    ]);
    expect(Object.keys(transport).join(' ')).not.toMatch(
      /lifecycle|process|provider|runtime|OpenCode|opencode/
    );
  });

  it('forwards tracking calls and preserves their rejected promises', async () => {
    const changePresenceFailure = new Error('change presence unavailable');
    const taskLogFailure = new Error('task logs unavailable');
    const toolActivityFailure = new Error('tool activity unavailable');
    mocks.setChangePresenceTracking.mockRejectedValueOnce(changePresenceFailure);
    mocks.setTaskLogStreamTracking.mockRejectedValueOnce(taskLogFailure);
    mocks.setToolActivityTracking.mockRejectedValueOnce(toolActivityFailure);
    const transport = createTeamStoreEventTransport();

    await expect(transport.trackChangePresence?.('sandbox-team', true)).rejects.toBe(
      changePresenceFailure
    );
    await expect(transport.trackTaskLogs?.('sandbox-team', false)).rejects.toBe(taskLogFailure);
    await expect(transport.trackToolActivity?.('sandbox-team', true)).rejects.toBe(
      toolActivityFailure
    );
    expect(mocks.setChangePresenceTracking).toHaveBeenCalledWith('sandbox-team', true);
    expect(mocks.setTaskLogStreamTracking).toHaveBeenCalledWith('sandbox-team', false);
    expect(mocks.setToolActivityTracking).toHaveBeenCalledWith('sandbox-team', true);
  });

  it('projects subscription payloads without transport metadata and returns exact cleanup', () => {
    const emitters: {
      projectBranchChange: ((event: unknown, data: ProjectBranchChangeEvent) => void) | null;
      teamChange: ((event: unknown, data: TeamChangeEvent) => void) | null;
      toolApproval: ((event: unknown, data: ToolApprovalEvent) => void) | null;
    } = {
      projectBranchChange: null,
      teamChange: null,
      toolApproval: null,
    };
    const unsubscribeTeamChange = vi.fn();
    const unsubscribeProjectBranchChange = vi.fn();
    const unsubscribeToolApproval = vi.fn();
    mocks.onTeamChange.mockImplementationOnce((listener) => {
      emitters.teamChange = listener;
      return unsubscribeTeamChange;
    });
    mocks.onProjectBranchChange.mockImplementationOnce((listener) => {
      emitters.projectBranchChange = listener;
      return unsubscribeProjectBranchChange;
    });
    mocks.onToolApprovalEvent.mockImplementationOnce((listener) => {
      emitters.toolApproval = listener;
      return unsubscribeToolApproval;
    });
    const transport = createTeamStoreEventTransport();
    const teamChangeListener = vi.fn();
    const projectBranchListener = vi.fn();
    const toolApprovalListener = vi.fn();

    const cleanupTeamChange = transport.subscribeToTeamChanges?.(teamChangeListener);
    const cleanupProjectBranch = transport.subscribeToProjectBranchChanges?.(projectBranchListener);
    const cleanupToolApproval = transport.subscribeToToolApprovalEvents?.(toolApprovalListener);
    const teamChange: TeamChangeEvent = { type: 'task', teamName: 'sandbox-team' };
    const projectBranchChange: ProjectBranchChangeEvent = {
      branch: 'feature/provider-neutral',
      projectPath: '/sandbox/project',
    };
    const toolApproval: ToolApprovalEvent = {
      receivedAt: '2026-07-30T22:00:00.000Z',
      requestId: 'approval-1',
      runId: 'run-1',
      source: 'lead',
      teamName: 'sandbox-team',
      toolInput: { command: 'pwd' },
      toolName: 'Bash',
    };

    emitters.teamChange?.({ sender: 'desktop' }, teamChange);
    emitters.projectBranchChange?.({ sender: 'hosted-web' }, projectBranchChange);
    emitters.toolApproval?.({ sender: 'desktop' }, toolApproval);

    expect(teamChangeListener).toHaveBeenCalledWith(teamChange);
    expect(projectBranchListener).toHaveBeenCalledWith(projectBranchChange);
    expect(toolApprovalListener).toHaveBeenCalledWith(toolApproval);

    cleanupTeamChange?.();
    cleanupProjectBranch?.();
    cleanupToolApproval?.();
    expect(unsubscribeTeamChange).toHaveBeenCalledTimes(1);
    expect(unsubscribeProjectBranchChange).toHaveBeenCalledTimes(1);
    expect(unsubscribeToolApproval).toHaveBeenCalledTimes(1);
  });

  it('treats every unavailable optional capability as a no-op at invocation time', async () => {
    for (const capability of [
      'onProjectBranchChange',
      'onTeamChange',
      'onToolApprovalEvent',
      'setChangePresenceTracking',
      'setTaskLogStreamTracking',
      'setToolActivityTracking',
    ] as const) {
      Reflect.deleteProperty(mocks.teams, capability);
    }

    const transport = createTeamStoreEventTransport();
    await expect(transport.trackChangePresence?.('sandbox-team', true)).resolves.toBeUndefined();
    await expect(transport.trackTaskLogs?.('sandbox-team', true)).resolves.toBeUndefined();
    await expect(transport.trackToolActivity?.('sandbox-team', true)).resolves.toBeUndefined();
    expect(transport.subscribeToProjectBranchChanges?.(vi.fn())).toEqual(expect.any(Function));
    expect(transport.subscribeToTeamChanges?.(vi.fn())).toEqual(expect.any(Function));
    expect(transport.subscribeToToolApprovalEvents?.(vi.fn())).toEqual(expect.any(Function));
  });
});
