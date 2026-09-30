import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDesktopCreateTaskInteraction,
  resetDesktopCreateTaskSessions,
} from './desktopCreateTaskSessions';

import type { CreateTaskRequest, TeamTask, TeamViewSnapshot } from '@shared/types';

const mocks = vi.hoisted(() => ({
  createTeamTask: vi.fn(),
  refreshTeamData: vi.fn(),
  notifyTaskLead: vi.fn(),
  listeners: new Set<() => void>(),
  state: {
    activeContextId: 'context-a',
    isContextSwitching: false,
    teamData: { isAlive: true, tasks: [] as TeamTask[] },
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: {
    getState: () => ({
      ...mocks.state,
      createTeamTask: mocks.createTeamTask,
      refreshTeamData: mocks.refreshTeamData,
      getTeamData: () => mocks.state.teamData,
    }),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: () => false,
  selectTeamDataForName: (state: { teamData: unknown }) => state.teamData,
}));
vi.mock('./createTeamTaskDetailTransport', () => ({
  createTeamTaskDetailTransport: () => ({ notifyTaskLead: mocks.notifyTaskLead }),
}));

const request: CreateTaskRequest = {
  subject: 'Task',
  owner: 'alice',
  prompt: 'Do the work.',
  startImmediately: true,
};

function switchContext(contextId: string): void {
  mocks.state.activeContextId = contextId;
  for (const listener of mocks.listeners) listener();
}

beforeEach(() => {
  mocks.state.activeContextId = 'context-a';
  mocks.state.isContextSwitching = false;
  mocks.state.teamData.tasks = [];
  mocks.createTeamTask.mockResolvedValue({ id: 'task-1' } as TeamTask);
  mocks.refreshTeamData.mockImplementation(
    async (
      _name: string,
      options?: {
        onFreshSnapshot?: (snapshot: TeamViewSnapshot) => void;
      }
    ) => {
      mocks.state.teamData.tasks = [{ id: 'task-1' } as TeamTask];
      options?.onFreshSnapshot?.(mocks.state.teamData as TeamViewSnapshot);
    }
  );
  mocks.notifyTaskLead.mockResolvedValue(undefined);
});

afterEach(() => {
  resetDesktopCreateTaskSessions();
  vi.clearAllMocks();
});

describe('Desktop create session composition', () => {
  it('retains one session across Detail/Graph and A-B-A while isolating scope B', () => {
    const detail = getDesktopCreateTaskInteraction('team', 'context-a');
    expect(getDesktopCreateTaskInteraction('team', 'context-a')).toBe(detail);
    switchContext('context-b');
    expect(getDesktopCreateTaskInteraction('team', 'context-b')).not.toBe(detail);
    switchContext('context-a');
    expect(getDesktopCreateTaskInteraction('team', 'context-a')).toBe(detail);
  });

  it('runs the best-effort notification once for each confirmed intent', async () => {
    const interaction = getDesktopCreateTaskInteraction('team', 'context-a');

    await interaction.submit(request);
    await Promise.resolve();
    expect(mocks.notifyTaskLead).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTaskLead).toHaveBeenCalledWith(
      'team',
      'New task assigned to alice: "Task". Instructions:\nDo the work.'
    );

    interaction.acknowledgeConfirmed();
    await interaction.submit(request);
    await Promise.resolve();
    expect(mocks.notifyTaskLead).toHaveBeenCalledTimes(2);
    expect(mocks.createTeamTask).toHaveBeenCalledTimes(2);
  });

  it('keeps the receipt confirmed when legacy refresh resolves without projecting the task', async () => {
    mocks.refreshTeamData.mockResolvedValueOnce(undefined);
    const interaction = getDesktopCreateTaskInteraction('team', 'context-a');

    const result = await interaction.submit(request);

    expect(result.phase).toBe('confirmed');
    expect(result.freshness).toBe('failed');
    expect(mocks.createTeamTask).toHaveBeenCalledTimes(1);
  });

  it('does not call a retained cached row fresh after the authoritative read fails', async () => {
    mocks.state.teamData.tasks = [{ id: 'task-1' } as TeamTask];
    mocks.refreshTeamData.mockRejectedValueOnce(new Error('transient read failure'));
    const interaction = getDesktopCreateTaskInteraction('team', 'context-a');

    const result = await interaction.submit(request);

    expect(result.phase).toBe('confirmed');
    expect(result.freshness).toBe('failed');
    expect(mocks.refreshTeamData).toHaveBeenCalledWith('team', {
      requireFreshRead: true,
      onFreshSnapshot: expect.any(Function),
    });
    expect(mocks.createTeamTask).toHaveBeenCalledTimes(1);
  });

  it('does not accept a watcher row absent from the successful authoritative snapshot', async () => {
    mocks.state.teamData.tasks = [{ id: 'task-1' } as TeamTask];
    mocks.refreshTeamData.mockImplementationOnce(
      async (
        _name: string,
        options?: {
          onFreshSnapshot?: (snapshot: TeamViewSnapshot) => void;
        }
      ) => {
        options?.onFreshSnapshot?.({ tasks: [] } as unknown as TeamViewSnapshot);
      }
    );
    const interaction = getDesktopCreateTaskInteraction('team', 'context-a');

    const result = await interaction.submit(request);

    expect(result.phase).toBe('confirmed');
    expect(result.freshness).toBe('failed');
    expect(mocks.createTeamTask).toHaveBeenCalledTimes(1);
  });

  it('holds a late receipt notification for its original context and never refreshes B', async () => {
    let resolveCreate: ((task: TeamTask) => void) | undefined;
    mocks.createTeamTask.mockImplementationOnce(
      () =>
        new Promise<TeamTask>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const interaction = getDesktopCreateTaskInteraction('team', 'context-a');
    const pending = interaction.submit(request);

    await Promise.resolve();
    switchContext('context-b');
    resolveCreate?.({ id: 'task-1' } as TeamTask);
    const result = await pending;

    expect(result.phase).toBe('confirmed');
    expect(result.freshness).toBe('failed');
    expect(mocks.refreshTeamData).not.toHaveBeenCalled();
    expect(mocks.notifyTaskLead).not.toHaveBeenCalled();

    switchContext('context-a');
    expect(mocks.notifyTaskLead).toHaveBeenCalledTimes(1);
    switchContext('context-b');
    switchContext('context-a');
    expect(mocks.notifyTaskLead).toHaveBeenCalledTimes(1);
  });
});
