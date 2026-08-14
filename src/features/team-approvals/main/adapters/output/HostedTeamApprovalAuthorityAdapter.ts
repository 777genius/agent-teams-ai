import { parseCursor, parseTeamId } from '@shared/contracts/hosted';

import {
  type HostedTeamApprovalDecisionCommand,
  parseHostedTeamApprovalDecisionCommand,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalPreviewRef,
} from '../../../contracts/hosted';
import {
  HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS,
  normalizeHostedTeamApprovalDecision,
  normalizeHostedTeamApprovalItem,
  normalizeHostedTeamApprovalPreview,
  normalizeHostedTeamApprovalReceipt,
  normalizeHostedTeamApprovalRetryAfterMs,
} from '../../../core/application/models/HostedTeamApprovalModels';

import type {
  HostedTeamApprovalClockPort,
  HostedTeamApprovalDecisionAdmissionPort,
  HostedTeamApprovalDecisionAdmissionResult,
  HostedTeamApprovalPageCandidate,
  HostedTeamApprovalPageSourcePort,
  HostedTeamApprovalPageSourceRequest,
  HostedTeamApprovalPageSourceResult,
  HostedTeamApprovalPreviewSourcePort,
  HostedTeamApprovalPreviewSourceRequest,
  HostedTeamApprovalPreviewSourceResult,
} from '../../../core/application/ports/HostedTeamApprovalPorts';
import type { HostedTeamApprovalAuthorityPort } from '../../ports/HostedTeamApprovalAuthorityPort';
import type { QueryContext } from '@shared/contracts/hosted';

type UnknownRecord = Record<PropertyKey, unknown>;

const PAGE_REQUEST_KEYS = Object.freeze([
  'teamId',
  'cursor',
  'itemLimit',
  'byteLimit',
  'deadlineAtMs',
] as const);
const PREVIEW_REQUEST_KEYS = Object.freeze([
  'teamId',
  'approvalId',
  'expectedGeneration',
  'previewRef',
  'byteLimit',
  'deadlineAtMs',
] as const);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function unavailable(retryAfterMs?: number): {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
} {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function normalizeUnavailable(value: UnknownRecord): ReturnType<typeof unavailable> {
  if (hasExactKeys(value, ['kind'])) return unavailable();
  if (!hasExactKeys(value, ['kind', 'retryAfterMs'])) return unavailable();
  const retryAfterMs = normalizeHostedTeamApprovalRetryAfterMs(value.retryAfterMs);
  return retryAfterMs === undefined ? unavailable() : unavailable(retryAfterMs);
}

function normalizePageRequest(
  value: HostedTeamApprovalPageSourceRequest,
  context: QueryContext
): HostedTeamApprovalPageSourceRequest | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PAGE_REQUEST_KEYS)) return null;
    const teamId = parseTeamId(value.teamId);
    const cursor = value.cursor === null ? null : parseCursor(value.cursor);
    const itemLimit = value.itemLimit;
    const byteLimit = value.byteLimit;
    const deadlineAtMs = value.deadlineAtMs;
    if (
      !isSafeIntegerInRange(itemLimit, 1, HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS) ||
      !isSafeIntegerInRange(byteLimit, 1, HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES) ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs < 0 ||
      deadlineAtMs > context.deadlineAtMs
    ) {
      return null;
    }
    return Object.freeze({ teamId, cursor, itemLimit, byteLimit, deadlineAtMs });
  } catch {
    return null;
  }
}

function normalizePreviewRequest(
  value: HostedTeamApprovalPreviewSourceRequest,
  context: QueryContext
): HostedTeamApprovalPreviewSourceRequest | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PREVIEW_REQUEST_KEYS)) return null;
    const teamId = parseTeamId(value.teamId);
    const approvalId = parseHostedTeamApprovalId(value.approvalId);
    const expectedGeneration = parseHostedTeamApprovalGeneration(value.expectedGeneration);
    const previewRef = parseHostedTeamApprovalPreviewRef(value.previewRef);
    const byteLimit = value.byteLimit;
    const deadlineAtMs = value.deadlineAtMs;
    if (
      !isSafeIntegerInRange(byteLimit, 1, HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES) ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs < 0 ||
      deadlineAtMs > context.deadlineAtMs
    ) {
      return null;
    }
    return Object.freeze({
      teamId,
      approvalId,
      expectedGeneration,
      previewRef,
      byteLimit,
      deadlineAtMs,
    });
  } catch {
    return null;
  }
}

function normalizeDecisionCommand(
  command: HostedTeamApprovalDecisionCommand
): HostedTeamApprovalDecisionCommand | null {
  const parsed = parseHostedTeamApprovalDecisionCommand(command);
  return parsed.ok ? parsed.value : null;
}

function normalizeCandidates(
  value: unknown,
  request: HostedTeamApprovalPageSourceRequest
): readonly HostedTeamApprovalPageCandidate[] | null {
  if (!Array.isArray(value) || value.length > request.itemLimit) return null;

  const approvalIds = new Set<string>();
  const cursors = new Set<string>();
  const candidates: HostedTeamApprovalPageCandidate[] = [];
  let usedBytes = 0;

  for (const candidateValue of value) {
    if (!isRecord(candidateValue) || !hasExactKeys(candidateValue, ['item', 'cursorAfter'])) {
      return null;
    }
    const item = normalizeHostedTeamApprovalItem(candidateValue.item, request.teamId);
    if (item === null) return null;

    let cursorAfter: ReturnType<typeof parseCursor>;
    try {
      cursorAfter = parseCursor(candidateValue.cursorAfter);
    } catch {
      return null;
    }
    if (
      cursorAfter === request.cursor ||
      cursors.has(cursorAfter) ||
      approvalIds.has(item.approvalId)
    ) {
      return null;
    }

    usedBytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (usedBytes > request.byteLimit) return null;
    cursors.add(cursorAfter);
    approvalIds.add(item.approvalId);
    candidates.push(Object.freeze({ item, cursorAfter }));
  }

  return Object.freeze(candidates);
}

function normalizePageResult(
  value: unknown,
  request: HostedTeamApprovalPageSourceRequest
): HostedTeamApprovalPageSourceResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return unavailable();
  if (value.kind === 'not_found') {
    return hasExactKeys(value, ['kind']) ? Object.freeze({ kind: 'not_found' }) : unavailable();
  }
  if (value.kind === 'unavailable') return normalizeUnavailable(value);
  if (value.kind !== 'found' || !hasExactKeys(value, ['kind', 'teamId', 'candidates', 'hasMore'])) {
    return unavailable();
  }

  try {
    if (parseTeamId(value.teamId) !== request.teamId || typeof value.hasMore !== 'boolean') {
      return unavailable();
    }
    const candidates = normalizeCandidates(value.candidates, request);
    if (candidates === null || (value.hasMore && candidates.length === 0)) return unavailable();
    return Object.freeze({
      kind: 'found',
      teamId: request.teamId,
      candidates,
      hasMore: value.hasMore,
    });
  } catch {
    return unavailable();
  }
}

function normalizePreviewResult(
  value: unknown,
  request: HostedTeamApprovalPreviewSourceRequest
): HostedTeamApprovalPreviewSourceResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return unavailable();
  if (value.kind === 'not_found') {
    return hasExactKeys(value, ['kind']) ? Object.freeze({ kind: 'not_found' }) : unavailable();
  }
  if (value.kind === 'unavailable') return normalizeUnavailable(value);
  if (value.kind === 'stale_generation') {
    if (!hasExactKeys(value, ['kind', 'currentGeneration'])) return unavailable();
    try {
      const currentGeneration = parseHostedTeamApprovalGeneration(value.currentGeneration);
      return currentGeneration === request.expectedGeneration
        ? unavailable()
        : Object.freeze({ kind: 'stale_generation', currentGeneration });
    } catch {
      return unavailable();
    }
  }
  if (value.kind !== 'found' || !hasExactKeys(value, ['kind', 'preview'])) return unavailable();

  const preview = normalizeHostedTeamApprovalPreview(value.preview, {
    teamId: request.teamId,
    runId: request.expectedRunId,
    approvalId: request.approvalId,
  });
  if (
    preview === null ||
    preview.generation !== request.expectedGeneration ||
    preview.byteLength > request.byteLimit
  ) {
    return unavailable();
  }
  return Object.freeze({
    kind: 'found',
    preview: Object.freeze({
      teamId: preview.teamId,
      runId: preview.runId,
      approvalId: preview.approvalId,
      generation: preview.generation,
      content: preview.content,
      byteLength: preview.byteLength,
      truncated: preview.truncated,
      isBinary: preview.isBinary,
    }),
  });
}

function normalizeDecisionResult(
  value: unknown,
  command: HostedTeamApprovalDecisionCommand
): HostedTeamApprovalDecisionAdmissionResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return unavailable();
  if (value.kind === 'unavailable') return normalizeUnavailable(value);
  if (value.kind === 'committed' || value.kind === 'idempotent_replay') {
    if (!hasExactKeys(value, ['kind', 'receipt'])) return unavailable();
    const receipt = normalizeHostedTeamApprovalReceipt(value.receipt, {
      outcome: value.kind,
      teamId: command.teamId,
      runId: command.expectedRunId,
      approvalId: command.approvalId,
      generation: command.expectedGeneration,
      decision: command.decision,
    });
    return receipt === null ? unavailable() : Object.freeze({ kind: value.kind, receipt });
  }
  if (value.kind === 'already_resolved') {
    if (!hasExactKeys(value, ['kind', 'generation', 'decision'])) return unavailable();
    try {
      const generation = parseHostedTeamApprovalGeneration(value.generation);
      const decision = normalizeHostedTeamApprovalDecision(value.decision);
      return generation !== command.expectedGeneration || decision === null
        ? unavailable()
        : Object.freeze({ kind: 'already_resolved', generation, decision });
    } catch {
      return unavailable();
    }
  }
  if (value.kind === 'stale_generation') {
    if (!hasExactKeys(value, ['kind', 'currentGeneration'])) return unavailable();
    try {
      const currentGeneration = parseHostedTeamApprovalGeneration(value.currentGeneration);
      return currentGeneration === command.expectedGeneration
        ? unavailable()
        : Object.freeze({ kind: 'stale_generation', currentGeneration });
    } catch {
      return unavailable();
    }
  }
  if (value.kind === 'conflict') {
    return hasExactKeys(value, ['kind', 'reason']) && value.reason === 'idempotency_mismatch'
      ? Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' })
      : unavailable();
  }
  if (value.kind === 'expired' || value.kind === 'not_found') {
    return hasExactKeys(value, ['kind']) ? Object.freeze({ kind: value.kind }) : unavailable();
  }
  return unavailable();
}

export class HostedTeamApprovalAuthorityAdapter
  implements
    HostedTeamApprovalPageSourcePort,
    HostedTeamApprovalPreviewSourcePort,
    HostedTeamApprovalDecisionAdmissionPort
{
  constructor(
    private readonly authority: HostedTeamApprovalAuthorityPort,
    private readonly clock: HostedTeamApprovalClockPort
  ) {}

  private isActive(context: QueryContext, deadlineAtMs: number): boolean {
    try {
      const now = this.clock.now();
      return (
        context.signal instanceof AbortSignal &&
        !context.signal.aborted &&
        Number.isSafeInteger(context.deadlineAtMs) &&
        context.deadlineAtMs >= 0 &&
        Number.isSafeInteger(deadlineAtMs) &&
        deadlineAtMs >= 0 &&
        deadlineAtMs <= context.deadlineAtMs &&
        Number.isSafeInteger(now) &&
        now >= 0 &&
        now < deadlineAtMs
      );
    } catch {
      return false;
    }
  }

  async readPage(
    requestValue: HostedTeamApprovalPageSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPageSourceResult> {
    const request = normalizePageRequest(requestValue, context);
    if (request === null || !this.isActive(context, request.deadlineAtMs)) {
      return unavailable();
    }
    try {
      const result = await this.authority.readPendingPage(request, context);
      return this.isActive(context, request.deadlineAtMs)
        ? normalizePageResult(result, request)
        : unavailable();
    } catch {
      return unavailable();
    }
  }

  async readPreview(
    requestValue: HostedTeamApprovalPreviewSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPreviewSourceResult> {
    const request = normalizePreviewRequest(requestValue, context);
    if (request === null || !this.isActive(context, request.deadlineAtMs)) {
      return unavailable();
    }
    try {
      const result = await this.authority.readPreviewByOpaqueRef(request, context);
      return this.isActive(context, request.deadlineAtMs)
        ? normalizePreviewResult(result, request)
        : unavailable();
    } catch {
      return unavailable();
    }
  }

  async admit(
    commandValue: HostedTeamApprovalDecisionCommand,
    context: QueryContext
  ): Promise<HostedTeamApprovalDecisionAdmissionResult> {
    const command = normalizeDecisionCommand(commandValue);
    if (command === null || !this.isActive(context, context.deadlineAtMs)) {
      return unavailable();
    }
    try {
      const result = await this.authority.compareAndClaimDecision(command, context);
      return this.isActive(context, context.deadlineAtMs)
        ? normalizeDecisionResult(result, command)
        : unavailable();
    } catch {
      return unavailable();
    }
  }
}
