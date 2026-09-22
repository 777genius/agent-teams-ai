import { describe, expect, it, vi } from 'vitest';

import { TeamTaskMutationCoordinator } from './TeamTaskMutationCoordinator';

import type { TaskMutationBoardPort } from './ports/TeamTaskMutationCoordinatorPorts';

function createTaskBoard(overrides: Partial<TaskMutationBoardPort> = {}): TaskMutationBoardPort {
  return {
    getTask: vi.fn(() => null),
    getKanbanState: vi.fn(() => ({ tasks: {} })),
    setTaskStatus: vi.fn(),
    softDeleteTask: vi.fn(),
    restoreTask: vi.fn(),
    setTaskOwner: vi.fn(),
    updateTaskFields: vi.fn(),
    addTaskAttachmentMeta: vi.fn(),
    removeTaskAttachment: vi.fn(),
    setNeedsClarification: vi.fn(),
    linkTask: vi.fn(),
    unlinkTask: vi.fn(),
    addTaskComment: vi.fn(),
    requestReview: vi.fn(),
    clearKanban: vi.fn(),
    setKanbanColumn: vi.fn(),
    approveReview: vi.fn(),
    requestChanges: vi.fn(),
    updateColumnOrder: vi.fn(),
    ...overrides,
  };
}

function createCoordinator(taskBoard = createTaskBoard()) {
  const getTaskBoard = vi.fn(() => taskBoard);
  const invalidateGlobalTaskProjectionCache = vi.fn();
  const resolveLeadRuntimeContext = vi.fn(async () => ({
    leadName: 'team-lead',
    leadSessionId: 'lead-session-1',
  }));
  const createId = vi.fn(() => 'fallback-comment-id');
  const nowIso = vi.fn(() => '2026-07-30T12:00:00.000Z');
  const coordinator = new TeamTaskMutationCoordinator({
    taskBoards: { getTaskBoard },
    taskProjection: { invalidateGlobalTaskProjectionCache },
    leadContext: { resolveLeadRuntimeContext },
    identity: { createId },
    clock: { nowIso },
  });

  return {
    coordinator,
    createId,
    getTaskBoard,
    invalidateGlobalTaskProjectionCache,
    nowIso,
    resolveLeadRuntimeContext,
    taskBoard,
  };
}

describe('TeamTaskMutationCoordinator', () => {
  it('owns direct task mutation actors, relationship mapping, and cache invalidation', async () => {
    const { coordinator, getTaskBoard, invalidateGlobalTaskProjectionCache, taskBoard } =
      createCoordinator();
    const fields = { subject: 'Updated subject', description: 'Updated description' };
    const attachment = {
      id: 'attachment-1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: 12,
      addedAt: '2026-07-30T11:00:00.000Z',
    };

    await coordinator.updateTaskStatus('team-a', 'task-1', 'completed', 'alice');
    await coordinator.softDeleteTask('team-a', 'task-1');
    await coordinator.restoreTask('team-a', 'task-1');
    await coordinator.updateTaskOwner('team-a', 'task-1', 'bob');
    await coordinator.updateTaskFields('team-a', 'task-1', fields);
    await coordinator.addTaskAttachment('team-a', 'task-1', attachment);
    await coordinator.removeTaskAttachment('team-a', 'task-1', 'attachment-1');
    await coordinator.setTaskNeedsClarification('team-a', 'task-1', 'lead');
    await coordinator.addTaskRelationship('team-a', 'task-1', 'task-2', 'blockedBy');
    await coordinator.removeTaskRelationship('team-a', 'task-1', 'task-3', 'related');

    expect(taskBoard.setTaskStatus).toHaveBeenCalledWith('task-1', 'completed', 'alice');
    expect(taskBoard.softDeleteTask).toHaveBeenCalledWith('task-1', 'user');
    expect(taskBoard.restoreTask).toHaveBeenCalledWith('task-1', 'user');
    expect(taskBoard.setTaskOwner).toHaveBeenCalledWith('task-1', 'bob', 'user');
    expect(taskBoard.updateTaskFields).toHaveBeenCalledWith('task-1', fields);
    expect(taskBoard.addTaskAttachmentMeta).toHaveBeenCalledWith('task-1', attachment);
    expect(taskBoard.removeTaskAttachment).toHaveBeenCalledWith('task-1', 'attachment-1');
    expect(taskBoard.setNeedsClarification).toHaveBeenCalledWith('task-1', 'lead');
    expect(taskBoard.linkTask).toHaveBeenCalledWith('task-1', 'task-2', 'blocked-by');
    expect(taskBoard.unlinkTask).toHaveBeenCalledWith('task-1', 'task-3', 'related');
    expect(getTaskBoard).toHaveBeenCalledTimes(10);
    expect(invalidateGlobalTaskProjectionCache).toHaveBeenCalledTimes(10);
  });

  it('preserves controller comments and creates the legacy user fallback when absent', async () => {
    const taskBoard = createTaskBoard();
    const { coordinator, createId, invalidateGlobalTaskProjectionCache, nowIso } =
      createCoordinator(taskBoard);
    const persistedComment = {
      id: 'comment-1',
      author: 'user',
      text: 'Persisted comment',
      createdAt: '2026-07-30T11:30:00.000Z',
      type: 'regular' as const,
    };
    vi.mocked(taskBoard.addTaskComment).mockReturnValueOnce({ comment: persistedComment });

    await expect(coordinator.addTaskComment('team-a', 'task-1', 'Persisted comment')).resolves.toBe(
      persistedComment
    );
    expect(taskBoard.addTaskComment).toHaveBeenNthCalledWith(1, 'task-1', {
      from: 'user',
      text: 'Persisted comment',
      attachments: undefined,
      taskRefs: undefined,
    });
    expect(createId).not.toHaveBeenCalled();
    expect(nowIso).not.toHaveBeenCalled();

    const attachments = [
      {
        id: 'attachment-1',
        filename: 'proof.png',
        mimeType: 'image/png',
        size: 42,
        addedAt: '2026-07-30T11:45:00.000Z',
      },
    ];
    const taskRefs = [{ taskId: 'task-2', displayId: '2', teamName: 'team-a' }];
    vi.mocked(taskBoard.addTaskComment).mockReturnValueOnce({});

    await expect(
      coordinator.addTaskComment('team-a', 'task-1', 'Fallback comment', attachments, taskRefs)
    ).resolves.toEqual({
      id: 'fallback-comment-id',
      author: 'user',
      text: 'Fallback comment',
      createdAt: '2026-07-30T12:00:00.000Z',
      type: 'regular',
      taskRefs,
      attachments,
    });
    expect(invalidateGlobalTaskProjectionCache).toHaveBeenCalledTimes(2);
  });

  it('uses lead runtime context for explicit review requests without invalidating projections', async () => {
    const {
      coordinator,
      invalidateGlobalTaskProjectionCache,
      resolveLeadRuntimeContext,
      taskBoard,
    } = createCoordinator();

    await coordinator.requestReview('team-a', 'task-1');

    expect(resolveLeadRuntimeContext).toHaveBeenCalledWith('team-a');
    expect(taskBoard.requestReview).toHaveBeenCalledWith('task-1', {
      from: 'team-lead',
      leadSessionId: 'lead-session-1',
    });
    expect(invalidateGlobalTaskProjectionCache).not.toHaveBeenCalled();
  });

  it('owns review-aware Kanban decisions and preserves transition payloads', async () => {
    const taskBoard = createTaskBoard({
      getTask: vi.fn((taskId: string) => {
        if (taskId === 'task-in-review') {
          return {
            id: taskId,
            status: 'completed',
            reviewState: 'none',
            historyEvents: [],
          };
        }
        if (taskId === 'task-history-review') {
          return {
            id: taskId,
            status: 'completed',
            reviewState: 'none',
            historyEvents: [{ type: 'review_started', to: 'review' }],
          };
        }
        return {
          id: taskId,
          status: 'completed',
          reviewState: 'none',
          historyEvents: [],
        };
      }),
      getKanbanState: vi.fn(() => ({
        tasks: {
          'task-in-review': { column: 'review' },
        },
      })),
    });
    const { coordinator, invalidateGlobalTaskProjectionCache, resolveLeadRuntimeContext } =
      createCoordinator(taskBoard);
    const taskRefs = [{ taskId: 'task-2', displayId: '2', teamName: 'team-a' }];

    await coordinator.updateKanban('team-a', 'task-remove', { op: 'remove' });
    await coordinator.updateKanban('team-a', 'task-review', {
      op: 'set_column',
      column: 'review',
    });
    await coordinator.updateKanban('team-a', 'task-in-review', {
      op: 'set_column',
      column: 'approved',
    });
    await coordinator.updateKanban('team-a', 'task-history-review', {
      op: 'set_column',
      column: 'approved',
    });
    await coordinator.updateKanban('team-a', 'task-direct-approval', {
      op: 'set_column',
      column: 'approved',
    });
    await coordinator.updateKanban('team-a', 'task-changes', {
      op: 'request_changes',
      comment: '  Needs fixes  ',
      taskRefs,
    });
    await coordinator.updateKanban('team-a', 'task-default-comment', {
      op: 'request_changes',
      comment: '   ',
    });

    expect(taskBoard.clearKanban).toHaveBeenCalledWith('task-remove');
    expect(taskBoard.requestReview).toHaveBeenCalledWith('task-review', {
      from: 'team-lead',
      leadSessionId: 'lead-session-1',
    });
    expect(taskBoard.approveReview).toHaveBeenNthCalledWith(1, 'task-in-review', {
      from: 'team-lead',
      suppressTaskComment: true,
      'notify-owner': true,
      leadSessionId: 'lead-session-1',
    });
    expect(taskBoard.approveReview).toHaveBeenNthCalledWith(2, 'task-history-review', {
      from: 'team-lead',
      suppressTaskComment: true,
      'notify-owner': true,
      leadSessionId: 'lead-session-1',
    });
    expect(taskBoard.setKanbanColumn).toHaveBeenCalledWith('task-direct-approval', 'approved', {
      transition: 'manual_approve',
    });
    expect(taskBoard.requestChanges).toHaveBeenNthCalledWith(1, 'task-changes', {
      from: 'team-lead',
      comment: 'Needs fixes',
      taskRefs,
      leadSessionId: 'lead-session-1',
    });
    expect(taskBoard.requestChanges).toHaveBeenNthCalledWith(2, 'task-default-comment', {
      from: 'team-lead',
      comment: 'Reviewer requested changes.',
      leadSessionId: 'lead-session-1',
    });
    expect(resolveLeadRuntimeContext).toHaveBeenCalledTimes(6);
    expect(invalidateGlobalTaskProjectionCache).not.toHaveBeenCalled();
  });

  it('retains review approval when controller task inspection is unavailable', async () => {
    const taskBoard = createTaskBoard({
      getTask: undefined,
      getKanbanState: undefined,
    });
    const { coordinator } = createCoordinator(taskBoard);

    await coordinator.updateKanban('team-a', 'task-1', {
      op: 'set_column',
      column: 'approved',
    });

    expect(taskBoard.approveReview).toHaveBeenCalledWith('task-1', {
      from: 'team-lead',
      suppressTaskComment: true,
      'notify-owner': true,
      leadSessionId: 'lead-session-1',
    });
    expect(taskBoard.setKanbanColumn).not.toHaveBeenCalled();
  });

  it('delegates column ordering without review context or cache invalidation', async () => {
    const {
      coordinator,
      invalidateGlobalTaskProjectionCache,
      resolveLeadRuntimeContext,
      taskBoard,
    } = createCoordinator();

    await coordinator.updateKanbanColumnOrder('team-a', 'done', ['task-2', 'task-1']);

    expect(taskBoard.updateColumnOrder).toHaveBeenCalledWith('done', ['task-2', 'task-1']);
    expect(resolveLeadRuntimeContext).not.toHaveBeenCalled();
    expect(invalidateGlobalTaskProjectionCache).not.toHaveBeenCalled();
  });
});
