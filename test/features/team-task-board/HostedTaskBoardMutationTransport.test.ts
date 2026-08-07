import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  type HostedTaskBoardCoreV1MutationCommand,
  type HostedTaskMutationCommand,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
  parseHostedTaskIdempotencyKey,
} from '@features/team-task-board/contracts/hosted';
import {
  createHostedTaskBoardTransport,
  type HostedTaskBoardFetchPort,
} from '@features/team-task-board/renderer';
import { parseMemberId, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const taskId = parseHostedTaskId(`task_${'b'.repeat(32)}`);
const otherTaskId = parseHostedTaskId(`task_${'c'.repeat(32)}`);
const memberId = parseMemberId(`member_${'d'.repeat(32)}`);
const commandId = parseHostedTaskCommandId('command_mutation-transport');
const idempotencyKey = parseHostedTaskIdempotencyKey('mutation-transport-key');
const generation = parseHostedTaskBoardSourceGeneration('generation_mutation-transport');
const replacementGeneration = parseHostedTaskBoardSourceGeneration(
  'generation_mutation-transport-replacement'
);
const revision = parseRevision('revision_mutation-transport');
const replacementRevision = parseRevision('revision_mutation-transport-replacement');

const mutationBase = { schemaVersion: 1, commandId, idempotencyKey, teamId } as const;
const browserCommands: readonly HostedTaskBoardCoreV1MutationCommand[] = [
  {
    ...mutationBase,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'create_task',
    subject: 'Created task',
    description: null,
    status: 'pending',
    ownerId: null,
    column: 'todo',
    order: 0,
  },
  {
    ...mutationBase,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'update_details',
    taskId,
    subject: 'Updated task',
  },
  {
    ...mutationBase,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'update_status',
    taskId,
    status: 'completed',
  },
  {
    ...mutationBase,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'update_owner',
    taskId,
    ownerId: memberId,
  },
  {
    ...mutationBase,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'move_task',
    taskId,
    column: 'review',
    order: 1,
  },
  {
    ...mutationBase,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'reorder_column',
    column: 'todo',
    orderedTaskIds: [otherTaskId, taskId],
  },
];

function command(): HostedTaskBoardCoreV1MutationCommand {
  return browserCommands[2]!;
}

function relationshipCommand() {
  return Object.freeze({
    schemaVersion: 1 as const,
    commandId,
    idempotencyKey,
    teamId,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'update_relationship' as const,
    action: 'add' as const,
    taskId,
    otherTaskId,
    relationship: 'blocks' as const,
  } satisfies HostedTaskMutationCommand);
}

function execute(transport: ReturnType<typeof createHostedTaskBoardTransport>) {
  const mutation = transport.executeMutation;
  if (mutation === undefined) throw new Error('hosted-task-board-mutation-transport-missing');
  return mutation;
}

describe('HostedTaskBoardMutationTransport', () => {
  it('keeps mutations unadvertised until the matching hosted route is enabled', () => {
    const transport = createHostedTaskBoardTransport({
      fetch: vi.fn<HostedTaskBoardFetchPort>(),
      getCsrfToken: () => 'c'.repeat(32),
    });

    expect(transport.executeMutation).toBeUndefined();
  });

  it.each(browserCommands)(
    'posts an exact $kind command with CSRF credentials',
    async (command) => {
      const fetch = vi.fn<HostedTaskBoardFetchPort>().mockResolvedValue({
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          outcome: 'committed',
          commandId,
          teamId,
          sourceGeneration: generation,
          revision: replacementRevision,
          affectedTaskIds: [taskId],
        }),
      });
      const transport = createHostedTaskBoardTransport({
        fetch,
        getCsrfToken: () => 'c'.repeat(32),
        mutationsEnabled: true,
      });

      await expect(execute(transport)(command)).resolves.toEqual({
        kind: 'committed',
        receipt: {
          schemaVersion: 1,
          outcome: 'committed',
          commandId,
          teamId,
          sourceGeneration: generation,
          revision: replacementRevision,
          affectedTaskIds: [taskId],
        },
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe(HOSTED_TASK_BOARD_MUTATION_ROUTE);
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'x-agent-teams-csrf': 'c'.repeat(32) },
      });
      expect(JSON.parse(fetch.mock.calls[0]?.[1].body ?? '')).toEqual(command);
    }
  );

  it('rejects an internal relationship command before any public renderer transport call', async () => {
    const fetch = vi.fn<HostedTaskBoardFetchPort>();
    const getCsrfToken = vi.fn(() => 'c'.repeat(32));
    const transport = createHostedTaskBoardTransport({
      fetch,
      getCsrfToken,
      mutationsEnabled: true,
    });

    await expect(execute(transport)(relationshipCommand() as never)).resolves.toEqual({
      kind: 'invalid_request',
    });
    expect(getCsrfToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves replay, conflict, stale generation, and stale revision outcomes', async () => {
    const fetch = vi
      .fn<HostedTaskBoardFetchPort>()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          schemaVersion: 1,
          outcome: 'idempotent_replay',
          commandId,
          teamId,
          sourceGeneration: generation,
          revision: replacementRevision,
          affectedTaskIds: [taskId],
        }),
      })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'conflict', reason: 'stale_generation' },
          retryable: false,
          currentSourceGeneration: replacementGeneration,
        }),
      })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'conflict', reason: 'stale_revision' },
          retryable: false,
          currentRevision: replacementRevision,
        }),
      })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'conflict', reason: 'idempotency_mismatch' },
          retryable: false,
        }),
      })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'conflict', reason: 'relationship_conflict' },
          retryable: false,
          currentRevision: replacementRevision,
        }),
      })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'conflict', reason: 'state_conflict' },
          retryable: false,
          currentRevision: replacementRevision,
        }),
      });
    const mutation = execute(
      createHostedTaskBoardTransport({
        fetch,
        getCsrfToken: () => 'c'.repeat(32),
        mutationsEnabled: true,
      })
    );

    await expect(mutation(command())).resolves.toMatchObject({ kind: 'idempotent_replay' });
    await expect(mutation(command())).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
    await expect(mutation(command())).resolves.toEqual({
      kind: 'stale_revision',
      currentRevision: replacementRevision,
    });
    await expect(mutation(command())).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(mutation(command())).resolves.toEqual({
      kind: 'conflict',
      reason: 'relationship_conflict',
      currentRevision: replacementRevision,
    });
    await expect(mutation(command())).resolves.toEqual({
      kind: 'conflict',
      reason: 'state_conflict',
      currentRevision: replacementRevision,
    });
  });

  it('fails closed on malformed receipts, missing CSRF state, and transport faults', async () => {
    const malformedFetch = vi.fn<HostedTaskBoardFetchPort>().mockResolvedValue({
      status: 200,
      json: async () => ({ secret: '/private/path' }),
    });
    await expect(
      execute(
        createHostedTaskBoardTransport({
          fetch: malformedFetch,
          getCsrfToken: () => 'c'.repeat(32),
          mutationsEnabled: true,
        })
      )(command())
    ).resolves.toEqual({ kind: 'unavailable' });

    const unavailableTransport = createHostedTaskBoardTransport({
      fetch: vi.fn<HostedTaskBoardFetchPort>(),
      getCsrfToken: () => null,
      mutationsEnabled: true,
    });
    await expect(execute(unavailableTransport)(command())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
