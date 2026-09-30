import { describe, expect, it, vi } from 'vitest';

import {
  type TaskCommentNotificationJournalPort,
  TeamTaskCommentNotificationCoordinator,
  type TeamTaskCommentNotificationCoordinatorPorts,
} from '../../../../src/main/services/team/TeamTaskCommentNotificationCoordinator';

import type { TaskCommentNotificationJournalEntry } from '../../../../src/main/services/team/TaskCommentNotificationJournalStore';
import type { SendMessageRequest, TeamConfig, TeamTask } from '../../../../src/shared/types';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createTask(commentIds: readonly string[]): TeamTask {
  return {
    id: 'task-1',
    displayId: 'abcd1234',
    subject: 'Investigate',
    status: 'pending',
    owner: 'alice',
    comments: commentIds.map((id, index) => ({
      id,
      author: 'alice',
      text: index === 0 ? 'Found the root cause.' : 'Confirmed the follow-up fix.',
      createdAt: `2026-03-14T10:0${index}:00.000Z`,
      type: 'regular',
    })),
  };
}

function createJournal(
  entries: TaskCommentNotificationJournalEntry[] = [],
  initialized = true
): {
  entries: TaskCommentNotificationJournalEntry[];
  journal: TaskCommentNotificationJournalPort;
} {
  let exists = initialized;
  const journal: TaskCommentNotificationJournalPort = {
    exists: vi.fn(async () => exists),
    ensureFile: vi.fn(async () => {
      exists = true;
    }),
    withEntries: vi.fn(async (_teamName, fn) => {
      const outcome = await fn(entries);
      return outcome.result;
    }),
  };
  return { entries, journal };
}

function createCoordinator(
  overrides: Partial<TeamTaskCommentNotificationCoordinatorPorts> = {}
): TeamTaskCommentNotificationCoordinator {
  const config: TeamConfig = {
    name: 'My team',
    members: [{ name: 'team-lead', role: 'Lead' }],
    leadSessionId: 'lead-session-1',
  };
  return new TeamTaskCommentNotificationCoordinator({
    listTeams: vi.fn(async () => []),
    readConfig: vi.fn(async () => config),
    resolveLeadName: vi.fn(() => 'team-lead'),
    readTasks: vi.fn(async () => []),
    readLeadInboxMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
    journal: createJournal().journal,
    ...overrides,
  });
}

describe('TeamTaskCommentNotificationCoordinator', () => {
  it('coalesces concurrent same-team refreshes and delivers each discovered comment once', async () => {
    const entries: TaskCommentNotificationJournalEntry[] = [];
    const firstJournalWriteStarted = createDeferred();
    const releaseFirstJournalWrite = createDeferred();
    let withEntriesCalls = 0;
    let activeJournalWrites = 0;
    let maxActiveJournalWrites = 0;
    const journal: TaskCommentNotificationJournalPort = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName, fn) => {
        withEntriesCalls += 1;
        activeJournalWrites += 1;
        maxActiveJournalWrites = Math.max(maxActiveJournalWrites, activeJournalWrites);
        try {
          if (withEntriesCalls === 1) {
            firstJournalWriteStarted.resolve();
            await releaseFirstJournalWrite.promise;
          }
          const outcome = await fn(entries);
          return outcome.result;
        } finally {
          activeJournalWrites -= 1;
        }
      }),
    };
    const readTasks = vi
      .fn<() => Promise<readonly TeamTask[]>>()
      .mockResolvedValueOnce([createTask(['comment-1'])])
      .mockResolvedValue([createTask(['comment-1', 'comment-2'])]);
    const sentRequests: SendMessageRequest[] = [];
    const sendMessage = vi.fn(async (_teamName: string, request: SendMessageRequest) => {
      sentRequests.push(request);
    });
    const coordinator = createCoordinator({ journal, readTasks, sendMessage });

    const first = coordinator.notifyLeadOnTeammateTaskComment('my-team', 'task-1');
    await firstJournalWriteStarted.promise;
    const second = coordinator.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

    expect(journal.withEntries).toHaveBeenCalledTimes(1);
    releaseFirstJournalWrite.resolve();
    await Promise.all([first, second]);

    expect(maxActiveJournalWrites).toBe(1);
    expect(readTasks).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sentRequests.map((request) => request.messageId)).toEqual([
      'task-comment-forward:my-team:task-1:comment-1',
      'task-comment-forward:my-team:task-1:comment-2',
    ]);
    expect(sentRequests[0]).toMatchObject({
      member: 'team-lead',
      from: 'alice',
      summary: 'Comment on #abcd1234',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      leadSessionId: 'lead-session-1',
      taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' }],
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'task-1:comment-1', state: 'sent' }),
        expect.objectContaining({ key: 'task-1:comment-2', state: 'sent' }),
      ])
    );
  });

  it('holds watcher delivery behind initialization and recovers a pending journal claim once', async () => {
    const messageId = 'task-comment-forward:my-team:task-1:comment-1';
    const { entries, journal } = createJournal([
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId,
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ]);
    const initializationGate = createDeferred();
    const listTeams = vi.fn(async () => {
      await initializationGate.promise;
      return [
        {
          teamName: 'my-team',
          deletedAt: undefined,
          leadName: 'startup-lead',
          leadSessionId: 'startup-session',
        },
      ];
    });
    const readConfig = vi.fn(async () => ({
      name: 'My team',
      members: [{ name: 'startup-lead', role: 'Lead' }],
      leadSessionId: 'startup-session',
    }));
    const sendMessage = vi.fn(async () => undefined);
    const coordinator = createCoordinator({
      journal,
      listTeams,
      readConfig,
      resolveLeadName: () => 'startup-lead',
      readTasks: vi.fn(async () => [createTask(['comment-1'])]),
      sendMessage,
    });

    const initialization = coordinator.initializeTaskCommentNotificationState();
    const duplicateInitialization = coordinator.initializeTaskCommentNotificationState();
    const watcherNotification = coordinator.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();

    initializationGate.resolve();
    await Promise.all([initialization, duplicateInitialization, watcherNotification]);

    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        member: 'startup-lead',
        leadSessionId: 'startup-session',
        messageId,
      })
    );
    expect(entries[0]).toMatchObject({ state: 'sent', messageId, sentAt: expect.any(String) });
  });

  it('leaves a failed delivery pending and releases its claim for a later recovery attempt', async () => {
    const { entries, journal } = createJournal();
    const deliveryFailure = new Error('inbox unavailable');
    const sendMessage = vi
      .fn<(teamName: string, request: SendMessageRequest) => Promise<void>>()
      .mockRejectedValueOnce(deliveryFailure)
      .mockResolvedValue(undefined);
    const coordinator = createCoordinator({
      journal,
      readTasks: vi.fn(async () => [createTask(['comment-1'])]),
      sendMessage,
    });

    await expect(coordinator.notifyLeadOnTeammateTaskComment('my-team', 'task-1')).rejects.toBe(
      deliveryFailure
    );
    expect(entries[0]).toMatchObject({
      key: 'task-1:comment-1',
      state: 'pending_send',
      messageId: 'task-comment-forward:my-team:task-1:comment-1',
    });

    await coordinator.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[1].messageId).toBe(sendMessage.mock.calls[1]?.[1].messageId);
    expect(entries[0]).toMatchObject({ state: 'sent', sentAt: expect.any(String) });
  });
});
