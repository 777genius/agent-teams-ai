import {
  HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
  HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS,
} from '@features/team-task-board/core/domain/models/HostedTaskBoardBudget';
import {
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  HostedTaskBoardAuthorityAdapter,
  type HostedTaskBoardAuthorityCompareAndCommitResult,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  type HostedTaskBoardItem,
  type HostedTaskMutationCommand,
  type HostedTaskMutationReceipt,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskCommandId,
  parseHostedTaskId,
  parseHostedTaskIdempotencyKey,
  type TaskId,
} from '@features/team-task-board/main/hosted';
import {
  createQueryContext,
  parseBootId,
  parseCursor,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTaskBoardPageSourceRequest,
  HostedTaskMutationAdmissionResult,
} from '@features/team-task-board/main/hosted';

const teamId = parseTeamId('team_00000000000000000000000000000001');
const otherTeamId = parseTeamId('team_00000000000000000000000000000002');
const taskA = parseHostedTaskId('task_00000000000000000000000000000001');
const taskB = parseHostedTaskId('task_00000000000000000000000000000002');
const generation = parseHostedTaskBoardSourceGeneration('generation_authority-1');
const replacementGeneration = parseHostedTaskBoardSourceGeneration('generation_authority-2');
const revision = parseRevision('revision_authority-1');
const committedRevision = parseRevision('revision_authority-2');

type RelationshipCommand = Extract<HostedTaskMutationCommand, { kind: 'update_relationship' }>;
type CommittedReceipt = Extract<HostedTaskMutationReceipt, { outcome: 'committed' }>;
type ReplayReceipt = Extract<HostedTaskMutationReceipt, { outcome: 'idempotent_replay' }>;

function context(deadlineAtMs = 1_000, signal = new AbortController().signal): QueryContext {
  return createQueryContext({
    actorId: 'actor_task-board-authority',
    sessionId: 'session_task-board-authority',
    deploymentId: 'deployment_task-board-authority',
    bootId: parseBootId('boot_task-board-authority'),
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

function updateRelationshipCommand(
  overrides: Partial<RelationshipCommand> = {}
): RelationshipCommand {
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    kind: 'update_relationship',
    commandId: parseHostedTaskCommandId('command_authority-1'),
    idempotencyKey: parseHostedTaskIdempotencyKey('idempotency-authority-1'),
    teamId,
    expectedSourceGeneration: generation,
    expectedRevision: revision,
    action: 'add',
    taskId: taskA,
    otherTaskId: taskB,
    relationship: 'related',
    ...overrides,
  });
}

function receipt(outcome: 'committed', overrides?: Partial<CommittedReceipt>): CommittedReceipt;
function receipt(outcome: 'idempotent_replay', overrides?: Partial<ReplayReceipt>): ReplayReceipt;
function receipt(
  outcome: HostedTaskMutationReceipt['outcome'],
  overrides?: Partial<HostedTaskMutationReceipt>
): HostedTaskMutationReceipt;
function receipt(
  outcome: HostedTaskMutationReceipt['outcome'],
  overrides: Partial<HostedTaskMutationReceipt> = {}
): HostedTaskMutationReceipt {
  return Object.freeze({
    schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
    outcome,
    commandId: parseHostedTaskCommandId('command_authority-1'),
    teamId,
    sourceGeneration: generation,
    revision: committedRevision,
    affectedTaskIds: Object.freeze([taskA, taskB]),
    ...overrides,
  } as HostedTaskMutationReceipt);
}

function authority(readResult: unknown, commitResult: unknown = { kind: 'not_found' }) {
  const readWindow = vi.fn(
    async (_request: HostedTaskBoardAuthorityReadWindowRequest, _context: QueryContext) =>
      readResult as HostedTaskBoardAuthorityReadWindowResult
  );
  const compareAndCommit = vi.fn(
    async (_command: HostedTaskMutationCommand, _context: QueryContext) =>
      commitResult as HostedTaskBoardAuthorityCompareAndCommitResult
  );
  return { authority: { readWindow, compareAndCommit }, readWindow, compareAndCommit };
}

describe('HostedTaskBoardAuthorityAdapter reads', () => {
  it('preserves authority order, emits exact task-bound cursors, and propagates QueryContext', async () => {
    const relatedA = item(taskA, { relatedTaskIds: Object.freeze([taskB]), order: 9 });
    const relatedB = item(taskB, { relatedTaskIds: Object.freeze([taskA]), order: 1 });
    const harness = authority(found([relatedA, relatedB]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
    const queryContext = context();

    const result = await adapter.readPage(readRequest(), queryContext);

    expect(result).toEqual({
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
    expect(harness.readWindow.mock.calls[0]?.[1]).toBe(queryContext);
  });

  it('decodes only exact cursor_<TaskId> continuations before authority access', async () => {
    const harness = authority(found([item(taskB)]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);

    const result = await adapter.readPage(
      readRequest({
        cursor: parseCursor(`cursor_${taskA}`),
        expectedSourceGeneration: generation,
      }),
      context()
    );

    expect(result.kind).toBe('found');
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

  it('maps bounded stable authority failures and rejects false stale-generation claims', async () => {
    const queryContext = context();
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
      [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      [{ kind: 'stale_generation', currentSourceGeneration: generation }, { kind: 'unavailable' }],
      [
        { kind: 'stale_generation', currentSourceGeneration: replacementGeneration, receipt: {} },
        { kind: 'unavailable' },
      ],
      [{ kind: 'unavailable', retryAfterMs: 60_001 }, { kind: 'unavailable' }],
    ];

    for (const [authorityResult, expected] of cases) {
      const harness = authority(authorityResult);
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      const result = await adapter.readPage(
        readRequest({
          cursor: parseCursor(`cursor_${taskA}`),
          expectedSourceGeneration: generation,
        }),
        queryContext
      );
      expect(result).toEqual(expected);
    }
  });

  it('fails closed on team, revision, uniqueness, byte, symmetry, and cursor-cycle violations', async () => {
    const huge = item(taskA, { description: 'x'.repeat(20_000) });
    const invalidResults: readonly unknown[] = [
      found([item(taskA)], { teamId: otherTeamId }),
      { ...found([item(taskA)]), revision: 'not-a-revision' },
      found([item(taskA), item(taskA)]),
      found([huge]),
      found([item(taskA, { relatedTaskIds: Object.freeze([taskB]) }), item(taskB)]),
      found([item(taskA)]),
    ];

    for (const [index, invalidResult] of invalidResults.entries()) {
      const harness = authority(invalidResult);
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      const continuation = index === invalidResults.length - 1;
      const result = await adapter.readPage(
        readRequest({
          ...(index === 3 ? { byteLimit: 2_100 } : {}),
          ...(continuation
            ? {
                cursor: parseCursor(`cursor_${taskA}`),
                expectedSourceGeneration: generation,
              }
            : {}),
        }),
        context()
      );
      expect(result).toEqual({ kind: 'unavailable' });
    }
  });

  it('validates source bounds, truncation, and degraded metadata without calling wider reads', async () => {
    const tooMany = Array.from({ length: HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS + 1 }, (_, index) =>
      item(parseHostedTaskId(`task_${(index + 10).toString(16).padStart(32, '0')}`))
    );
    const invalidResults: readonly unknown[] = [
      found(tooMany),
      found([], { hasMore: true, truncatedBy: 'source_budget' }),
      found([item(taskA)], { hasMore: false, truncatedBy: 'source_budget' }),
      found([item(taskA)], { hasMore: true, truncatedBy: null }),
      found([item(taskA)], {
        degradedReasons: ['source_partial', 'source_partial'] as never,
      }),
      found([item(taskA)], { degradedReasons: ['private_authority_state'] as never }),
    ];

    for (const invalidResult of invalidResults) {
      const harness = authority(invalidResult);
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      await expect(adapter.readPage(readRequest(), context())).resolves.toEqual({
        kind: 'unavailable',
      });
      expect(harness.readWindow).toHaveBeenCalledTimes(1);
    }

    const harness = authority(found([item(taskA)]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
    await expect(
      adapter.readPage(
        readRequest({ itemLimit: HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS + 1 }),
        context()
      )
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(harness.readWindow).not.toHaveBeenCalled();
  });

  it('fails closed before and after cancellation or deadline expiry', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const harness = authority(found([item(taskA)]));
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);

    await expect(adapter.readPage(readRequest(), context(1_000, aborted.signal))).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(
      adapter.readPage(readRequest({ deadlineAtMs: 1_001 }), context())
    ).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(harness.readWindow).not.toHaveBeenCalled();

    let now = 10;
    const lateAuthority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async (_request, _context) => {
        now = 500;
        return found([item(taskA)]);
      }),
      compareAndCommit: vi.fn(async (_command, _context) => ({ kind: 'not_found' as const })),
    };
    const lateAdapter = new HostedTaskBoardAuthorityAdapter(lateAuthority, () => now);
    await expect(lateAdapter.readPage(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });

    const postAbort = new AbortController();
    const abortingAuthority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async (_request, _context) => {
        postAbort.abort();
        return found([item(taskA)]);
      }),
      compareAndCommit: vi.fn(async (_command, _context) => ({ kind: 'not_found' as const })),
    };
    const abortingAdapter = new HostedTaskBoardAuthorityAdapter(abortingAuthority, () => 10);
    await expect(
      abortingAdapter.readPage(readRequest(), context(1_000, postAbort.signal))
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('HostedTaskBoardAuthorityAdapter mutations', () => {
  it.each(['committed', 'idempotent_replay'] as const)(
    'returns a validated durable %s receipt and propagates exact QueryContext',
    async (outcome) => {
      const command = updateRelationshipCommand();
      const authorityReceipt = receipt(outcome);
      const harness = authority(found([]), { kind: outcome, receipt: authorityReceipt });
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      const queryContext = context();

      const result = await adapter.admit(command, queryContext);

      expect(result).toEqual({ kind: outcome, receipt: authorityReceipt });
      expect(harness.compareAndCommit).toHaveBeenCalledOnce();
      expect(harness.compareAndCommit.mock.calls[0]?.[0]).toEqual(command);
      expect(harness.compareAndCommit.mock.calls[0]?.[1]).toBe(queryContext);
    }
  );

  it('maps every stable non-receipt result and fails closed on contradictory versions', async () => {
    const command = updateRelationshipCommand();
    const cases: readonly [unknown, HostedTaskMutationAdmissionResult][] = [
      [
        { kind: 'stale_generation', currentSourceGeneration: replacementGeneration },
        { kind: 'stale_generation', currentSourceGeneration: replacementGeneration },
      ],
      [
        { kind: 'stale_revision', currentRevision: committedRevision },
        { kind: 'stale_revision', currentRevision: committedRevision },
      ],
      [
        { kind: 'conflict', reason: 'relationship_conflict', currentRevision: revision },
        { kind: 'conflict', reason: 'relationship_conflict', currentRevision: revision },
      ],
      [
        { kind: 'conflict', reason: 'idempotency_mismatch' },
        { kind: 'conflict', reason: 'idempotency_mismatch' },
      ],
      [{ kind: 'not_found' }, { kind: 'not_found' }],
      [{ kind: 'unsafe_active' }, { kind: 'unsafe_active' }],
      [
        { kind: 'unavailable', retryAfterMs: 500 },
        { kind: 'unavailable', retryAfterMs: 500 },
      ],
      [{ kind: 'stale_generation', currentSourceGeneration: generation }, { kind: 'unavailable' }],
      [{ kind: 'stale_revision', currentRevision: revision }, { kind: 'unavailable' }],
      [{ kind: 'conflict', reason: 'private_conflict' }, { kind: 'unavailable' }],
    ];

    for (const [authorityResult, expected] of cases) {
      const harness = authority(found([]), authorityResult);
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      await expect(adapter.admit(command, context())).resolves.toEqual(expected);
    }
  });

  it('rejects non-durable, unbound, unchanged-revision, and asymmetric relationship receipts', async () => {
    const command = updateRelationshipCommand();
    const invalidReceipts: readonly unknown[] = [
      receipt('committed', { commandId: parseHostedTaskCommandId('command_other') }),
      receipt('committed', { teamId: otherTeamId }),
      receipt('committed', { sourceGeneration: replacementGeneration }),
      receipt('committed', { revision }),
      receipt('committed', { affectedTaskIds: Object.freeze([taskA]) }),
      { ...receipt('committed'), durable: false },
    ];

    for (const invalidReceipt of invalidReceipts) {
      const harness = authority(found([]), { kind: 'committed', receipt: invalidReceipt });
      const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
      await expect(adapter.admit(command, context())).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('returns no committed response after cancellation/deadline and relies on durable retry receipt', async () => {
    let now = 10;
    let attempts = 0;
    const authorityPort: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async (_request, _context) => found([])),
      compareAndCommit: vi.fn(async (_command, _context) => {
        attempts += 1;
        if (attempts === 1) {
          now = 1_000;
          return { kind: 'committed' as const, receipt: receipt('committed') };
        }
        return {
          kind: 'idempotent_replay' as const,
          receipt: receipt('idempotent_replay'),
        };
      }),
    };
    const adapter = new HostedTaskBoardAuthorityAdapter(authorityPort, () => now);
    const command = updateRelationshipCommand();

    await expect(adapter.admit(command, context())).resolves.toEqual({ kind: 'unavailable' });
    now = 10;
    await expect(adapter.admit(command, context())).resolves.toEqual({
      kind: 'idempotent_replay',
      receipt: receipt('idempotent_replay'),
    });
    expect(authorityPort.compareAndCommit).toHaveBeenCalledTimes(2);

    const postAbort = new AbortController();
    const abortingAuthority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async (_request, _context) => found([])),
      compareAndCommit: vi.fn(async (_command, _context) => {
        postAbort.abort();
        return { kind: 'committed' as const, receipt: receipt('committed') };
      }),
    };
    const abortingAdapter = new HostedTaskBoardAuthorityAdapter(abortingAuthority, () => 10);
    await expect(abortingAdapter.admit(command, context(1_000, postAbort.signal))).resolves.toEqual(
      { kind: 'unavailable' }
    );
  });

  it('does not call authority for invalid commands or expired contexts and contains authority faults', async () => {
    const harness = authority(found([]), { kind: 'not_found' });
    const adapter = new HostedTaskBoardAuthorityAdapter(harness.authority, () => 10);
    await expect(
      adapter.admit({ ...updateRelationshipCommand(), otherTaskId: taskA }, context())
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(adapter.admit(updateRelationshipCommand(), context(10))).resolves.toEqual({
      kind: 'unavailable',
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      adapter.admit(updateRelationshipCommand(), context(1_000, aborted.signal))
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(harness.compareAndCommit).not.toHaveBeenCalled();

    const throwingAuthority: HostedTaskBoardAuthorityPort = {
      readWindow: vi.fn(async (_request, _context) => {
        throw new Error('private read failure');
      }),
      compareAndCommit: vi.fn(async (_command, _context) => {
        throw new Error('private commit failure');
      }),
    };
    const containingAdapter = new HostedTaskBoardAuthorityAdapter(throwingAuthority, () => 10);
    await expect(containingAdapter.readPage(readRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(containingAdapter.admit(updateRelationshipCommand(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
