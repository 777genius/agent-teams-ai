import { parseCursor, parseTeamId, type QueryContext } from '@shared/contracts/hosted';

import {
  type GetHostedTeamApprovalPageResult,
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalItem,
  parseHostedTeamApprovalPageRequest,
} from '../../../contracts/hosted';
import {
  HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_PAGE_TIME_MS,
  HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS,
  normalizeHostedTeamApprovalItem,
  normalizeHostedTeamApprovalRetryAfterMs,
} from '../models/HostedTeamApprovalModels';

import type {
  HostedTeamApprovalClockPort,
  HostedTeamApprovalPageCandidate,
  HostedTeamApprovalPageSourcePort,
} from '../ports/HostedTeamApprovalPorts';

interface NormalizedCandidate {
  readonly item: HostedTeamApprovalItem;
  readonly cursorAfter: ReturnType<typeof parseCursor>;
  readonly bytes: number;
}

function unavailable(retryAfterMs?: number): GetHostedTeamApprovalPageResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function normalizeCandidates(
  candidates: readonly HostedTeamApprovalPageCandidate[],
  expectedTeamId: ReturnType<typeof parseTeamId>,
  requestCursor: ReturnType<typeof parseCursor> | null
): readonly NormalizedCandidate[] | null {
  try {
    const cursors = new Set<string>();
    const approvalIds = new Set<string>();
    const normalized: NormalizedCandidate[] = [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') return null;
      const item = normalizeHostedTeamApprovalItem(candidate.item, expectedTeamId);
      const cursorAfter = parseCursor(candidate.cursorAfter);
      if (
        item === null ||
        cursorAfter === requestCursor ||
        cursors.has(cursorAfter) ||
        approvalIds.has(item.approvalId)
      ) {
        return null;
      }
      cursors.add(cursorAfter);
      approvalIds.add(item.approvalId);
      normalized.push(
        Object.freeze({
          item,
          cursorAfter,
          bytes: new TextEncoder().encode(JSON.stringify(item)).byteLength,
        })
      );
    }
    return Object.freeze(normalized);
  } catch {
    return null;
  }
}

export class GetHostedTeamApprovalPage {
  constructor(
    private readonly source: HostedTeamApprovalPageSourcePort,
    private readonly clock: HostedTeamApprovalClockPort
  ) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<GetHostedTeamApprovalPageResult> {
    const request = parseHostedTeamApprovalPageRequest(requestValue);
    if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });

    const startedAtMs = this.clock.now();
    const deadlineAtMs = Math.min(
      context.deadlineAtMs,
      startedAtMs + HOSTED_TEAM_APPROVAL_MAX_PAGE_TIME_MS
    );

    try {
      const result = await this.source.readPage(
        Object.freeze({
          teamId: request.value.teamId,
          cursor: request.value.cursor,
          itemLimit: Math.min(request.value.limit + 1, HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS),
          byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
          deadlineAtMs,
        }),
        context
      );
      if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });
      if (result.kind === 'not_found') return Object.freeze({ kind: 'not_found' });
      if (result.kind === 'unavailable') {
        return unavailable(normalizeHostedTeamApprovalRetryAfterMs(result.retryAfterMs));
      }
      if (
        result.kind !== 'found' ||
        parseTeamId(result.teamId) !== request.value.teamId ||
        !Array.isArray(result.candidates) ||
        result.candidates.length > HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS ||
        typeof result.hasMore !== 'boolean'
      ) {
        return unavailable();
      }
      const candidates = normalizeCandidates(
        result.candidates,
        request.value.teamId,
        request.value.cursor
      );
      if (candidates === null) return unavailable();

      const selected: NormalizedCandidate[] = [];
      let usedBytes = 0;
      for (const candidate of candidates) {
        if (
          selected.length >= request.value.limit ||
          usedBytes + candidate.bytes > HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES ||
          this.clock.now() >= deadlineAtMs
        ) {
          break;
        }
        selected.push(candidate);
        usedBytes += candidate.bytes;
      }

      const truncated = selected.length < candidates.length || result.hasMore;
      const nextCursor = truncated ? (selected.at(-1)?.cursorAfter ?? null) : null;
      if (truncated && nextCursor === null) return unavailable();

      return Object.freeze({
        kind: 'success',
        page: Object.freeze({
          schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
          kind: 'approval_page',
          teamId: request.value.teamId,
          items: Object.freeze(selected.map(({ item }) => item)),
          nextCursor,
          truncated,
          budget: Object.freeze({
            itemLimit: request.value.limit,
            byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
            timeLimitMs: HOSTED_TEAM_APPROVAL_MAX_PAGE_TIME_MS,
            usedItems: selected.length,
            usedBytes,
            elapsedMs: Math.max(0, this.clock.now() - startedAtMs),
          }),
        }),
      });
    } catch {
      return unavailable();
    }
  }
}
