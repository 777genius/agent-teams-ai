import {
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
} from '@features/team-task-board/contracts/hosted';
import { GetHostedTaskBoardPage } from '@features/team-task-board/core/application/use-cases/GetHostedTaskBoardPage';
import { HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS } from '@features/team-task-board/core/domain/models/HostedTaskBoardBudget';
import {
  createQueryContext,
  parseCursor,
  parseMemberId,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTaskBoardClockPort,
  HostedTaskBoardPageSourcePort,
  HostedTaskBoardPageSourceRequest,
  HostedTaskBoardPageSourceResult,
} from '@features/team-task-board/core/application/ports/HostedTeamTaskBoardPorts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const revision = parseRevision(`revision_${'b'.repeat(64)}`);
const sourceGeneration = parseHostedTaskBoardSourceGeneration('generation_page-1');
const replacementGeneration = parseHostedTaskBoardSourceGeneration('generation_page-replacement');
const memberId = parseMemberId(`member_${'c'.repeat(32)}`);

function taskId(index: number) {
  return parseHostedTaskId(`task_${index.toString(16).padStart(32, '0')}`);
}

function context(signal = new AbortController().signal) {
  return createQueryContext({
    actorId: 'actor_page-test',
    sessionId: 'session_page-test',
    deploymentId: 'deployment_page-test',
    bootId: 'boot_page-test',
    requestId: 'request_page-test',
    authorizedScope: 'scope_page-test',
    deadlineAtMs: 10_000,
    signal,
  });
}

function item(
  index: number,
  column: 'todo' | 'in_progress' | 'done',
  order: number,
  description: string | null = null
) {
  return {
    teamId,
    taskId: taskId(index),
    subject: `Task ${index}`,
    description,
    status: 'pending' as const,
    ownerId: memberId,
    column,
    order,
    blockedByTaskIds: [],
    blocksTaskIds: [],
    relatedTaskIds: [],
  };
}

function found(
  candidates: { item: ReturnType<typeof item>; cursorAfter: ReturnType<typeof parseCursor> }[],
  overrides: Partial<Extract<HostedTaskBoardPageSourceResult, { kind: 'found' }>> = {}
): Extract<HostedTaskBoardPageSourceResult, { kind: 'found' }> {
  return {
    kind: 'found',
    teamId,
    sourceGeneration,
    revision,
    candidates,
    hasMore: false,
    truncatedBy: null,
    degradedReasons: [],
    ...overrides,
  };
}

function request(
  limit = 2,
  cursor: ReturnType<typeof parseCursor> | null = null,
  expectedSourceGeneration: typeof sourceGeneration | null = null
) {
  return { schemaVersion: 1, teamId, cursor, expectedSourceGeneration, limit };
}

function harness(result: HostedTaskBoardPageSourceResult, clockNow = 0) {
  const source: HostedTaskBoardPageSourcePort = {
    readPage: vi.fn(() => Promise.resolve(result)),
  };
  const clock: HostedTaskBoardClockPort = { now: vi.fn(() => clockNow) };
  return { source, clock, useCase: new GetHostedTaskBoardPage(source, clock) };
}

describe('GetHostedTaskBoardPage', () => {
  it('preserves source C,A,B cursor order across a limit-2 continuation without skipping C', async () => {
    const cursorC = parseCursor('cursor_page-C');
    const cursorA = parseCursor('cursor_page-A');
    const cursorB = parseCursor('cursor_page-B');
    const source: HostedTaskBoardPageSourcePort = {
      readPage: vi.fn((sourceRequest: HostedTaskBoardPageSourceRequest) =>
        Promise.resolve(
          sourceRequest.cursor === null
            ? found([
                { item: item(3, 'in_progress', 0), cursorAfter: cursorC },
                { item: item(1, 'todo', 5), cursorAfter: cursorA },
                { item: item(2, 'todo', 5), cursorAfter: cursorB },
              ])
            : found([{ item: item(2, 'todo', 5), cursorAfter: cursorB }])
        )
      ),
    };
    const useCase = new GetHostedTaskBoardPage(source, { now: () => 0 });

    const first = await useCase.execute(request(), context());

    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.page.items.map(({ taskId: id }) => id)).toEqual([taskId(3), taskId(1)]);
    expect(first.page.nextCursor).toBe(cursorA);
    expect(first.page.truncated).toBe(true);
    expect(first.page.truncationReasons).toEqual(['item_budget']);
    expect(first.page.degraded).toEqual({ active: false, reasons: [] });
    expect(source.readPage).toHaveBeenNthCalledWith(
      1,
      {
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        itemLimit: 3,
        byteLimit: 256 * 1024,
        deadlineAtMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
      },
      expect.any(Object)
    );

    const second = await useCase.execute(
      request(2, first.page.nextCursor, first.page.sourceGeneration),
      context()
    );

    expect(second.kind).toBe('success');
    if (second.kind !== 'success') return;
    expect(second.page.items.map(({ taskId: id }) => id)).toEqual([taskId(2)]);
    expect(second.page.nextCursor).toBeNull();
    expect(source.readPage).toHaveBeenNthCalledWith(
      2,
      {
        teamId,
        cursor: cursorA,
        expectedSourceGeneration: sourceGeneration,
        itemLimit: 3,
        byteLimit: 256 * 1024,
        deadlineAtMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
      },
      expect.any(Object)
    );
    expect([...first.page.items, ...second.page.items].map(({ taskId: id }) => id)).toEqual([
      taskId(3),
      taskId(1),
      taskId(2),
    ]);
  });

  it('strict-parses continuation generation and returns typed stale generation on replacement', async () => {
    const cursor = parseCursor('cursor_page-continuation');
    const invalid = harness(found([]));

    await expect(
      invalid.useCase.execute(
        request(2, cursor, 'generation/invalid' as typeof sourceGeneration),
        context()
      )
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(invalid.source.readPage).not.toHaveBeenCalled();

    const stale = harness({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
    await expect(
      stale.useCase.execute(request(2, cursor, sourceGeneration), context())
    ).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
    expect(stale.source.readPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor,
        expectedSourceGeneration: sourceGeneration,
      }),
      expect.any(Object)
    );

    const aba = harness(
      found([], {
        sourceGeneration: replacementGeneration,
        revision,
      })
    );
    await expect(
      aba.useCase.execute(request(2, cursor, sourceGeneration), context())
    ).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: replacementGeneration,
    });
  });

  it('enforces the response byte budget and exposes bounded degraded metadata', async () => {
    const candidates = Array.from({ length: 14 }, (_, index) => ({
      item: item(index + 1, 'todo', index, 'x'.repeat(20_000)),
      cursorAfter: parseCursor(`cursor_large-${index}`),
    }));
    const { useCase } = harness(found(candidates, { hasMore: true, truncatedBy: 'byte_budget' }));

    const result = await useCase.execute(request(100), context());

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.page.items.length).toBeGreaterThan(0);
    expect(result.page.items.length).toBeLessThan(candidates.length);
    expect(result.page.budget.usedBytes).toBeLessThanOrEqual(result.page.budget.byteLimit);
    expect(result.page.truncationReasons).toContain('byte_budget');
    expect(result.page.degraded).toEqual({
      active: true,
      reasons: ['budget_exhausted'],
    });
  });

  it('admits a non-empty page after 2500ms but fails closed at the 5000ms boundary', async () => {
    const candidate = {
      item: item(1, 'todo', 0),
      cursorAfter: parseCursor('cursor_time-budget-1'),
    };
    let clockNow = 0;
    const source: HostedTaskBoardPageSourcePort = {
      readPage: vi.fn(() => {
        clockNow = 2_500;
        return Promise.resolve(found([candidate]));
      }),
    };
    const clock: HostedTaskBoardClockPort = { now: vi.fn(() => clockNow) };

    const withinBudget = await new GetHostedTaskBoardPage(source, clock).execute(
      request(),
      context()
    );

    expect(withinBudget.kind).toBe('success');
    if (withinBudget.kind !== 'success') return;
    expect(withinBudget.page.items).toHaveLength(1);
    expect(withinBudget.page.budget).toMatchObject({
      timeLimitMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
      elapsedMs: 2_500,
    });

    clockNow = 0;
    const boundarySource: HostedTaskBoardPageSourcePort = {
      readPage: vi.fn(() => {
        clockNow = HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS;
        return Promise.resolve(found([candidate]));
      }),
    };

    await expect(
      new GetHostedTaskBoardPage(boundarySource, clock).execute(request(), context())
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('keeps a byte-budget continuation bound to the observed source generation', async () => {
    const firstCursor = parseCursor('cursor_byte-budget-first');
    const secondCursor = parseCursor('cursor_byte-budget-second');
    const source: HostedTaskBoardPageSourcePort = {
      readPage: vi.fn((sourceRequest: HostedTaskBoardPageSourceRequest) =>
        Promise.resolve(
          sourceRequest.cursor === null
            ? found([{ item: item(1, 'todo', 0), cursorAfter: firstCursor }], {
                hasMore: true,
                truncatedBy: 'byte_budget',
              })
            : found([{ item: item(2, 'todo', 1), cursorAfter: secondCursor }])
        )
      ),
    };
    const useCase = new GetHostedTaskBoardPage(source, { now: () => 0 });

    const initial = await useCase.execute(request(2), context());
    expect(initial.kind).toBe('success');
    if (initial.kind !== 'success') return;
    expect(initial.page.nextCursor).toBe(firstCursor);
    expect(initial.page.truncationReasons).toEqual(['byte_budget']);

    const continued = await useCase.execute(
      request(2, initial.page.nextCursor, initial.page.sourceGeneration),
      context()
    );
    expect(continued.kind).toBe('success');
    if (continued.kind !== 'success') return;
    expect(continued.page.items.map(({ taskId: id }) => id)).toEqual([taskId(2)]);
    expect(continued.page.nextCursor).toBeNull();
    expect(source.readPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: firstCursor,
        expectedSourceGeneration: sourceGeneration,
      }),
      expect.any(Object)
    );
  });

  it('preserves typed source degradation without provider or runtime details', async () => {
    const { useCase } = harness(
      found([{ item: item(1, 'done', 0), cursorAfter: parseCursor('cursor_degraded-1') }], {
        degradedReasons: ['source_reconciling', 'source_stale'],
      })
    );

    const result = await useCase.execute(request(), context());

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.page.degraded).toEqual({
        active: true,
        reasons: ['source_reconciling', 'source_stale'],
      });
      expect(JSON.stringify(result.page)).not.toMatch(/provider|session|runtime|path|error/i);
    }
  });

  it('returns typed missing, unavailable, cancelled and malformed-source outcomes', async () => {
    const missing = harness({ kind: 'not_found' }).useCase;
    await expect(missing.execute(request(), context())).resolves.toEqual({
      kind: 'not_found',
    });

    const unavailable = harness({ kind: 'unavailable', retryAfterMs: 500 }).useCase;
    await expect(unavailable.execute(request(), context())).resolves.toEqual({
      kind: 'unavailable',
      retryAfterMs: 500,
    });

    const aborted = new AbortController();
    aborted.abort();
    const cancelledHarness = harness(found([]));
    await expect(
      cancelledHarness.useCase.execute(request(), context(aborted.signal))
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(cancelledHarness.source.readPage).not.toHaveBeenCalled();

    const malformed = harness(
      found([
        {
          item: { ...item(1, 'todo', 0), projectPath: '/private' },
          cursorAfter: parseCursor('cursor_invalid-1'),
        },
      ] as never)
    ).useCase;
    await expect(malformed.execute(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('contains thrown source errors and never returns their text', async () => {
    const source: HostedTaskBoardPageSourcePort = {
      readPage: vi.fn(() => Promise.reject(new Error('token=/private/provider-secret'))),
    };
    const useCase = new GetHostedTaskBoardPage(source, { now: () => 0 });

    const result = await useCase.execute(request(), context());

    expect(result).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(source.readPage).toHaveBeenCalledOnce();
  });
});
