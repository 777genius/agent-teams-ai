import { parseCursor, parseTeamId, type QueryContext, type TeamId } from '@shared/contracts/hosted';

import {
  type GetHostedMessagePageResult,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  type HostedTeamMessage,
  parseHostedMessageSourceGeneration,
} from '../../../contracts/hosted';
import {
  HOSTED_MESSAGE_MAX_SOURCE_ITEMS,
  normalizeHostedTeamMessages,
  parseHostedMessagePageRequest,
  parseHostedMessageRevision,
} from '../../domain/hostedMessagePolicy';

import type {
  HostedMessageClockPort,
  HostedMessagePageCandidate,
  HostedMessagePageSourcePort,
} from '../ports/HostedTeamMessagePorts';

const HOSTED_MESSAGE_PAGE_TIMEOUT_MS = 250;

interface OrderedCandidate {
  readonly message: HostedTeamMessage;
  readonly cursorAfter: ReturnType<typeof parseCursor>;
}

function unavailable(retryAfterMs?: number): GetHostedMessagePageResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}

function normalizeCandidates(
  value: readonly HostedMessagePageCandidate[],
  expectedTeamId: TeamId,
  requestCursor: ReturnType<typeof parseCursor> | null
): readonly OrderedCandidate[] | null {
  const messages = normalizeHostedTeamMessages(
    value.map((candidate) => candidate.message),
    expectedTeamId
  );
  if (!messages.ok) return null;
  try {
    const candidates = messages.value.map((message, index) =>
      Object.freeze({ message, cursorAfter: parseCursor(value[index].cursorAfter) })
    );
    const cursors = candidates.map((candidate) => candidate.cursorAfter);
    if (
      new Set(cursors).size !== cursors.length ||
      (requestCursor !== null && cursors.includes(requestCursor))
    ) {
      return null;
    }
    return Object.freeze(candidates);
  } catch {
    return null;
  }
}

/** Produces a cursor-safe page without sorting or deriving order from opaque identifiers. */
export class GetHostedMessagePage {
  constructor(
    private readonly source: HostedMessagePageSourcePort,
    private readonly clock: HostedMessageClockPort
  ) {}

  async execute(requestValue: unknown, context: QueryContext): Promise<GetHostedMessagePageResult> {
    const request = parseHostedMessagePageRequest(requestValue);
    if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });

    try {
      const startedAtMs = this.clock.now();
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) return unavailable();
      const deadlineAtMs = Math.min(
        context.deadlineAtMs,
        startedAtMs + HOSTED_MESSAGE_PAGE_TIMEOUT_MS
      );
      if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= startedAtMs) return unavailable();
      const itemLimit = Math.min(request.value.limit + 1, HOSTED_MESSAGE_MAX_SOURCE_ITEMS);
      const sourceResult = await this.source.readPage(
        Object.freeze({
          teamId: request.value.teamId,
          cursor: request.value.cursor,
          expectedSourceGeneration: request.value.expectedSourceGeneration,
          itemLimit,
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
        const currentSourceGeneration = parseHostedMessageSourceGeneration(
          sourceResult.currentSourceGeneration
        );
        if (
          request.value.expectedSourceGeneration === null ||
          currentSourceGeneration === request.value.expectedSourceGeneration
        ) {
          return unavailable();
        }
        return Object.freeze({ kind: 'stale_generation', currentSourceGeneration });
      }
      if (sourceResult.kind !== 'found') return unavailable();

      const teamId = parseTeamId(sourceResult.teamId);
      if (teamId !== request.value.teamId) return unavailable();
      const sourceGeneration = parseHostedMessageSourceGeneration(sourceResult.sourceGeneration);
      if (
        request.value.expectedSourceGeneration !== null &&
        sourceGeneration !== request.value.expectedSourceGeneration
      ) {
        return Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: sourceGeneration,
        });
      }
      if (
        !Array.isArray(sourceResult.candidates) ||
        sourceResult.candidates.length > itemLimit ||
        typeof sourceResult.hasMore !== 'boolean'
      ) {
        return unavailable();
      }
      const candidates = normalizeCandidates(sourceResult.candidates, teamId, request.value.cursor);
      if (candidates === null || (sourceResult.hasMore && candidates.length === 0)) {
        return unavailable();
      }

      const selected = candidates.slice(0, request.value.limit);
      const hasMore = sourceResult.hasMore || selected.length < candidates.length;
      const nextCursor = hasMore ? (selected.at(-1)?.cursorAfter ?? null) : null;
      if (hasMore && nextCursor === null) return unavailable();

      return Object.freeze({
        kind: 'success',
        page: Object.freeze({
          schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
          kind: 'message_page',
          teamId,
          sourceGeneration,
          revision: parseHostedMessageRevision(sourceResult.revision),
          messages: Object.freeze(selected.map(({ message }) => message)),
          nextCursor,
        }),
      });
    } catch {
      return unavailable();
    }
  }
}
