import { createTeamStoreEventTransport } from '@renderer/composition/team/createTeamStoreEventTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectBranchChangeEvent, TeamChangeEvent, ToolApprovalEvent } from '@shared/types';

const mocks = vi.hoisted(() => {
  const setChangePresenceTracking = vi.fn();
  const setTaskLogStreamTracking = vi.fn();
  const setToolActivityTracking = vi.fn();
  const onProjectBranchChange = vi.fn();
  const onTeamChange = vi.fn();
  const onToolApprovalEvent = vi.fn();

  return {
    onProjectBranchChange,
    onTeamChange,
    onToolApprovalEvent,
    setChangePresenceTracking,
    setTaskLogStreamTracking,
    setToolActivityTracking,
    teams: {
      onProjectBranchChange,
      onTeamChange,
      onToolApprovalEvent,
      setChangePresenceTracking,
      setTaskLogStreamTracking,
      setToolActivityTracking,
    },
  };
});

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks.teams,
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
    vi.clearAllMocks();
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

  it('omits every unavailable optional capability', () => {
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

    expect(createTeamStoreEventTransport()).toEqual({});
  });
});
