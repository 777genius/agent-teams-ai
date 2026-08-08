import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTeamTaskBoardActions,
  type TeamTaskBoardActionDependencies,
} from '../../../../../src/features/team-task-board/core/application/createTeamTaskBoardActions';

import type {
  CreateTaskRequest,
  TeamTask,
  TeamViewSnapshot,
} from '../../../../../src/shared/types';

const createdTask = { id: 'task-1', subject: 'Task' } as TeamTask;
const teamData = { members: [], tasks: [] } as unknown as TeamViewSnapshot;

function createDependencies(): TeamTaskBoardActionDependencies {
  return {
    clock: { now: vi.fn(() => 100) },
    deletedTasks: {
      getDeletedTasks: vi.fn(() => Promise.resolve([createdTask])),
    },
    lifecycle: {
      recordCreatedTask: vi.fn(),
    },
    logger: {
      error: vi.fn(),
    },
    mutations: {
      addTaskRelationship: vi.fn(() => Promise.resolve()),
      createTask: vi.fn(() => Promise.resolve(createdTask)),
      removeTaskRelationship: vi.fn(() => Promise.resolve()),
      requestReview: vi.fn(() => Promise.resolve()),
      restoreTask: vi.fn(() => Promise.resolve()),
      setTaskNeedsClarification: vi.fn(() => Promise.resolve()),
      softDeleteTask: vi.fn(() => Promise.resolve()),
      startTask: vi.fn(() => Promise.resolve({ notifiedOwner: true })),
      startTaskByUser: vi.fn(() => Promise.resolve({ notifiedOwner: false })),
      updateKanban: vi.fn(() => Promise.resolve()),
      updateKanbanColumnOrder: vi.fn(() => Promise.resolve()),
      updateTaskFields: vi.fn(() => Promise.resolve()),
      updateTaskOwner: vi.fn(() => Promise.resolve()),
      updateTaskStatus: vi.fn(() => Promise.resolve()),
    },
    presence: {
      refreshAfterTaskTransition: vi.fn(() => Promise.resolve()),
    },
    refresh: {
      refreshAllTasks: vi.fn(() => Promise.resolve()),
      refreshTeamData: vi.fn(() => Promise.resolve()),
    },
    reviewErrors: {
      map: vi.fn(() => 'mapped review error'),
    },
    state: {
      getTeamData: vi.fn(() => teamData),
      setDeletedTasks: vi.fn(),
      setDeletedTasksLoading: vi.fn(),
      setReviewActionError: vi.fn(),
    },
  };
}

describe('createTeamTaskBoardActions', () => {
  let dependencies: TeamTaskBoardActionDependencies;

  beforeEach(() => {
    dependencies = createDependencies();
  });

  it('preserves review mutation, refresh, and best-effort presence ordering', async () => {
    const actions = createTeamTaskBoardActions(dependencies);

    await actions.requestReview('team-a', 'task-1');

    expect(dependencies.state.setReviewActionError).toHaveBeenNthCalledWith(1, null);
    expect(dependencies.mutations.requestReview).toHaveBeenCalledWith('team-a', 'task-1');
    expect(dependencies.refresh.refreshTeamData).toHaveBeenCalledWith('team-a');
    expect(dependencies.presence.refreshAfterTaskTransition).toHaveBeenCalledWith(
      'team-a',
      'task-1'
    );
    expect(
      vi.mocked(dependencies.mutations.requestReview).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(dependencies.presence.refreshAfterTaskTransition).mock.invocationCallOrder[0]
    );
  });

  it('maps review failures, preserves the original rejection, and skips refresh', async () => {
    const failure = new Error('verification failed');
    vi.mocked(dependencies.mutations.updateKanban).mockRejectedValueOnce(failure);
    const actions = createTeamTaskBoardActions(dependencies);

    await expect(actions.updateKanban('team-a', 'task-1', { op: 'request_changes' })).rejects.toBe(
      failure
    );

    expect(dependencies.reviewErrors.map).toHaveBeenCalledWith(failure);
    expect(dependencies.state.setReviewActionError).toHaveBeenNthCalledWith(1, null);
    expect(dependencies.state.setReviewActionError).toHaveBeenNthCalledWith(
      2,
      'mapped review error'
    );
    expect(dependencies.refresh.refreshTeamData).not.toHaveBeenCalled();
  });

  it('records task creation before refresh and returns only after refresh completes', async () => {
    const request: CreateTaskRequest = {
      subject: 'Task',
      owner: 'alice',
    };
    const actions = createTeamTaskBoardActions(dependencies);

    const result = await actions.createTeamTask('team-a', request);

    expect(result).toBe(createdTask);
    expect(dependencies.lifecycle.recordCreatedTask).toHaveBeenCalledWith(
      'team-a',
      createdTask,
      request,
      teamData,
      100
    );
    expect(vi.mocked(dependencies.mutations.createTask).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.lifecycle.recordCreatedTask).mock.invocationCallOrder[0]
    );
    expect(
      vi.mocked(dependencies.lifecycle.recordCreatedTask).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]);
  });

  it('keeps task start and status presence refreshes after the team refresh', async () => {
    const actions = createTeamTaskBoardActions(dependencies);

    await expect(actions.startTask('team-a', 'task-1')).resolves.toEqual({
      notifiedOwner: true,
    });
    await actions.updateTaskStatus('team-a', 'task-1', 'completed');

    expect(dependencies.presence.refreshAfterTaskTransition).toHaveBeenNthCalledWith(
      1,
      'team-a',
      'task-1'
    );
    expect(dependencies.presence.refreshAfterTaskTransition).toHaveBeenNthCalledWith(
      2,
      'team-a',
      'task-1'
    );
    expect(
      vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(dependencies.presence.refreshAfterTaskTransition).mock.invocationCallOrder[0]
    );
  });

  it('refreshes team data before global tasks after clarification changes', async () => {
    const actions = createTeamTaskBoardActions(dependencies);

    await actions.setTaskNeedsClarification('team-a', 'task-1', 'user');

    expect(
      vi.mocked(dependencies.mutations.setTaskNeedsClarification).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.refresh.refreshAllTasks).mock.invocationCallOrder[0]);
  });

  it('refreshes deleted task state after a soft delete', async () => {
    const actions = createTeamTaskBoardActions(dependencies);

    await actions.softDeleteTask('team-a', 'task-1');

    expect(dependencies.state.setDeletedTasksLoading).toHaveBeenCalledWith(true);
    expect(dependencies.deletedTasks.getDeletedTasks).toHaveBeenCalledWith('team-a');
    expect(dependencies.state.setDeletedTasks).toHaveBeenCalledWith([createdTask], false);
    expect(
      vi.mocked(dependencies.refresh.refreshTeamData).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(dependencies.deletedTasks.getDeletedTasks).mock.invocationCallOrder[0]
    );
  });

  it('turns deleted-task query failures into an empty non-loading state', async () => {
    const failure = new Error('query failed');
    vi.mocked(dependencies.deletedTasks.getDeletedTasks).mockRejectedValueOnce(failure);
    const actions = createTeamTaskBoardActions(dependencies);

    await expect(actions.fetchDeletedTasks('team-a')).resolves.toBeUndefined();

    expect(dependencies.logger.error).toHaveBeenCalledWith(
      'Failed to fetch deleted tasks:',
      failure
    );
    expect(dependencies.state.setDeletedTasks).toHaveBeenCalledWith([], false);
  });
});
