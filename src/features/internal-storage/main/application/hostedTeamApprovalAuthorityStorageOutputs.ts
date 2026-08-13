import { createHash } from 'node:crypto';

import type {
  HostedTeamApprovalDecisionStorageResult,
  HostedTeamApprovalPendingStorageRecord,
  HostedTeamApprovalStorageDecision,
  HostedTeamApprovalTimeoutAuditResult,
} from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (!isRecord(value)) throw new TypeError(`${label}-invalid`);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label}-invalid`);
  }
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label}-invalid`);
  }
  return value as number;
}

function positive(value: unknown, label: string): number {
  const parsed = finiteNonNegative(value, label);
  if (parsed < 1) throw new TypeError(`${label}-invalid`);
  return parsed;
}

function generation(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(value)) {
    throw new TypeError(`${label}-invalid`);
  }
  return value;
}

function browserDecision(value: unknown): 'allow' | 'deny' {
  if (value !== 'allow' && value !== 'deny') {
    throw new TypeError('hosted-team-approval-storage-decision-invalid');
  }
  return value;
}

function parseDecisionReceipt(value: unknown): {
  readonly approvalGeneration: string;
  readonly decision: HostedTeamApprovalStorageDecision;
  readonly revision: number;
} {
  const input = exactRecord(
    value,
    ['approvalGeneration', 'decision', 'revision'],
    'hosted-team-approval-storage-decision-receipt'
  );
  return Object.freeze({
    approvalGeneration: generation(
      input.approvalGeneration,
      'hosted-team-approval-storage-approval-generation'
    ),
    decision: browserDecision(input.decision),
    revision: positive(input.revision, 'hosted-team-approval-storage-revision'),
  });
}

export function parseHostedTeamApprovalDecisionStorageResult(
  value: unknown
): HostedTeamApprovalDecisionStorageResult {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError('hosted-team-approval-storage-decision-result-invalid');
  }
  if (value.kind === 'committed' || value.kind === 'idempotent_replay') {
    const input = exactRecord(
      value,
      ['kind', 'receipt'],
      'hosted-team-approval-storage-decision-result'
    );
    return Object.freeze({
      kind: input.kind as 'committed' | 'idempotent_replay',
      receipt: parseDecisionReceipt(input.receipt),
    });
  }
  if (value.kind === 'already_resolved') {
    const input = exactRecord(
      value,
      ['kind', 'approvalGeneration', 'decision'],
      'hosted-team-approval-storage-decision-result'
    );
    return Object.freeze({
      kind: 'already_resolved',
      approvalGeneration: generation(
        input.approvalGeneration,
        'hosted-team-approval-storage-approval-generation'
      ),
      decision: browserDecision(input.decision),
    });
  }
  if (value.kind === 'stale_generation') {
    const input = exactRecord(
      value,
      ['kind', 'currentApprovalGeneration'],
      'hosted-team-approval-storage-decision-result'
    );
    return Object.freeze({
      kind: 'stale_generation',
      currentApprovalGeneration: generation(
        input.currentApprovalGeneration,
        'hosted-team-approval-storage-approval-generation'
      ),
    });
  }
  if (value.kind === 'conflict') {
    const input = exactRecord(
      value,
      ['kind', 'reason'],
      'hosted-team-approval-storage-decision-result'
    );
    if (input.reason !== 'idempotency_mismatch') {
      throw new TypeError('hosted-team-approval-storage-decision-result-invalid');
    }
    return Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' });
  }
  if (value.kind === 'expired' || value.kind === 'not_found') {
    exactRecord(value, ['kind'], 'hosted-team-approval-storage-decision-result');
    return Object.freeze({ kind: value.kind });
  }
  throw new TypeError('hosted-team-approval-storage-decision-result-invalid');
}

export function parseHostedTeamApprovalVoidResult(value: unknown): void {
  if (value !== undefined) {
    throw new TypeError('hosted-team-approval-storage-void-result-invalid');
  }
}

export function parseHostedTeamApprovalTimeoutAuditResult(
  value: unknown
): HostedTeamApprovalTimeoutAuditResult {
  const input = exactRecord(
    value,
    ['resolvedCount', 'nextAuditTimeMs'],
    'hosted-team-approval-storage-timeout-audit-result'
  );
  return Object.freeze({
    resolvedCount: finiteNonNegative(
      input.resolvedCount,
      'hosted-team-approval-storage-timeout-resolved-count'
    ),
    nextAuditTimeMs:
      input.nextAuditTimeMs === null
        ? null
        : finiteNonNegative(input.nextAuditTimeMs, 'hosted-team-approval-storage-next-audit-time'),
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashHostedTeamApprovalGeneration(value: string): string {
  return sha256(value);
}

export function hashHostedTeamApprovalIdentity(
  input: HostedTeamApprovalPendingStorageRecord
): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      teamId: input.scope.teamId,
      runId: input.runId,
      requestId: input.requestId,
      approvalId: input.approvalId,
      approvalGeneration: input.approvalGeneration,
      category: input.category,
      summary: input.summary,
      requestedAtMs: input.requestedAtMs,
      expiresAtMs: input.expiresAtMs,
      preview: input.preview,
      deliveryRef: input.deliveryRef,
      observedAtMs: input.observedAtMs,
    })
  );
}

export function hashHostedTeamApprovalDecision(
  browserIntentHash: string,
  approvalIdentityHash: string
): string {
  return sha256(JSON.stringify({ schemaVersion: 1, browserIntentHash, approvalIdentityHash }));
}

export function hashHostedTeamApprovalTimeout(approvalIdentityHash: string): string {
  return sha256(JSON.stringify({ schemaVersion: 1, outcome: 'timeout', approvalIdentityHash }));
}

export function serializeHostedTeamApprovalDeliveryIntent(input: {
  readonly partition: Readonly<{ teamId: string; runId: string }>;
  readonly requestId: string;
  readonly approvalId: string;
  readonly approvalGeneration: string;
  readonly decision: HostedTeamApprovalStorageDecision;
  readonly payloadHash: string;
  readonly deliveryId: string;
  readonly principal:
    | Readonly<{ readonly kind: 'operator'; readonly actorId: string }>
    | Readonly<{ readonly kind: 'system_timeout' }>;
  readonly deliveryRef: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    deliveryId: input.deliveryId,
    principal: input.principal,
    partition: input.partition,
    requestId: input.requestId,
    approvalId: input.approvalId,
    approvalGeneration: input.approvalGeneration,
    decision: input.decision,
    payloadHash: input.payloadHash,
    deliveryRef: input.deliveryRef,
  });
}
