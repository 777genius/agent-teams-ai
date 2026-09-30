import {
  parseCursor,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';

import {
  type GetHostedTaskBoardPageResult,
  HOSTED_TASK_BOARD_DEGRADED_REASONS,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  HOSTED_TASK_BOARD_TRUNCATION_REASONS,
  type HostedTaskBoardDegradedReason,
  type HostedTaskBoardItem,
  type HostedTaskBoardTruncationReason,
  parseHostedTaskBoardSourceGeneration,
} from '../../../contracts/hosted';
import {
  HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
  HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
  HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS,
  HostedTaskBoardBudget,
} from '../../domain/models/HostedTaskBoardBudget';
import {
  isHostedTaskBoardDegradedReasons,
  normalizeHostedTaskBoardItems,
  parseHostedTaskBoardPageRequest,
} from '../../domain/policies/hostedTaskBoardPolicy';

import type {
  HostedTaskBoardClockPort,
  HostedTaskBoardPageCandidate,
  HostedTaskBoardPageSourcePort,
} from '../ports/HostedTeamTaskBoardPorts';

interface OrderedCandidate {
  readonly item: HostedTaskBoardItem;
  readonly cursorAfter: ReturnType<typeof parseCursor>;
}

function unavailable(retryAfterMs?: number): GetHostedTaskBoardPageResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}

function normalizeTruncationReason(value: unknown): HostedTaskBoardTruncationReason | null {
  if (value === null) return null;
  return HOSTED_TASK_BOARD_TRUNCATION_REASONS.includes(value as HostedTaskBoardTruncationReason)
    ? (value as HostedTaskBoardTruncationReason)
    : null;
}

function normalizeCandidates(
  candidates: readonly HostedTaskBoardPageCandidate[],
  expectedTeamId: ReturnType<typeof parseTeamId>,
  requestCursor: ReturnType<typeof parseCursor> | null
): readonly OrderedCandidate[] | null {
  const normalizedItems = normalizeHostedTaskBoardItems(
    candidates.map((candidate) => candidate.item),
    expectedTeamId
  );
  if (!normalizedItems.ok) return null;

  try {
    const normalized = normalizedItems.value.map((item, index) =>
      Object.freeze({ item, cursorAfter: parseCursor(candidates[index].cursorAfter) })
    );
    const cursors = normalized.map(({ cursorAfter }) => cursorAfter);
    if (
      new Set(cursors).size !== cursors.length ||
      (requestCursor !== null && cursors.includes(requestCursor))
    ) {
      return null;
    }
    return Object.freeze(normalized);
  } catch {
    return null;
  }
}

function orderedReasons<T extends string>(values: Iterable<T>, order: readonly T[]): readonly T[] {
  const rank = new Map(order.map((value, index) => [value, index]));
  return Object.freeze(
    [...new Set(values)].sort((left, right) => (rank.get(left) ?? 999) - (rank.get(right) ?? 999))
  );
}

export class GetHostedTaskBoardPage {
  constructor(
    private readonly source: HostedTaskBoardPageSourcePort,
    private readonly clock: HostedTaskBoardClockPort
  ) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<GetHostedTaskBoardPageResult> {
    const request = parseHostedTaskBoardPageRequest(requestValue);
    if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });

    const startedAtMs = this.clock.now();
    const deadlineAtMs = Math.min(
      context.deadlineAtMs,
      startedAtMs + HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS
    );

    try {
      const sourceResult = await this.source.readPage(
        Object.freeze({
          teamId: request.value.teamId,
          cursor: request.value.cursor,
          expectedSourceGeneration: request.value.expectedSourceGeneration,
          itemLimit: Math.min(request.value.limit + 1, HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS),
          byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
          deadlineAtMs,
        }),
        context
      );
      if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });

      if (sourceResult.kind === 'not_found') return Object.freeze({ kind: 'not_found' });
      if (sourceResult.kind === 'unavailable') {
        return unavailable(validRetryAfterMs(sourceResult.retryAfterMs));
      }
      if (sourceResult.kind === 'stale_generation') {
        const currentSourceGeneration = parseHostedTaskBoardSourceGeneration(
          sourceResult.currentSourceGeneration
        );
        if (
          request.value.expectedSourceGeneration === null ||
          currentSourceGeneration === request.value.expectedSourceGeneration
        ) {
          return unavailable();
        }
        return Object.freeze({ kind: sourceResult.kind, currentSourceGeneration });
      }
      if (sourceResult.kind !== 'found') return unavailable();

      const teamId = parseTeamId(sourceResult.teamId);
      if (teamId !== request.value.teamId) return unavailable();
      const sourceGeneration = parseHostedTaskBoardSourceGeneration(sourceResult.sourceGeneration);
      if (
        request.value.expectedSourceGeneration !== null &&
        sourceGeneration !== request.value.expectedSourceGeneration
      ) {
        return Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: sourceGeneration,
        });
      }
      const revision = parseRevision(sourceResult.revision);
      if (
        !Array.isArray(sourceResult.candidates) ||
        sourceResult.candidates.length > HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS ||
        typeof sourceResult.hasMore !== 'boolean' ||
        !isHostedTaskBoardDegradedReasons(sourceResult.degradedReasons)
      ) {
        return unavailable();
      }
      const sourceTruncation = normalizeTruncationReason(sourceResult.truncatedBy);
      if (sourceResult.truncatedBy !== null && sourceTruncation === null) return unavailable();

      const candidates = normalizeCandidates(sourceResult.candidates, teamId, request.value.cursor);
      if (candidates === null) return unavailable();

      const budget = new HostedTaskBoardBudget({
        itemLimit: request.value.limit,
        byteLimit: HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
        timeLimitMs: HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
        startedAtMs,
      });
      const selected: OrderedCandidate[] = [];
      for (const candidate of candidates) {
        if (!budget.admit(candidate.item, this.clock.now())) break;
        selected.push(candidate);
      }

      if (selected.length === 0 && (candidates.length > 0 || sourceResult.hasMore)) {
        return unavailable();
      }
      if (selected.length < candidates.length) {
        const reason =
          selected.length >= request.value.limit
            ? 'item_budget'
            : (budget.truncationReasons()[0] ?? 'source_budget');
        budget.mark(reason);
      }
      if (sourceResult.hasMore && sourceTruncation !== null) {
        budget.mark(sourceTruncation);
      } else if (sourceResult.hasMore && selected.length === candidates.length) {
        budget.mark('source_budget');
      }

      const truncationReasons = orderedReasons(
        budget.truncationReasons(),
        HOSTED_TASK_BOARD_TRUNCATION_REASONS
      );
      const truncated = truncationReasons.length > 0 || sourceResult.hasMore;
      const nextCursor = truncated ? (selected.at(-1)?.cursorAfter ?? null) : null;
      if (truncated && nextCursor === null) return unavailable();

      const degradedReasons = new Set<HostedTaskBoardDegradedReason>(sourceResult.degradedReasons);
      if (truncationReasons.includes('byte_budget') || truncationReasons.includes('time_budget')) {
        degradedReasons.add('budget_exhausted');
      }

      return Object.freeze({
        kind: 'success',
        page: Object.freeze({
          schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
          kind: 'task_board_page',
          teamId,
          sourceGeneration,
          revision,
          items: Object.freeze(selected.map(({ item }) => item)),
          nextCursor,
          truncated,
          truncationReasons,
          degraded: Object.freeze({
            active: degradedReasons.size > 0,
            reasons: orderedReasons(degradedReasons, HOSTED_TASK_BOARD_DEGRADED_REASONS),
          }),
          budget: budget.metadata(this.clock.now()),
        }),
      });
    } catch {
      return unavailable();
    }
  }
}
