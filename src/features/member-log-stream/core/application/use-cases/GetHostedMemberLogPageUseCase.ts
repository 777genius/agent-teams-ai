import {
  parseCursor,
  parseMemberId,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';

import {
  type GetHostedMemberLogPageResult,
  HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
  HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
  HOSTED_MEMBER_LOG_MAX_SOURCE_ITEMS,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  HOSTED_MEMBER_LOG_TRUNCATION_REASONS,
  type HostedMemberLogEntry,
  type HostedMemberLogPage,
  hostedMemberLogPageByteLength,
  type HostedMemberLogTruncationReason,
  parseHostedMemberLogPageRequest,
  parseHostedMemberLogSelectionId,
  parseHostedMemberLogSourceGeneration,
  redactHostedMemberLogEntry,
} from '../../../contracts/hosted';

import type {
  HostedMemberLogAuthorityCandidate,
  HostedMemberLogAuthorityPort,
  HostedMemberLogClockPort,
} from '../ports/HostedMemberLogPorts';

interface OrderedCandidate {
  readonly entry: HostedMemberLogEntry;
  readonly cursorAfter: ReturnType<typeof parseCursor>;
}

interface PageInput {
  readonly selectionId: HostedMemberLogPage['selectionId'];
  readonly teamId: HostedMemberLogPage['teamId'];
  readonly memberId: HostedMemberLogPage['memberId'];
  readonly sourceGeneration: HostedMemberLogPage['sourceGeneration'];
  readonly revision: HostedMemberLogPage['revision'];
  readonly entries: readonly HostedMemberLogEntry[];
  readonly nextCursor: HostedMemberLogPage['nextCursor'];
  readonly truncated: boolean;
  readonly truncationReasons: readonly HostedMemberLogTruncationReason[];
  readonly itemLimit: number;
  readonly elapsedMs: number;
}

function unavailable(retryAfterMs?: number): GetHostedMemberLogPageResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 60_000
    ? (value as number)
    : undefined;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function normalizeCandidates(
  value: readonly HostedMemberLogAuthorityCandidate[],
  expectedTeamId: ReturnType<typeof parseTeamId>,
  expectedMemberId: ReturnType<typeof parseMemberId>,
  requestCursor: ReturnType<typeof parseCursor> | null,
  itemLimit: number
): readonly OrderedCandidate[] | null {
  if (!Array.isArray(value) || value.length > itemLimit) return null;
  try {
    const seenEntryIds = new Set<string>();
    const seenCursors = new Set<string>();
    const candidates: OrderedCandidate[] = [];
    for (const candidate of value) {
      if (!isRecord(candidate) || !hasExactKeys(candidate, ['entry', 'cursorAfter'])) return null;
      const entry = redactHostedMemberLogEntry(candidate.entry, expectedTeamId, expectedMemberId);
      const cursorAfter = parseCursor(candidate.cursorAfter);
      if (
        seenEntryIds.has(entry.entryId) ||
        seenCursors.has(cursorAfter) ||
        (requestCursor !== null && cursorAfter === requestCursor)
      ) {
        return null;
      }
      seenEntryIds.add(entry.entryId);
      seenCursors.add(cursorAfter);
      candidates.push(Object.freeze({ entry, cursorAfter }));
    }
    return Object.freeze(candidates);
  } catch {
    return null;
  }
}

function orderedReasons(values: Iterable<HostedMemberLogTruncationReason>) {
  const rank = new Map(HOSTED_MEMBER_LOG_TRUNCATION_REASONS.map((value, index) => [value, index]));
  return Object.freeze(
    [...new Set(values)].sort((left, right) => (rank.get(left) ?? 999) - (rank.get(right) ?? 999))
  );
}

/** Builds a page whose reported usage is a fixed point of its complete serialized JSON envelope. */
function pageWithMeasuredBudget(input: PageInput): HostedMemberLogPage | null {
  let usedBytes = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const page = Object.freeze({
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'member_log_page' as const,
      selectionId: input.selectionId,
      teamId: input.teamId,
      memberId: input.memberId,
      sourceGeneration: input.sourceGeneration,
      revision: input.revision,
      entries: Object.freeze([...input.entries]),
      nextCursor: input.nextCursor,
      truncated: input.truncated,
      truncationReasons: Object.freeze([...input.truncationReasons]),
      budget: Object.freeze({
        itemLimit: input.itemLimit,
        byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
        timeLimitMs: HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
        usedItems: input.entries.length,
        usedBytes,
        elapsedMs: input.elapsedMs,
      }),
    });
    const measuredBytes = hostedMemberLogPageByteLength(page);
    if (
      !Number.isSafeInteger(measuredBytes) ||
      measuredBytes < 0 ||
      measuredBytes > HOSTED_MEMBER_LOG_MAX_PAGE_BYTES
    ) {
      return null;
    }
    if (measuredBytes === usedBytes) return page;
    usedBytes = measuredBytes;
  }
  return null;
}

/**
 * Reads one opaque, bounded hosted member-log page through a server-trusted authority. The request
 * carries only an opaque selection id; the authority, never the browser, binds it to team/member.
 */
export class GetHostedMemberLogPageUseCase {
  constructor(
    private readonly authority: HostedMemberLogAuthorityPort,
    private readonly clock: HostedMemberLogClockPort
  ) {}

  async execute(
    requestValue: unknown,
    context: QueryContext
  ): Promise<GetHostedMemberLogPageResult> {
    const request = parseHostedMemberLogPageRequest(requestValue);
    if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
    if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });

    try {
      const startedAtMs = this.clock.now();
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) return unavailable();
      const deadlineAtMs = Math.min(
        context.deadlineAtMs,
        startedAtMs + HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS
      );
      if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= startedAtMs) return unavailable();

      const itemLimit = Math.min(request.value.limit + 1, HOSTED_MEMBER_LOG_MAX_SOURCE_ITEMS);
      const authorityResult = await this.authority.readPage(
        Object.freeze({
          selectionId: request.value.selectionId,
          cursor: request.value.cursor,
          expectedSourceGeneration: request.value.expectedSourceGeneration,
          itemLimit,
          byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
          deadlineAtMs,
        }),
        context
      );
      if (context.signal.aborted) return Object.freeze({ kind: 'cancelled' });
      if (this.clock.now() >= deadlineAtMs) return unavailable();

      if (authorityResult.kind === 'not_found') return Object.freeze({ kind: 'not_found' });
      if (authorityResult.kind === 'unavailable') {
        return unavailable(validRetryAfterMs(authorityResult.retryAfterMs));
      }
      if (authorityResult.kind === 'stale_generation') {
        const currentSourceGeneration = parseHostedMemberLogSourceGeneration(
          authorityResult.currentSourceGeneration
        );
        if (
          request.value.expectedSourceGeneration === null ||
          currentSourceGeneration === request.value.expectedSourceGeneration
        ) {
          return unavailable();
        }
        return Object.freeze({ kind: 'stale_generation', currentSourceGeneration });
      }
      if (authorityResult.kind !== 'found') return unavailable();

      if (
        parseHostedMemberLogSelectionId(authorityResult.selectionId) !== request.value.selectionId
      ) {
        return unavailable();
      }
      const teamId = parseTeamId(authorityResult.teamId);
      const memberId = parseMemberId(authorityResult.memberId);
      const sourceGeneration = parseHostedMemberLogSourceGeneration(
        authorityResult.sourceGeneration
      );
      if (
        request.value.expectedSourceGeneration !== null &&
        sourceGeneration !== request.value.expectedSourceGeneration
      ) {
        return Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: sourceGeneration,
        });
      }
      const revision = parseRevision(authorityResult.revision);
      if (
        !Array.isArray(authorityResult.candidates) ||
        typeof authorityResult.hasMore !== 'boolean'
      ) {
        return unavailable();
      }
      const candidates = normalizeCandidates(
        authorityResult.candidates,
        teamId,
        memberId,
        request.value.cursor,
        itemLimit
      );
      if (candidates === null) return unavailable();

      const selected: OrderedCandidate[] = [];
      let skippedBy: HostedMemberLogTruncationReason | null = null;
      for (const candidate of candidates) {
        if (this.clock.now() >= deadlineAtMs) {
          skippedBy = 'time_budget';
          break;
        }
        if (selected.length >= request.value.limit) {
          skippedBy = 'item_budget';
          break;
        }
        selected.push(candidate);
      }

      let byteBudgetExceeded = false;
      while (true) {
        const hasMore = authorityResult.hasMore || selected.length < candidates.length;
        if (hasMore && selected.length === 0) return unavailable();

        const reasons = new Set<HostedMemberLogTruncationReason>();
        if (authorityResult.hasMore) reasons.add('source_budget');
        if (selected.length < candidates.length) {
          reasons.add(skippedBy ?? (byteBudgetExceeded ? 'byte_budget' : 'source_budget'));
        }
        if (byteBudgetExceeded) reasons.add('byte_budget');

        const endedAtMs = this.clock.now();
        if (
          !Number.isSafeInteger(endedAtMs) ||
          endedAtMs < startedAtMs ||
          endedAtMs >= deadlineAtMs
        ) {
          return unavailable();
        }
        const page = pageWithMeasuredBudget({
          selectionId: request.value.selectionId,
          teamId,
          memberId,
          sourceGeneration,
          revision,
          entries: selected.map(({ entry }) => entry),
          nextCursor: hasMore ? (selected.at(-1)?.cursorAfter ?? null) : null,
          truncated: hasMore,
          truncationReasons: orderedReasons(reasons),
          itemLimit: request.value.limit,
          elapsedMs: endedAtMs - startedAtMs,
        });
        if (page !== null) return Object.freeze({ kind: 'success', page });
        if (selected.length === 0) return unavailable();
        selected.pop();
        byteBudgetExceeded = true;
      }
    } catch {
      return unavailable();
    }
  }
}
