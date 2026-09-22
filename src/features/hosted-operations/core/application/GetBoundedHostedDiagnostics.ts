import { createQueryContext, type QueryContext } from '@shared/contracts/hosted';

import {
  createHostedDiagnosticsFailure,
  createOperationCorrelationContext,
  HOSTED_DIAGNOSTICS_REFERENCE_BUDGET,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  type HostedDiagnosticItem,
  type HostedDiagnosticsResponse,
  type HostedDiagnosticsSuccess,
  OPERATION_EVENT_KINDS,
  OPERATION_OUTCOMES,
  type OperationEventKind,
  type OperationOutcome,
  parseHostedDiagnosticsRequest,
  parseOperationCorrelationId,
} from '../../contracts';
import { snapshotExactDataRecord } from '../../contracts/exactDataSnapshot';
import { redactOperationAttributes } from '../domain';

import { BoundedReferenceLoader } from './BoundedReferenceLoader';
import { DiagnosticContextService } from './DiagnosticContextService';
import { ReferenceLoadError } from './errors';

import type {
  HostedDiagnosticsCorrelationIdPort,
  HostedDiagnosticsDeadlineSchedulerPort,
  HostedDiagnosticsSourcePort,
  HostedDiagnosticsSourceRecord,
} from './ports/HostedDiagnosticsPorts';

interface DeadlineScope {
  readonly signal: AbortSignal;
  readonly deadlineElapsed: () => boolean;
  readonly dispose: () => void;
}

function validNowMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function createDeadlineScope(
  context: QueryContext,
  scheduler: HostedDiagnosticsDeadlineSchedulerPort
): DeadlineScope | null {
  const startedAtMs = scheduler.nowMs();
  if (!validNowMs(startedAtMs)) {
    throw new TypeError('hosted-diagnostics-deadline-clock-invalid');
  }
  if (context.signal.aborted || startedAtMs >= context.deadlineAtMs) return null;

  const controller = new AbortController();
  let active = true;
  let deadlineElapsed = false;
  const abortFromParent = (): void => controller.abort();
  context.signal.addEventListener('abort', abortFromParent, { once: true });
  if (context.signal.aborted) abortFromParent();

  let cancelDeadline: (() => void) | undefined;
  try {
    cancelDeadline = scheduler.schedule(context.deadlineAtMs - startedAtMs, () => {
      if (!active) return;
      deadlineElapsed = true;
      controller.abort();
    });
    if (typeof cancelDeadline !== 'function') {
      throw new TypeError('hosted-diagnostics-deadline-scheduler-invalid');
    }
  } catch (error) {
    active = false;
    context.signal.removeEventListener('abort', abortFromParent);
    controller.abort();
    throw error;
  }

  return Object.freeze({
    signal: controller.signal,
    deadlineElapsed: () => {
      if (deadlineElapsed) return true;
      const nowMs = scheduler.nowMs();
      if (!validNowMs(nowMs)) {
        throw new TypeError('hosted-diagnostics-deadline-clock-invalid');
      }
      if (nowMs < context.deadlineAtMs) return false;
      deadlineElapsed = true;
      controller.abort();
      return true;
    },
    dispose: () => {
      if (!active) return;
      active = false;
      try {
        cancelDeadline?.();
      } finally {
        context.signal.removeEventListener('abort', abortFromParent);
      }
    },
  });
}

function contextWithSignal(context: QueryContext, signal: AbortSignal): QueryContext {
  return createQueryContext({
    actorId: context.actorId,
    sessionId: context.sessionId,
    deploymentId: context.deploymentId,
    bootId: context.bootId,
    requestId: context.requestId,
    authorizedScope: context.authorizedScope,
    deadlineAtMs: context.deadlineAtMs,
    signal,
  });
}

function requestCancelled(context: QueryContext, scope: DeadlineScope): boolean {
  return context.signal.aborted || scope.signal.aborted || scope.deadlineElapsed();
}

function parseSourceRecord(
  value: HostedDiagnosticsSourceRecord,
  referenceId: HostedDiagnosticItem['referenceId'],
  byteLength: number
): HostedDiagnosticItem {
  const input = snapshotExactDataRecord(
    value,
    ['kind', 'outcome', 'occurredAtMonotonicMs', 'attributes'],
    'hosted-diagnostics-source-record-invalid'
  );
  const kind = input.kind;
  const outcome = input.outcome;
  const occurredAtMonotonicMs = input.occurredAtMonotonicMs;
  if (
    !OPERATION_EVENT_KINDS.includes(kind as OperationEventKind) ||
    !OPERATION_OUTCOMES.includes(outcome as OperationOutcome) ||
    !Number.isSafeInteger(occurredAtMonotonicMs) ||
    (occurredAtMonotonicMs as number) < 0
  ) {
    throw new TypeError('hosted-diagnostics-source-record-invalid');
  }

  return Object.freeze({
    referenceId,
    kind: kind as OperationEventKind,
    outcome: outcome as OperationOutcome,
    occurredAtMonotonicMs: occurredAtMonotonicMs as number,
    attributes: redactOperationAttributes(input.attributes),
    byteLength,
  });
}

function referenceFailure(
  error: ReferenceLoadError,
  diagnosticId?: HostedDiagnosticsSuccess['correlation']['diagnosticId']
): HostedDiagnosticsResponse {
  switch (error.code) {
    case 'reference_count_exceeded':
    case 'reference_item_bytes_exceeded':
    case 'reference_total_bytes_exceeded':
      return createHostedDiagnosticsFailure('reference_budget_exceeded', diagnosticId);
    case 'reference_load_cancelled':
      return createHostedDiagnosticsFailure('request_cancelled', diagnosticId);
    case 'reference_source_failed':
    case 'reference_source_result_invalid':
      return createHostedDiagnosticsFailure('diagnostics_unavailable', diagnosticId);
  }
}

/** Reads only opaque references through fixed host budgets and returns a redacted browser DTO. */
export class GetBoundedHostedDiagnostics {
  constructor(
    private readonly source: HostedDiagnosticsSourcePort,
    private readonly diagnostics: DiagnosticContextService,
    private readonly correlationIds: HostedDiagnosticsCorrelationIdPort,
    private readonly deadlineScheduler: HostedDiagnosticsDeadlineSchedulerPort
  ) {}

  async execute(requestValue: unknown, context: QueryContext): Promise<HostedDiagnosticsResponse> {
    let queryContext: QueryContext;
    let correlation: HostedDiagnosticsSuccess['correlation'];
    try {
      queryContext = createQueryContext(context);
      let requestId;
      try {
        requestId = parseOperationCorrelationId(queryContext.requestId);
      } catch {
        requestId = parseOperationCorrelationId(
          this.correlationIds.resolveCorrelationId(queryContext.requestId)
        );
      }
      const diagnosed = this.diagnostics.ensureDiagnosticId(
        createOperationCorrelationContext({
          requestId,
        })
      );
      if (diagnosed.diagnosticId === undefined) throw new TypeError();
      correlation = diagnosed as HostedDiagnosticsSuccess['correlation'];
    } catch {
      return createHostedDiagnosticsFailure('diagnostics_unavailable');
    }

    let deadlineScope: DeadlineScope | null;
    try {
      deadlineScope = createDeadlineScope(queryContext, this.deadlineScheduler);
    } catch {
      return createHostedDiagnosticsFailure('diagnostics_unavailable', correlation.diagnosticId);
    }
    if (deadlineScope === null) {
      return createHostedDiagnosticsFailure('request_cancelled', correlation.diagnosticId);
    }

    try {
      const request = parseHostedDiagnosticsRequest(requestValue);
      if (!request.ok) {
        return createHostedDiagnosticsFailure('request_invalid', correlation.diagnosticId);
      }

      const loader = new BoundedReferenceLoader<HostedDiagnosticsSourceRecord>({
        load: (referenceId, { signal }) =>
          this.source.load(referenceId, contextWithSignal(queryContext, signal)),
      });

      const loaded = await loader.load({
        referenceIds: request.value.referenceIds,
        budget: HOSTED_DIAGNOSTICS_REFERENCE_BUDGET,
        signal: deadlineScope.signal,
      });
      if (requestCancelled(queryContext, deadlineScope)) {
        return createHostedDiagnosticsFailure('request_cancelled', correlation.diagnosticId);
      }

      const items = loaded.references.map(({ referenceId, value, byteLength }) =>
        parseSourceRecord(value, referenceId, byteLength)
      );
      if (requestCancelled(queryContext, deadlineScope)) {
        return createHostedDiagnosticsFailure('request_cancelled', correlation.diagnosticId);
      }
      return Object.freeze({
        schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
        kind: 'success',
        correlation,
        items: Object.freeze(items),
        totalBytes: loaded.totalBytes,
      });
    } catch (error) {
      try {
        if (requestCancelled(queryContext, deadlineScope)) {
          return createHostedDiagnosticsFailure('request_cancelled', correlation.diagnosticId);
        }
      } catch {
        return createHostedDiagnosticsFailure('diagnostics_unavailable', correlation.diagnosticId);
      }
      if (error instanceof ReferenceLoadError) {
        return referenceFailure(error, correlation.diagnosticId);
      }
      return createHostedDiagnosticsFailure('diagnostics_unavailable', correlation.diagnosticId);
    } finally {
      try {
        deadlineScope.dispose();
      } catch {
        // A server scheduler cleanup failure must not replace the bounded safe response.
      }
    }
  }
}
