import { HOSTED_TASK_BOARD_MAX_PAGE_BYTES } from '@features/team-task-board/core/domain/models/HostedTaskBoardBudget';
import {
  createHostedTeamTaskBoardFeature,
  createHostedTeamTaskBoardOutputAdapters,
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  type HostedTaskBoardAuthorityPort,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
  parseHostedTaskIdempotencyKey,
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
  it('maps the read authority to the existing page source port', async () => {
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
    const authority: HostedTaskBoardAuthorityPort = { readWindow };

    const adapters = createHostedTeamTaskBoardOutputAdapters(authority);

    expect(Object.isFrozen(adapters)).toBe(true);
    expect(Reflect.ownKeys(adapters)).toEqual(['pageSource']);
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

  it('adds mutation admission only for a generation-first authority and keeps the query context', async () => {
    const sourceGeneration = parseHostedTaskBoardSourceGeneration(
      'generation_mutation-composition'
    );
    const expectedRevision = parseRevision('revision_mutation-composition-expected');
    const committedRevision = parseRevision('revision_mutation-composition-committed');
    const command = {
      schemaVersion: 1 as const,
      commandId: parseHostedTaskCommandId('command_mutation-composition'),
      idempotencyKey: parseHostedTaskIdempotencyKey('mutation-composition-key'),
      teamId,
      expectedSourceGeneration: sourceGeneration,
      expectedRevision,
      kind: 'update_status' as const,
      taskId,
      status: 'completed' as const,
    };
    const queryContext = context();
    const admitTaskMutation = vi.fn(
      async (
        request: Parameters<NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>>[0]
      ) =>
        Object.freeze({
          kind: 'committed' as const,
          currentSourceGeneration: sourceGeneration,
          payloadFingerprint: request.payloadFingerprint,
          receipt: Object.freeze({
            schemaVersion: 1 as const,
            outcome: 'committed' as const,
            commandId: request.command.commandId,
            teamId,
            sourceGeneration,
            revision: committedRevision,
            affectedTaskIds: Object.freeze([taskId]),
          }),
        })
    );
    const authority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async () => Object.freeze({ kind: 'not_found' as const })),
      admitTaskMutation,
    };

    const adapters = createHostedTeamTaskBoardOutputAdapters(authority);

    expect(Reflect.ownKeys(adapters)).toEqual(['pageSource', 'mutationAdmission']);
    const mutationAdmission = adapters.mutationAdmission;
    expect(mutationAdmission).toBeDefined();
    if (mutationAdmission === undefined) return;
    const feature = createHostedTeamTaskBoardFeature({
      pageSource: adapters.pageSource,
      mutationAdmission,
    });
    expect(feature.routes.some((route) => route.path === HOSTED_TASK_BOARD_MUTATION_ROUTE)).toBe(
      true
    );
    const executeMutation = feature.executeMutation;
    expect(executeMutation).toBeTypeOf('function');
    if (executeMutation === undefined) return;
    await expect(executeMutation(command, queryContext)).resolves.toEqual({
      kind: 'committed',
      receipt: {
        schemaVersion: 1,
        outcome: 'committed',
        commandId: command.commandId,
        teamId,
        sourceGeneration,
        revision: committedRevision,
        affectedTaskIds: [taskId],
      },
    });
    expect(admitTaskMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining(command),
        payloadFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
      queryContext
    );
  });
});
