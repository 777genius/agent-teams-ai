import {
  HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES,
  HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
  HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS,
  measureHostedTaskBoardJsonBytes,
} from '@features/team-task-board/core/domain/models/HostedTaskBoardBudget';
import { HostedTaskBoardMutationAuthorityAdapter } from '@features/team-task-board/main/adapters/output/HostedTaskBoardMutationAuthorityAdapter';
import {
  HostedTaskBoardAuthorityAdapter,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  type HostedTaskBoardItem,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
  parseHostedTaskIdempotencyKey,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import {
  createQueryContext,
  parseCursor,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTaskBoardPageSourceRequest } from '@features/team-task-board/main/hosted';

const teamId = parseTeamId('team_00000000000000000000000000000001');
const otherTeamId = parseTeamId('team_00000000000000000000000000000002');
const taskA = parseHostedTaskId('task_00000000000000000000000000000001');
const taskB = parseHostedTaskId('task_00000000000000000000000000000002');
const generation = parseHostedTaskBoardSourceGeneration('generation_authority-1');
const replacementGeneration = parseHostedTaskBoardSourceGeneration('generation_authority-2');
const revision = parseRevision('revision_authority-1');
const replacementRevision = parseRevision('revision_authority-2');

function context(deadlineAtMs = 1_000, signal = new AbortController().signal): QueryContext {
  return createQueryContext({
    actorId: 'actor_task-board-authority',
    sessionId: 'session_task-board-authority',
    deploymentId: 'deployment_task-board-authority',
    bootId: 'boot_task-board-authority',
    requestId: 'request_task-board-authority',
    authorizedScope: 'scope_task-board-authority',
    deadlineAtMs,
    signal,
  });
}

function item(taskId: TaskId, overrides: Partial<HostedTaskBoardItem> = {}): HostedTaskBoardItem {
  return Object.freeze({
    teamId,
    taskId,
    subject: `Subject ${taskId.slice(-2)}`,
    description: null,
    status: 'pending',
    ownerId: null,
    column: 'todo',
    order: 0,
    blockedByTaskIds: Object.freeze([]),
    blocksTaskIds: Object.freeze([]),
    relatedTaskIds: Object.freeze([]),
    ...overrides,
  });
}

function found(
  items: readonly HostedTaskBoardItem[],
  overrides: Partial<Extract<HostedTaskBoardAuthorityReadWindowResult, { kind: 'found' }>> = {}
): Extract<HostedTaskBoardAuthorityReadWindowResult, { kind: 'found' }> {
  return Object.freeze({
    kind: 'found',
    teamId,
    sourceGeneration: generation,
    revision,
    items: Object.freeze([...items]),
    hasMore: false,
    truncatedBy: null,
    degradedReasons: Object.freeze([]),
    ...overrides,
  });
}

function readRequest(
  overrides: Partial<HostedTaskBoardPageSourceRequest> = {}
): HostedTaskBoardPageSourceRequest {
  return Object.freeze({
    teamId,
    cursor: null,
    expectedSourceGeneration: null,
    itemLimit: 3,
    byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
    deadlineAtMs: 500,
    ...overrides,
  });
}

function authority(readResult: unknown) {
  const readWindow = vi.fn(
    async (_request: HostedTaskBoardAuthorityReadWindowRequest, _context: QueryContext) =>
      readResult as HostedTaskBoardAuthorityReadWindowResult
  );
  return { authority: { readWindow }, readWindow };
}

function mutationCommand() {
  return Object.freeze({
    schemaVersion: 1 as const,
    commandId: parseHostedTaskCommandId('command_authority-mutation'),
    idempotencyKey: parseHostedTaskIdempotencyKey('authority-mutation-key'),
    teamId,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    kind: 'update_status' as const,
    taskId: taskA,
    status: 'completed' as const,
  });
}

function replayLedgerForTest(
  adapter: HostedTaskBoardMutationAuthorityAdapter
): ReadonlyMap<string, { readonly receipt: { readonly commandId: string } }> {
  const ledger = Reflect.get(adapter, 'replayLedger');
  if (!(ledger instanceof Map)) {
    throw new Error('hosted-task-board-replay-ledger-was-not-created');
  }
  return ledger as ReadonlyMap<string, { readonly receipt: { readonly commandId: string } }>;
}

describe('HostedTaskBoardAuthorityAdapter', () => {
  it('preserves authority order, emits exact task-bound cursors, and propagates context', async () => {
    const relatedA = item(taskA, { relatedTaskIds: Object.freeze([taskB]), order: 9 });
    const relatedB = item(taskB, { relatedTaskIds: Object.freeze([taskA]), order: 1 });
    const harness = authority(found([relatedA, relatedB]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
    const queryContext = context();

    await expect(adapter.readPage(readRequest(), queryContext)).resolves.toEqual({
      kind: 'found',
      teamId,
      sourceGeneration: generation,
      revision,
      candidates: [
        { item: relatedA, cursorAfter: `cursor_${taskA}` },
        { item: relatedB, cursorAfter: `cursor_${taskB}` },
      ],
      hasMore: false,
      truncatedBy: null,
      degradedReasons: [],
    });
    expect(harness.readWindow).toHaveBeenCalledWith(
      {
        teamId,
        afterTaskId: null,
        expectedSourceGeneration: null,
        itemLimit: 3,
        byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
        deadlineAtMs: 500,
      },
      queryContext
    );
  });

  it('decodes only exact cursor_<TaskId> continuations before authority access', async () => {
    const harness = authority(found([item(taskB)]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
    await expect(
      adapter.readPage(
        readRequest({
          cursor: parseCursor(`cursor_${taskA}`),
          expectedSourceGeneration: generation,
        }),
        context()
      )
    ).resolves.toMatchObject({ kind: 'found' });
    expect(harness.readWindow.mock.calls[0]?.[0].afterTaskId).toBe(taskA);

    for (const cursor of ['cursor_page-A', `cursor_x${taskA}`, `cursor_${taskA}_extra`]) {
      await expect(
        adapter.readPage(
          readRequest({ cursor: parseCursor(cursor), expectedSourceGeneration: generation }),
          context()
        )
      ).resolves.toEqual({ kind: 'unavailable' });
    }
    expect(harness.readWindow).toHaveBeenCalledTimes(1);
  });

  it('enforces request.byteLimit with a stable byte_budget cursor continuation', async () => {
    const first = item(taskA, { description: 'a'.repeat(1_500) });
    const second = item(taskB, { description: 'b'.repeat(1_500) });
    const byteLimit =
      HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES + measureHostedTaskBoardJsonBytes(first) + 1;
    const readWindow = vi.fn(async (request: HostedTaskBoardAuthorityReadWindowRequest) =>
      request.afterTaskId === null ? found([first, second]) : found([second])
    );
    const adapter = new HostedTaskBoardAuthorityAdapter({ readWindow }, () => 10);

    const initial = await adapter.readPage(readRequest({ itemLimit: 2, byteLimit }), context());
    expect(initial).toEqual({
      kind: 'found',
      teamId,
      sourceGeneration: generation,
      revision,
      candidates: [{ item: first, cursorAfter: `cursor_${taskA}` }],
      hasMore: true,
      truncatedBy: 'byte_budget',
      degradedReasons: [],
    });

    const continuation = await adapter.readPage(
      readRequest({
        itemLimit: 2,
        byteLimit,
        cursor: parseCursor(`cursor_${taskA}`),
        expectedSourceGeneration: generation,
      }),
      context()
    );
    expect(continuation).toEqual({
      kind: 'found',
      teamId,
      sourceGeneration: generation,
      revision,
      candidates: [{ item: second, cursorAfter: `cursor_${taskB}` }],
      hasMore: false,
      truncatedBy: null,
      degradedReasons: [],
    });
    expect(readWindow.mock.calls.map(([request]) => request.afterTaskId)).toEqual([null, taskA]);
  });

  it('maps bounded stable failures and rejects contradictory authority output', async () => {
    const cases: readonly [unknown, unknown][] = [
      [{ kind: 'not_found' }, { kind: 'not_found' }],
      [
        { kind: 'stale_generation', currentSourceGeneration: replacementGeneration },
        { kind: 'stale_generation', currentSourceGeneration: replacementGeneration },
      ],
      [
        { kind: 'unavailable', retryAfterMs: 250 },
        { kind: 'unavailable', retryAfterMs: 250 },
      ],
      [{ kind: 'stale_generation', currentSourceGeneration: generation }, { kind: 'unavailable' }],
      [{ kind: 'unavailable', retryAfterMs: 60_001 }, { kind: 'unavailable' }],
    ];
    for (const [authorityResult, expected] of cases) {
      const harness = authority(authorityResult);
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      await expect(
        adapter.readPage(
          readRequest({
            cursor: parseCursor(`cursor_${taskA}`),
            expectedSourceGeneration: generation,
          }),
          context()
        )
      ).resolves.toEqual(expected);
    }
  });

  it('fails closed on team, revision, uniqueness, symmetry, and source bounds', async () => {
    const tooMany = Array.from({ length: HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS + 1 }, (_, index) =>
      item(parseHostedTaskId(`task_${(index + 10).toString(16).padStart(32, '0')}`))
    );
    const invalidResults: readonly unknown[] = [
      found([item(taskA)], { teamId: otherTeamId }),
      { ...found([item(taskA)]), revision: 'not-a-revision' },
      found([item(taskA), item(taskA)]),
      found([item(taskA, { relatedTaskIds: Object.freeze([taskB]) }), item(taskB)]),
      found(tooMany),
      found([], { hasMore: true, truncatedBy: 'source_budget' }),
    ];
    for (const invalidResult of invalidResults) {
      const harness = authority(invalidResult);
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      await expect(adapter.readPage(readRequest(), context())).resolves.toEqual({
        kind: 'unavailable',
      });
    }
  });

  it('fails closed before and after cancellation, expiry, and authority faults', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const harness = authority(found([item(taskA)]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
    await expect(adapter.readPage(readRequest(), context(1_000, aborted.signal))).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(harness.readWindow).not.toHaveBeenCalled();

    let now = 10;
    const lateAuthority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async () => {
        now = 500;
        return found([item(taskA)]);
      }),
    };
    await expect(
      new HostedTaskBoardAuthorityAdapter(lateAuthority, () => now).readPage(
        readRequest(),
        context()
      )
    ).resolves.toEqual({ kind: 'unavailable' });

    const throwingAuthority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async () => {
        throw new Error('private provider path');
      }),
    };
    await expect(
      new HostedTaskBoardAuthorityAdapter(throwingAuthority, () => 10).readPage(
        readRequest(),
        context()
      )
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('HostedTaskBoardMutationAuthorityAdapter', () => {
  it('delegates one generation-bound command and preserves committed or replay receipts', async () => {
    const command = mutationCommand();
    const queryContext = context();
    const admitTaskMutation = vi.fn(
      async (
        request: Parameters<NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>>[0]
      ) =>
        Object.freeze({
          kind: 'idempotent_replay' as const,
          currentSourceGeneration: request.command.expectedSourceGeneration,
          payloadFingerprint: request.payloadFingerprint,
          receipt: Object.freeze({
            schemaVersion: 1 as const,
            outcome: 'idempotent_replay' as const,
            commandId: request.command.commandId,
            teamId,
            sourceGeneration: generation,
            revision: replacementRevision,
            affectedTaskIds: Object.freeze([taskA]),
          }),
        })
    );
    const adapter = new HostedTaskBoardMutationAuthorityAdapter({ admitTaskMutation }, () => 10);

    await expect(adapter.admit(command, queryContext)).resolves.toEqual({
      kind: 'idempotent_replay',
      receipt: {
        schemaVersion: 1,
        outcome: 'idempotent_replay',
        commandId: command.commandId,
        teamId,
        sourceGeneration: generation,
        revision: replacementRevision,
        affectedTaskIds: [taskA],
      },
    });
    expect(admitTaskMutation).toHaveBeenCalledOnce();
    expect(admitTaskMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining(command),
        payloadFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
      queryContext
    );
  });

  it('keeps stale generation ahead of idempotency and revision admission', async () => {
    const command = mutationCommand();
    const staleAuthority = {
      admitTaskMutation: vi.fn(
        async (
          request: Parameters<NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>>[0]
        ) =>
          Object.freeze({
            kind: 'idempotent_replay' as const,
            currentSourceGeneration: replacementGeneration,
            payloadFingerprint: request.payloadFingerprint,
            receipt: Object.freeze({
              schemaVersion: 1 as const,
              outcome: 'idempotent_replay' as const,
              commandId: request.command.commandId,
              teamId,
              sourceGeneration: request.command.expectedSourceGeneration,
              revision: replacementRevision,
              affectedTaskIds: Object.freeze([taskA]),
            }),
          })
      ),
    };
    const staleAdapter = new HostedTaskBoardMutationAuthorityAdapter(staleAuthority, () => 10);

    await expect(staleAdapter.admit(command, context())).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
    expect(staleAuthority.admitTaskMutation).toHaveBeenCalledOnce();
  });

  it('rejects replayed idempotency keys with a different payload fingerprint', async () => {
    const command = mutationCommand();
    let committedFingerprint: string | null = null;
    const admitTaskMutation = vi.fn(
      async (
        request: Parameters<NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>>[0]
      ) => {
        const replay = committedFingerprint !== null;
        committedFingerprint ??= request.payloadFingerprint;
        if (replay) {
          return Object.freeze({
            kind: 'idempotent_replay' as const,
            currentSourceGeneration: request.command.expectedSourceGeneration,
            payloadFingerprint: committedFingerprint,
            receipt: Object.freeze({
              schemaVersion: 1 as const,
              outcome: 'idempotent_replay' as const,
              commandId: request.command.commandId,
              teamId,
              sourceGeneration: request.command.expectedSourceGeneration,
              revision: replacementRevision,
              affectedTaskIds: Object.freeze([taskA]),
            }),
          });
        }
        return Object.freeze({
          kind: 'committed' as const,
          currentSourceGeneration: request.command.expectedSourceGeneration,
          payloadFingerprint: committedFingerprint,
          receipt: Object.freeze({
            schemaVersion: 1 as const,
            outcome: 'committed' as const,
            commandId: request.command.commandId,
            teamId,
            sourceGeneration: request.command.expectedSourceGeneration,
            revision: replacementRevision,
            affectedTaskIds: Object.freeze([taskA]),
          }),
        });
      }
    );
    const adapter = new HostedTaskBoardMutationAuthorityAdapter({ admitTaskMutation }, () => 10);

    await expect(adapter.admit(command, context())).resolves.toMatchObject({ kind: 'committed' });
    await expect(adapter.admit(command, context())).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    await expect(adapter.admit({ ...command, status: 'pending' }, context())).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    expect(admitTaskMutation).toHaveBeenCalledTimes(3);
  });

  it('serializes concurrent retries before updating the verified replay ledger', async () => {
    const command = mutationCommand();
    type AuthorityRequest = Parameters<
      NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>
    >[0];
    type AuthorityResult = Awaited<
      ReturnType<NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>>
    >;
    let resolveFirst!: (result: AuthorityResult) => void;
    const firstResult = new Promise<AuthorityResult>((resolve) => {
      resolveFirst = resolve;
    });
    const firstRequest: { value: AuthorityRequest | null } = { value: null };
    const admitTaskMutation = vi.fn(async (request: AuthorityRequest) => {
      if (firstRequest.value === null) {
        firstRequest.value = request;
        return firstResult;
      }
      return Object.freeze({
        kind: 'idempotent_replay' as const,
        currentSourceGeneration: request.command.expectedSourceGeneration,
        payloadFingerprint: request.payloadFingerprint,
        receipt: Object.freeze({
          schemaVersion: 1 as const,
          outcome: 'idempotent_replay' as const,
          commandId: request.command.commandId,
          teamId,
          sourceGeneration: request.command.expectedSourceGeneration,
          revision: replacementRevision,
          affectedTaskIds: Object.freeze([taskA]),
        }),
      });
    });
    const adapter = new HostedTaskBoardMutationAuthorityAdapter({ admitTaskMutation }, () => 10);

    const first = adapter.admit(command, context());
    const retry = adapter.admit(command, context());
    await vi.waitFor(() => expect(admitTaskMutation).toHaveBeenCalledOnce());
    const request = firstRequest.value;
    if (request === null) throw new Error('hosted-task-board-first-admission-was-not-issued');
    resolveFirst(
      Object.freeze({
        kind: 'committed',
        currentSourceGeneration: request.command.expectedSourceGeneration,
        payloadFingerprint: request.payloadFingerprint,
        receipt: Object.freeze({
          schemaVersion: 1,
          outcome: 'committed',
          commandId: request.command.commandId,
          teamId,
          sourceGeneration: request.command.expectedSourceGeneration,
          revision: replacementRevision,
          affectedTaskIds: Object.freeze([taskA]),
        }),
      })
    );

    await expect(first).resolves.toMatchObject({ kind: 'committed' });
    await expect(retry).resolves.toMatchObject({ kind: 'idempotent_replay' });
    expect(admitTaskMutation).toHaveBeenCalledTimes(2);
  });

  it('bounds the replay ledger with deterministic least-recently-verified eviction', async () => {
    const replayLedgerCapacity = 512;
    const commands = Array.from({ length: replayLedgerCapacity + 1 }, (_, index) =>
      Object.freeze({
        ...mutationCommand(),
        commandId: parseHostedTaskCommandId(`command_authority-mutation-${index}`),
        idempotencyKey: parseHostedTaskIdempotencyKey(`authority-mutation-key-${index}`),
      })
    );
    const admitTaskMutation = vi.fn(
      async (
        request: Parameters<NonNullable<HostedTaskBoardAuthorityPort['admitTaskMutation']>>[0]
      ) =>
        Object.freeze({
          kind: 'idempotent_replay' as const,
          currentSourceGeneration: request.command.expectedSourceGeneration,
          payloadFingerprint: request.payloadFingerprint,
          receipt: Object.freeze({
            schemaVersion: 1 as const,
            outcome: 'idempotent_replay' as const,
            commandId: request.command.commandId,
            teamId,
            sourceGeneration: request.command.expectedSourceGeneration,
            revision: replacementRevision,
            affectedTaskIds: Object.freeze([taskA]),
          }),
        })
    );
    const adapter = new HostedTaskBoardMutationAuthorityAdapter({ admitTaskMutation }, () => 10);

    for (const command of commands.slice(0, -1)) {
      await expect(adapter.admit(command, context())).resolves.toMatchObject({
        kind: 'idempotent_replay',
      });
    }
    await expect(adapter.admit(commands[0]!, context())).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    await expect(adapter.admit(commands.at(-1)!, context())).resolves.toMatchObject({
      kind: 'idempotent_replay',
    });
    await expect(adapter.admit({ ...commands[0]!, status: 'pending' }, context())).resolves.toEqual(
      { kind: 'conflict', reason: 'idempotency_mismatch' }
    );

    const ledger = replayLedgerForTest(adapter);
    expect(ledger.size).toBe(replayLedgerCapacity);
    expect([...ledger.values()].map((entry) => entry.receipt.commandId)).toEqual([
      ...commands.slice(2, -1).map((command) => command.commandId),
      commands[0]!.commandId,
      commands.at(-1)!.commandId,
    ]);
  });

  it('fails closed on widened outcomes', async () => {
    const command = mutationCommand();
    const widenedAdapter = new HostedTaskBoardMutationAuthorityAdapter(
      {
        admitTaskMutation: vi.fn(async () =>
          Object.freeze({
            kind: 'conflict' as const,
            reason: 'state_conflict' as const,
            currentSourceGeneration: generation,
            currentRevision: replacementRevision,
            rawError: '/private/path',
          })
        ),
      },
      () => 10
    );
    await expect(widenedAdapter.admit(command, context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('rejects stale-equivalent revisions, unsupported outcomes, and expired contexts before a write', async () => {
    const command = mutationCommand();
    const admitTaskMutation = vi.fn(async () =>
      Object.freeze({
        kind: 'stale_revision' as const,
        currentSourceGeneration: generation,
        currentRevision: revision,
      })
    );
    const adapter = new HostedTaskBoardMutationAuthorityAdapter({ admitTaskMutation }, () => 10);

    await expect(adapter.admit(command, context())).resolves.toEqual({ kind: 'unavailable' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(adapter.admit(command, context(1_000, aborted.signal))).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(admitTaskMutation).toHaveBeenCalledOnce();
  });
});
