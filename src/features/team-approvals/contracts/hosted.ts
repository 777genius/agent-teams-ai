import {
  createSafeAppError,
  type Cursor,
  HOSTED_SCHEMA_VERSION,
  parseCursor,
  parseHostedSchemaVersion,
  parseRunId,
  parseTeamId,
  type RunId,
  type SafeAppError,
  type TeamId,
} from '@shared/contracts/hosted';

declare const hostedTeamApprovalBrand: unique symbol;

export type HostedTeamApprovalId = string & {
  readonly [hostedTeamApprovalBrand]: 'HostedTeamApprovalId';
};
export type HostedTeamApprovalGeneration = string & {
  readonly [hostedTeamApprovalBrand]: 'HostedTeamApprovalGeneration';
};
export type HostedTeamApprovalPreviewRef = string & {
  readonly [hostedTeamApprovalBrand]: 'HostedTeamApprovalPreviewRef';
};
export type HostedTeamApprovalIdempotencyKey = string & {
  readonly [hostedTeamApprovalBrand]: 'HostedTeamApprovalIdempotencyKey';
};

export const HOSTED_TEAM_APPROVAL_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;
export const HOSTED_TEAM_APPROVAL_PAGE_ROUTE = '/api/hosted/v1/team-approvals/page' as const;
export const HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE = '/api/hosted/v1/team-approvals/preview' as const;
export const HOSTED_TEAM_APPROVAL_DECISION_ROUTE =
  '/api/hosted/v1/team-approvals/decisions' as const;

const APPROVAL_ID = /^approval_[0-9a-f]{32}$/;
const APPROVAL_GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;
const PREVIEW_REF = /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseHostedTeamApprovalId(value: unknown): HostedTeamApprovalId {
  if (typeof value !== 'string' || !APPROVAL_ID.test(value)) {
    throw new TypeError('hosted-team-approval-id-invalid');
  }
  return value as HostedTeamApprovalId;
}

export function parseHostedTeamApprovalGeneration(value: unknown): HostedTeamApprovalGeneration {
  if (typeof value !== 'string' || !APPROVAL_GENERATION.test(value)) {
    throw new TypeError('hosted-team-approval-generation-invalid');
  }
  return value as HostedTeamApprovalGeneration;
}

export function parseHostedTeamApprovalPreviewRef(value: unknown): HostedTeamApprovalPreviewRef {
  if (typeof value !== 'string' || !PREVIEW_REF.test(value)) {
    throw new TypeError('hosted-team-approval-preview-ref-invalid');
  }
  return value as HostedTeamApprovalPreviewRef;
}

export function parseHostedTeamApprovalIdempotencyKey(
  value: unknown
): HostedTeamApprovalIdempotencyKey {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new TypeError('hosted-team-approval-idempotency-key-invalid');
  }
  return value as HostedTeamApprovalIdempotencyKey;
}

export const HOSTED_TEAM_APPROVAL_CATEGORIES = Object.freeze([
  'file_change',
  'command',
  'network',
  'other',
] as const);
export type HostedTeamApprovalCategory = (typeof HOSTED_TEAM_APPROVAL_CATEGORIES)[number];

export const HOSTED_TEAM_APPROVAL_DECISIONS = Object.freeze(['allow', 'deny'] as const);
export type HostedTeamApprovalDecision = (typeof HOSTED_TEAM_APPROVAL_DECISIONS)[number];

export interface HostedTeamApprovalPageRequest {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly expectedRunId: RunId;
  readonly cursor: Cursor | null;
  readonly limit: number;
}

/** Browser-safe pending projection. The opaque previewRef is not a path or authorization token. */
export interface HostedTeamApprovalItem {
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly approvalId: HostedTeamApprovalId;
  readonly generation: HostedTeamApprovalGeneration;
  readonly category: HostedTeamApprovalCategory;
  readonly summary: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly previewRef: HostedTeamApprovalPreviewRef | null;
}

export interface HostedTeamApprovalPageBudget {
  readonly itemLimit: number;
  readonly byteLimit: number;
  readonly timeLimitMs: number;
  readonly usedItems: number;
  readonly usedBytes: number;
  readonly elapsedMs: number;
}

export interface HostedTeamApprovalPage {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly kind: 'approval_page';
  readonly teamId: TeamId;
  readonly items: readonly HostedTeamApprovalItem[];
  readonly nextCursor: Cursor | null;
  readonly truncated: boolean;
  readonly budget: HostedTeamApprovalPageBudget;
}

export interface HostedTeamApprovalPreviewRequest {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly expectedRunId: RunId;
  readonly approvalId: HostedTeamApprovalId;
  readonly expectedGeneration: HostedTeamApprovalGeneration;
  readonly previewRef: HostedTeamApprovalPreviewRef;
}

export interface HostedTeamApprovalPreview {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly kind: 'approval_preview';
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly approvalId: HostedTeamApprovalId;
  readonly generation: HostedTeamApprovalGeneration;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly isBinary: boolean;
}

export interface HostedTeamApprovalDecisionCommand {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly expectedRunId: RunId;
  readonly approvalId: HostedTeamApprovalId;
  readonly expectedGeneration: HostedTeamApprovalGeneration;
  readonly idempotencyKey: HostedTeamApprovalIdempotencyKey;
  readonly decision: HostedTeamApprovalDecision;
}

interface HostedTeamApprovalDecisionReceiptBase {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly teamId: TeamId;
  readonly runId: RunId;
  readonly approvalId: HostedTeamApprovalId;
  readonly generation: HostedTeamApprovalGeneration;
  readonly decision: HostedTeamApprovalDecision;
}

export interface HostedTeamApprovalCommittedReceipt extends HostedTeamApprovalDecisionReceiptBase {
  readonly outcome: 'committed';
}

export interface HostedTeamApprovalReplayReceipt extends HostedTeamApprovalDecisionReceiptBase {
  readonly outcome: 'idempotent_replay';
}

export type HostedTeamApprovalDecisionReceipt =
  | HostedTeamApprovalCommittedReceipt
  | HostedTeamApprovalReplayReceipt;

export type GetHostedTeamApprovalPageResult =
  | { readonly kind: 'success'; readonly page: HostedTeamApprovalPage }
  | { readonly kind: 'invalid_request' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export type GetHostedTeamApprovalPreviewResult =
  | { readonly kind: 'success'; readonly preview: HostedTeamApprovalPreview }
  | { readonly kind: 'invalid_request' }
  | {
      readonly kind: 'stale_generation';
      readonly currentGeneration: HostedTeamApprovalGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export type DecideHostedTeamApprovalResult =
  | { readonly kind: 'committed'; readonly receipt: HostedTeamApprovalCommittedReceipt }
  | { readonly kind: 'idempotent_replay'; readonly receipt: HostedTeamApprovalReplayReceipt }
  | {
      readonly kind: 'already_resolved';
      readonly generation: HostedTeamApprovalGeneration;
      readonly decision: HostedTeamApprovalDecision;
    }
  | { readonly kind: 'invalid_request' }
  | {
      readonly kind: 'stale_generation';
      readonly currentGeneration: HostedTeamApprovalGeneration;
    }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedTeamApprovalErrorEnvelope {
  readonly schemaVersion: typeof HOSTED_TEAM_APPROVAL_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly error: SafeAppError;
  readonly retryable: boolean;
  readonly currentGeneration?: HostedTeamApprovalGeneration;
  readonly resolvedDecision?: HostedTeamApprovalDecision;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseRequest<T>(operation: () => T): ParseResult<T> {
  try {
    return Object.freeze({ ok: true, value: operation() });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function parseHostedTeamApprovalPageRequest(
  value: unknown
): ParseResult<HostedTeamApprovalPageRequest> {
  return parseRequest(() => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['schemaVersion', 'teamId', 'expectedRunId', 'cursor', 'limit'])
    ) {
      throw new TypeError();
    }
    const limit = value.limit;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      teamId: parseTeamId(value.teamId),
      expectedRunId: parseRunId(value.expectedRunId),
      cursor: value.cursor === null ? null : parseCursor(value.cursor),
      limit: limit as number,
    });
  });
}

export function parseHostedTeamApprovalPreviewRequest(
  value: unknown
): ParseResult<HostedTeamApprovalPreviewRequest> {
  return parseRequest(() => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'teamId',
        'expectedRunId',
        'approvalId',
        'expectedGeneration',
        'previewRef',
      ])
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      teamId: parseTeamId(value.teamId),
      expectedRunId: parseRunId(value.expectedRunId),
      approvalId: parseHostedTeamApprovalId(value.approvalId),
      expectedGeneration: parseHostedTeamApprovalGeneration(value.expectedGeneration),
      previewRef: parseHostedTeamApprovalPreviewRef(value.previewRef),
    });
  });
}

export function parseHostedTeamApprovalDecisionCommand(
  value: unknown
): ParseResult<HostedTeamApprovalDecisionCommand> {
  return parseRequest(() => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'teamId',
        'expectedRunId',
        'approvalId',
        'expectedGeneration',
        'idempotencyKey',
        'decision',
      ]) ||
      !HOSTED_TEAM_APPROVAL_DECISIONS.includes(value.decision as HostedTeamApprovalDecision)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      teamId: parseTeamId(value.teamId),
      expectedRunId: parseRunId(value.expectedRunId),
      approvalId: parseHostedTeamApprovalId(value.approvalId),
      expectedGeneration: parseHostedTeamApprovalGeneration(value.expectedGeneration),
      idempotencyKey: parseHostedTeamApprovalIdempotencyKey(value.idempotencyKey),
      decision: value.decision as HostedTeamApprovalDecision,
    });
  });
}

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'outcome',
  'teamId',
  'runId',
  'approvalId',
  'generation',
  'decision',
] as const);

export function parseHostedTeamApprovalDecisionReceipt(
  value: unknown
): ParseResult<HostedTeamApprovalDecisionReceipt> {
  return parseRequest(() => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, RECEIPT_KEYS) ||
      (value.outcome !== 'committed' && value.outcome !== 'idempotent_replay') ||
      !HOSTED_TEAM_APPROVAL_DECISIONS.includes(value.decision as HostedTeamApprovalDecision)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      outcome: value.outcome,
      teamId: parseTeamId(value.teamId),
      runId: parseRunId(value.runId),
      approvalId: parseHostedTeamApprovalId(value.approvalId),
      generation: parseHostedTeamApprovalGeneration(value.generation),
      decision: value.decision as HostedTeamApprovalDecision,
    });
  });
}

function parseHostedTeamApprovalItem(
  value: unknown,
  expectedTeamId: TeamId
): HostedTeamApprovalItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'teamId',
      'runId',
      'approvalId',
      'generation',
      'category',
      'summary',
      'requestedAtMs',
      'expiresAtMs',
      'previewRef',
    ])
  ) {
    throw new TypeError();
  }
  const teamId = parseTeamId(value.teamId);
  const runId = parseRunId(value.runId);
  const summary = value.summary;
  const requestedAtMs = value.requestedAtMs;
  const expiresAtMs = value.expiresAtMs;
  if (
    teamId !== expectedTeamId ||
    !HOSTED_TEAM_APPROVAL_CATEGORIES.includes(value.category as HostedTeamApprovalCategory) ||
    typeof summary !== 'string' ||
    summary.length < 1 ||
    summary.length > 512 ||
    summary.trim() !== summary ||
    !Number.isSafeInteger(requestedAtMs) ||
    (requestedAtMs as number) < 0 ||
    (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || (expiresAtMs as number) < 0)) ||
    (typeof expiresAtMs === 'number' && expiresAtMs <= (requestedAtMs as number))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    teamId,
    runId,
    approvalId: parseHostedTeamApprovalId(value.approvalId),
    generation: parseHostedTeamApprovalGeneration(value.generation),
    category: value.category as HostedTeamApprovalCategory,
    summary,
    requestedAtMs: requestedAtMs as number,
    expiresAtMs: expiresAtMs as number | null,
    previewRef:
      value.previewRef === null ? null : parseHostedTeamApprovalPreviewRef(value.previewRef),
  });
}

export function parseHostedTeamApprovalPage(value: unknown): ParseResult<HostedTeamApprovalPage> {
  return parseRequest(() => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'teamId',
        'items',
        'nextCursor',
        'truncated',
        'budget',
      ]) ||
      value.kind !== 'approval_page' ||
      !Array.isArray(value.items) ||
      value.items.length > 50 ||
      typeof value.truncated !== 'boolean' ||
      !isRecord(value.budget) ||
      !hasExactKeys(value.budget, [
        'itemLimit',
        'byteLimit',
        'timeLimitMs',
        'usedItems',
        'usedBytes',
        'elapsedMs',
      ])
    ) {
      throw new TypeError();
    }
    const teamId = parseTeamId(value.teamId);
    const items = Object.freeze(
      value.items.map((item) => parseHostedTeamApprovalItem(item, teamId))
    );
    const approvalIds = new Set(items.map(({ approvalId }) => approvalId));
    const budget = value.budget;
    const numericFields = [
      budget.itemLimit,
      budget.byteLimit,
      budget.timeLimitMs,
      budget.usedItems,
      budget.usedBytes,
      budget.elapsedMs,
    ];
    if (
      approvalIds.size !== items.length ||
      numericFields.some((field) => !Number.isSafeInteger(field) || (field as number) < 0) ||
      (budget.itemLimit as number) < 1 ||
      (budget.itemLimit as number) > 50 ||
      (budget.byteLimit as number) < 1 ||
      (budget.byteLimit as number) > 128 * 1024 ||
      (budget.timeLimitMs as number) < 1 ||
      (budget.timeLimitMs as number) > 250 ||
      budget.usedItems !== items.length ||
      budget.usedItems > (budget.itemLimit as number) ||
      (budget.usedBytes as number) > (budget.byteLimit as number) ||
      (value.truncated && value.nextCursor === null) ||
      (!value.truncated && value.nextCursor !== null)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      kind: 'approval_page' as const,
      teamId,
      items,
      nextCursor: value.nextCursor === null ? null : parseCursor(value.nextCursor),
      truncated: value.truncated,
      budget: Object.freeze({
        itemLimit: budget.itemLimit as number,
        byteLimit: budget.byteLimit as number,
        timeLimitMs: budget.timeLimitMs as number,
        usedItems: budget.usedItems,
        usedBytes: budget.usedBytes as number,
        elapsedMs: budget.elapsedMs as number,
      }),
    });
  });
}

export function parseHostedTeamApprovalPreview(
  value: unknown
): ParseResult<HostedTeamApprovalPreview> {
  return parseRequest(() => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'teamId',
        'runId',
        'approvalId',
        'generation',
        'content',
        'byteLength',
        'truncated',
        'isBinary',
      ]) ||
      value.kind !== 'approval_preview' ||
      typeof value.content !== 'string' ||
      typeof value.truncated !== 'boolean' ||
      typeof value.isBinary !== 'boolean' ||
      !Number.isSafeInteger(value.byteLength) ||
      (value.byteLength as number) < 0 ||
      (value.byteLength as number) > 64 * 1024 ||
      new TextEncoder().encode(value.content).byteLength > (value.byteLength as number) ||
      (value.isBinary && value.content !== '')
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      kind: 'approval_preview' as const,
      teamId: parseTeamId(value.teamId),
      runId: parseRunId(value.runId),
      approvalId: parseHostedTeamApprovalId(value.approvalId),
      generation: parseHostedTeamApprovalGeneration(value.generation),
      content: value.content,
      byteLength: value.byteLength as number,
      truncated: value.truncated,
      isBinary: value.isBinary,
    });
  });
}

export function parseHostedTeamApprovalErrorEnvelope(
  value: unknown
): ParseResult<HostedTeamApprovalErrorEnvelope> {
  return parseRequest(() => {
    if (!isRecord(value)) throw new TypeError();
    const optionalKeys = ['currentGeneration', 'resolvedDecision'];
    const requiredKeys = ['schemaVersion', 'kind', 'error', 'retryable'];
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some(
        (key) =>
          typeof key !== 'string' || (!requiredKeys.includes(key) && !optionalKeys.includes(key))
      ) ||
      !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
      value.kind !== 'error' ||
      typeof value.retryable !== 'boolean'
    ) {
      throw new TypeError();
    }
    const currentGeneration = Object.hasOwn(value, 'currentGeneration')
      ? parseHostedTeamApprovalGeneration(value.currentGeneration)
      : undefined;
    const resolvedDecision = Object.hasOwn(value, 'resolvedDecision')
      ? value.resolvedDecision
      : undefined;
    if (
      resolvedDecision !== undefined &&
      !HOSTED_TEAM_APPROVAL_DECISIONS.includes(resolvedDecision as HostedTeamApprovalDecision)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      schemaVersion: parseHostedSchemaVersion(value.schemaVersion),
      kind: 'error' as const,
      error: createSafeAppError(value.error),
      retryable: value.retryable,
      ...(currentGeneration === undefined ? {} : { currentGeneration }),
      ...(resolvedDecision === undefined
        ? {}
        : { resolvedDecision: resolvedDecision as HostedTeamApprovalDecision }),
    });
  });
}
