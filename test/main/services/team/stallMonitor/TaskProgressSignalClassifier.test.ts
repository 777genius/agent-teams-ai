import { describe, expect, it } from 'vitest';

import {
  classifyTaskProgressTouch,
  getTaskCommentForActivityRecord,
} from '../../../../../src/main/services/team/stallMonitor/TaskProgressSignalClassifier';

import type { BoardTaskActivityRecord } from '../../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { TeamTask } from '../../../../../src/shared/types';

function createTask(commentText?: string): TeamTask {
  return {
    id: 'task-a',
    displayId: 'abcd1234',
    subject: 'Task A',
    status: 'in_progress',
    comments:
      commentText == null
        ? []
        : [
            {
              id: 'comment-a',
              author: 'alice',
              text: commentText,
              createdAt: '2026-04-19T12:00:00.000Z',
              type: 'regular',
            },
          ],
  };
}

function createCommentRecord(commentId: string | null = 'comment-a'): BoardTaskActivityRecord {
  return {
    id: 'record-a',
    timestamp: '2026-04-19T12:00:00.000Z',
    task: {
      locator: { ref: 'task-a', refKind: 'canonical', canonicalId: 'task-a' },
      resolution: 'resolved',
      taskRef: { taskId: 'task-a', displayId: 'abcd1234', teamName: 'demo' },
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: 'session-a',
      isSidechain: true,
    },
    actorContext: { relation: 'same_task' },
    action: {
      canonicalToolName: 'task_add_comment',
      category: 'comment',
      toolUseId: 'tool-a',
      details: commentId ? { commentId } : {},
    },
    source: {
      messageUuid: 'msg-a',
      filePath: '/tmp/session.jsonl',
      toolUseId: 'tool-a',
      sourceOrder: 1,
    },
  };
}

describe('TaskProgressSignalClassifier', () => {
  it.each([
    'Начинаю работу.',
    'Приступаю.',
    'Беру в работу.',
    'Проверю.',
    'Посмотрю.',
    'Will start.',
    'Starting work.',
    'Taking this.',
  ])(
    'classifies start-only comment as weak: %s',
    (text) => {
      expect(
        classifyTaskProgressTouch({
          task: createTask(text),
          record: createCommentRecord(),
        })
      ).toMatchObject({ signal: 'weak_start_only' });
    }
  );

  it.each([
    'Found the failing test in src/app.ts and reproduced it with pnpm test.',
    'Проверил src/main.ts - причина в stale runtime metadata.',
    'Blocked: нет доступа к проекту.',
    'Нужно уточнение: какой файл менять?',
    'Tests failed with EADDRINUSE, next step is to isolate the server port.',
  ])('does not classify substantive, blocker, or question comments as weak: %s', (text) => {
    const classification = classifyTaskProgressTouch({
      task: createTask(text),
      record: createCommentRecord(),
    });

    expect(classification.signal).not.toBe('weak_start_only');
  });

  it('returns unknown when commentId is missing', () => {
    expect(
      classifyTaskProgressTouch({
        task: createTask('Начинаю работу.'),
        record: createCommentRecord(null),
      })
    ).toMatchObject({ signal: 'unknown' });
  });

  it('returns unknown when comment text is unavailable', () => {
    expect(
      classifyTaskProgressTouch({
        task: createTask(),
        record: createCommentRecord(),
      })
    ).toMatchObject({ signal: 'unknown' });
  });

  it('returns the matching task comment for an activity record', () => {
    const task = createTask('Начинаю работу.');

    expect(getTaskCommentForActivityRecord(task, createCommentRecord())?.id).toBe('comment-a');
  });
});
