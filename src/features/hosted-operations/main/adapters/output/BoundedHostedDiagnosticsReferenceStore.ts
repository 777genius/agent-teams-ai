import { createQueryContext, type QueryContext } from '@shared/contracts/hosted';

import {
  HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE,
  OPERATION_EVENT_KINDS,
  OPERATION_OUTCOMES,
  parseOperationalReferenceId,
} from '../../../contracts';
import { snapshotExactDataRecord } from '../../../contracts/exactDataSnapshot';
import { applyRetentionBudget, redactOperationAttributes } from '../../../core/domain';

import type {
  OperationalReferenceId,
  OperationEventKind,
  OperationOutcome,
  RetentionBudget,
} from '../../../contracts';
import type {
  HostedDiagnosticsSourcePort,
  HostedDiagnosticsSourceRecord,
  HostedDiagnosticsSourceResult,
} from '../../../core/application/ports/HostedDiagnosticsPorts';

const QUERY_CONTEXT_KEYS = Object.freeze([
  'actorId',
  'sessionId',
  'deploymentId',
  'bootId',
  'requestId',
  'authorizedScope',
  'deadlineAtMs',
  'signal',
] as const);
const SOURCE_RECORD_KEYS = Object.freeze([
  'kind',
  'outcome',
  'occurredAtMonotonicMs',
  'attributes',
] as const);
const MAX_REFERENCE_ID_ATTEMPTS = 8;

interface HostedDiagnosticsReferenceStorePlatform {
  nowEpochMs(): number;
  nowMonotonicMs(): number;
}

interface StoredAuthority {
  readonly actorId: QueryContext['actorId'];
  readonly sessionId: QueryContext['sessionId'];
  readonly deploymentId: QueryContext['deploymentId'];
  readonly authorizedScope: QueryContext['authorizedScope'];
}

interface StoredDiagnostic {
  readonly authority: StoredAuthority;
  readonly byteLength: number;
  readonly recordedAtMonotonicMs: number;
  readonly referenceId: OperationalReferenceId;
  readonly value: HostedDiagnosticsSourceRecord;
}

export interface BoundedHostedDiagnosticsReferenceStoreDependencies {
  readonly generateReferenceId: () => OperationalReferenceId;
  readonly platform: HostedDiagnosticsReferenceStorePlatform;
  readonly retentionBudget: RetentionBudget;
}

function unavailable(): Error {
  return new Error('hosted-diagnostics-unavailable');
}

function isValidTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function snapshotContext(value: unknown): QueryContext {
  try {
    return createQueryContext(
      snapshotExactDataRecord(value, QUERY_CONTEXT_KEYS, 'hosted-diagnostics-context-invalid')
    );
  } catch {
    throw unavailable();
  }
}

function snapshotSafeRecord(value: unknown): HostedDiagnosticsSourceRecord {
  try {
    const input = snapshotExactDataRecord(
      value,
      SOURCE_RECORD_KEYS,
      'hosted-diagnostics-record-invalid'
    );
    const kind = input.kind;
    const outcome = input.outcome;
    const occurredAtMonotonicMs = input.occurredAtMonotonicMs;
    if (
      typeof kind !== 'string' ||
      !OPERATION_EVENT_KINDS.includes(kind as OperationEventKind) ||
      typeof outcome !== 'string' ||
      !OPERATION_OUTCOMES.includes(outcome as OperationOutcome) ||
      !isValidTime(occurredAtMonotonicMs)
    ) {
      throw unavailable();
    }

    return Object.freeze({
      kind: kind as OperationEventKind,
      outcome: outcome as OperationOutcome,
      occurredAtMonotonicMs,
      attributes: redactOperationAttributes(input.attributes),
    });
  } catch {
    throw unavailable();
  }
}

function byteLengthOf(value: HostedDiagnosticsSourceRecord): number {
  try {
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE
    ) {
      throw unavailable();
    }
    return byteLength;
  } catch {
    throw unavailable();
  }
}

function authorityFrom(context: QueryContext): StoredAuthority {
  return Object.freeze({
    actorId: context.actorId,
    sessionId: context.sessionId,
    deploymentId: context.deploymentId,
    authorizedScope: context.authorizedScope,
  });
}

function hasSameAuthority(authority: StoredAuthority, context: QueryContext): boolean {
  return (
    authority.actorId === context.actorId &&
    authority.sessionId === context.sessionId &&
    authority.deploymentId === context.deploymentId &&
    authority.authorizedScope === context.authorizedScope
  );
}

/** Process-local storage for already-redacted diagnostic projections and server-computed sizes. */
export class BoundedHostedDiagnosticsReferenceStore implements HostedDiagnosticsSourcePort {
  private closed = false;
  private readonly records = new Map<OperationalReferenceId, StoredDiagnostic>();

  constructor(private readonly dependencies: BoundedHostedDiagnosticsReferenceStoreDependencies) {}

  private currentEpochMs(): number {
    try {
      const nowMs = this.dependencies.platform.nowEpochMs();
      if (!isValidTime(nowMs)) throw unavailable();
      return nowMs;
    } catch {
      throw unavailable();
    }
  }

  private currentMonotonicMs(): number {
    try {
      const nowMs = this.dependencies.platform.nowMonotonicMs();
      if (!isValidTime(nowMs)) throw unavailable();
      return nowMs;
    } catch {
      throw unavailable();
    }
  }

  private assertAvailable(context: QueryContext): void {
    if (this.closed || context.signal.aborted || this.currentEpochMs() >= context.deadlineAtMs) {
      throw unavailable();
    }
  }

  private applyRetention(nowMonotonicMs: number): void {
    try {
      const decision = applyRetentionBudget({
        entries: [...this.records.values()].map((entry) => ({
          retentionKey: entry.referenceId,
          recordedAtMonotonicMs: entry.recordedAtMonotonicMs,
          byteLength: entry.byteLength,
          value: entry,
        })),
        budget: this.dependencies.retentionBudget,
        nowMonotonicMs,
      });
      for (const eviction of decision.evicted) {
        this.records.delete(eviction.entry.value.referenceId);
      }
    } catch {
      throw unavailable();
    }
  }

  private nextReferenceId(): OperationalReferenceId {
    for (let attempt = 0; attempt < MAX_REFERENCE_ID_ATTEMPTS; attempt += 1) {
      try {
        const referenceId = parseOperationalReferenceId(this.dependencies.generateReferenceId());
        if (!this.records.has(referenceId)) return referenceId;
      } catch {
        throw unavailable();
      }
    }
    throw unavailable();
  }

  record(value: HostedDiagnosticsSourceRecord, contextValue: QueryContext): OperationalReferenceId {
    const context = snapshotContext(contextValue);
    this.assertAvailable(context);
    const safeValue = snapshotSafeRecord(value);
    const byteLength = byteLengthOf(safeValue);
    const recordedAtMonotonicMs = this.currentMonotonicMs();
    this.applyRetention(recordedAtMonotonicMs);
    const referenceId = this.nextReferenceId();
    const stored: StoredDiagnostic = Object.freeze({
      authority: authorityFrom(context),
      byteLength,
      recordedAtMonotonicMs,
      referenceId,
      value: safeValue,
    });
    this.records.set(referenceId, stored);

    try {
      this.applyRetention(recordedAtMonotonicMs);
      this.assertAvailable(context);
      if (this.records.get(referenceId) !== stored) throw unavailable();
      return referenceId;
    } catch {
      this.records.delete(referenceId);
      throw unavailable();
    }
  }

  async load(
    referenceIdValue: OperationalReferenceId,
    contextValue: QueryContext
  ): Promise<HostedDiagnosticsSourceResult> {
    let referenceId: OperationalReferenceId;
    try {
      referenceId = parseOperationalReferenceId(referenceIdValue);
    } catch {
      throw unavailable();
    }
    const context = snapshotContext(contextValue);
    this.assertAvailable(context);
    this.applyRetention(this.currentMonotonicMs());
    const stored = this.records.get(referenceId);
    if (!stored || !hasSameAuthority(stored.authority, context)) throw unavailable();
    this.assertAvailable(context);

    return Object.freeze({
      value: stored.value,
      byteLength: stored.byteLength,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
  }
}
