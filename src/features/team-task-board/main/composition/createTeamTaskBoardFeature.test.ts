import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTeamTaskBoardFeature } from './createTeamTaskBoardFeature';

describe('createTeamTaskBoardFeature', () => {
  it('keeps the compatibility service receiver and launch governor behavior', async () => {
    const task = { id: 'task-1', teamName: 'my-team', subject: 'Task' };
    const addTaskComment = vi.fn(async () => ({
      id: 'comment-1',
      author: 'user',
      text: 'Comment',
      createdAt: '2026-07-22T00:00:00.000Z',
      type: 'regular' as const,
    }));
    const taskBoardApi = {
      getAllTasks(): Promise<(typeof task)[]> {
        if (this !== taskBoardApi) {
          throw new Error('task board receiver lost');
        }
        return Promise.resolve([task]);
      },
      addTaskComment,
    };
    const runSummaryOperation = vi.fn(
      async (_key: string, loadFresh: () => Promise<(typeof task)[]>): Promise<(typeof task)[]> =>
        loadFresh()
    );
    const commentAttachments = {
      saveAttachment: vi.fn(),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };

    const feature = createTeamTaskBoardFeature({
      taskBoardApi: taskBoardApi as never,
      runtimeApi: { isTeamAlive: vi.fn(() => false) },
      notificationApi: { sendMessageToTeam: vi.fn(async () => undefined) },
      launchIoGovernor: { runSummaryOperation } as never,
      commentAttachments,
      logger,
    });

    await expect(feature.globalTasks.getAllTasks()).resolves.toEqual([task]);
    expect(feature.queries).toBe(taskBoardApi);
    expect(feature.commands).toBe(taskBoardApi);
    expect(feature.changePresence).toBe(taskBoardApi);
    expect(feature.logger).toBe(logger);
    await expect(
      feature.addTaskComment.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [],
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'comment-1' }));
    expect(addTaskComment).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'Comment',
      undefined,
      undefined
    );
    expect(runSummaryOperation).toHaveBeenCalledWith(
      'teams:getAllTasks',
      expect.any(Function),
      expect.objectContaining({ clone: expect.any(Function) })
    );
  });

  it('is wired unconditionally through the application IPC composition root', () => {
    const handlersSource = readFileSync(resolve(process.cwd(), 'src/main/ipc/handlers.ts'), 'utf8');

    expect(handlersSource).toContain('const teamTaskBoardFeature = createTeamTaskBoardFeature({');
    expect(handlersSource).toContain('registerTeamTaskBoardIpc(ipcMain, teamTaskBoardFeature);');
    expect(handlersSource).toContain('removeTeamTaskBoardIpc(ipcMain);');
  });
});
