import { HOSTED_TASK_BOARD_MAX_PAGE_BYTES } from '@features/team-task-board/core/domain/models/HostedTaskBoardBudget';
import {
  createHostedTeamTaskBoardOutputAdapters,
  type HostedTaskBoardAuthorityPort,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
} from '@features/team-task-board/main/hosted';
import {
  createQueryContext,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId('team_00000000000000000000000000000001');
const taskId = parseHostedTaskId('task_00000000000000000000000000000001');

function context(): QueryContext {
  return createQueryContext({
    actorId: 'actor_task-board-composition',
    sessionId: 'session_task-board-composition',
    deploymentId: 'deployment_task-board-composition',
    bootId: 'boot_task-board-composition',
    requestId: 'request_task-board-composition',
    authorizedScope: 'scope_task-board-composition',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
}

describe('createHostedTeamTaskBoardOutputAdapters', () => {
  it('uses one production authority adapter instance for page and mutation admission', async () => {
    const readWindow = vi.fn(
      async (
        _request: Parameters<HostedTaskBoardAuthorityPort['readWindow']>[0],
        _context: QueryContext
      ) => ({
        kind: 'found' as const,
        teamId,
        sourceGeneration: parseHostedTaskBoardSourceGeneration('generation_composition'),
        revision: parseRevision('revision_composition'),
        items: [
          {
            teamId,
            taskId,
            subject: 'Composed task',
            description: null,
            status: 'pending' as const,
            ownerId: null,
            column: 'todo' as const,
            order: 0,
            blockedByTaskIds: [],
            blocksTaskIds: [],
            relatedTaskIds: [],
          },
        ],
        hasMore: false,
        truncatedBy: null,
        degradedReasons: [],
      })
    );
    const compareAndCommit = vi.fn(
      async (
        _command: Parameters<HostedTaskBoardAuthorityPort['compareAndCommit']>[0],
        _context: QueryContext
      ) => ({ kind: 'not_found' as const })
    );
    const authority: HostedTaskBoardAuthorityPort = { readWindow, compareAndCommit };

    const adapters = createHostedTeamTaskBoardOutputAdapters(authority);

    expect(Object.isFrozen(adapters)).toBe(true);
    expect(adapters.pageSource).toBe(adapters.mutationAdmission);
    const queryContext = context();
    await adapters.pageSource.readPage(
      {
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        itemLimit: 2,
        byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
        deadlineAtMs: queryContext.deadlineAtMs,
      },
      queryContext
    );
    expect(readWindow).toHaveBeenCalledOnce();
    expect(readWindow.mock.calls[0]?.[1]).toBe(queryContext);
  });
});
