import {
  createOperationCorrelationContext,
  type OperationCorrelationContext,
  type OperationEventKind,
  type OperationOutcome,
  OPERATIONS_EVENT_SCHEMA_VERSION,
  type OperationsMetricSnapshot,
  type SafeOperationsEvent,
} from '../../contracts';
import { snapshotExactDataRecord } from '../../contracts/exactDataSnapshot';
import {
  assertCorrelationSupportsEvent,
  assertOperationEventKind,
  assertOperationOutcome,
  redactOperationAttributes,
} from '../domain';

import { BoundedMetricAccumulator } from './BoundedMetricAccumulator';
import { DiagnosticContextService } from './DiagnosticContextService';
import { OperationsRecordingCancelledError } from './errors';

import type { MonotonicClockPort, OperationsEventSinkPort } from './ports';

export interface RecordOperationsEventInput {
  readonly kind: OperationEventKind;
  readonly outcome: OperationOutcome;
  readonly correlation: OperationCorrelationContext;
  readonly attributes?: unknown;
  readonly signal: AbortSignal;
}

export interface OperationsTelemetryServiceDeps {
  readonly clock: MonotonicClockPort;
  readonly eventSink: OperationsEventSinkPort;
  readonly diagnostics: DiagnosticContextService;
  readonly metrics: BoundedMetricAccumulator;
}

function assertMonotonicTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('hosted-operations-monotonic-time-invalid');
  }
}

function needsDiagnosticId(outcome: OperationOutcome): boolean {
  return outcome === 'failed' || outcome === 'rejected';
}

export class OperationsTelemetryService {
  constructor(private readonly deps: OperationsTelemetryServiceDeps) {}

  async record(input: RecordOperationsEventInput): Promise<SafeOperationsEvent> {
    const inputSnapshot = snapshotExactDataRecord(
      input,
      ['kind', 'outcome', 'correlation', 'signal'],
      'hosted-operations-event-input-invalid',
      { optionalKeys: ['attributes'] }
    );
    const kind = inputSnapshot.kind;
    const outcome = inputSnapshot.outcome;
    const signal = inputSnapshot.signal;
    assertOperationEventKind(kind);
    assertOperationOutcome(outcome);
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('hosted-operations-signal-invalid');
    }
    if (signal.aborted) throw new OperationsRecordingCancelledError();

    const initialCorrelation = createOperationCorrelationContext(inputSnapshot.correlation);
    assertCorrelationSupportsEvent(kind, initialCorrelation);
    const diagnosedCorrelation = needsDiagnosticId(outcome)
      ? this.deps.diagnostics.ensureDiagnosticId(initialCorrelation)
      : initialCorrelation;
    const correlation = createOperationCorrelationContext(diagnosedCorrelation);
    const occurredAtMonotonicMs = this.deps.clock.nowMs();
    assertMonotonicTime(occurredAtMonotonicMs);

    const event: SafeOperationsEvent = Object.freeze({
      schemaVersion: OPERATIONS_EVENT_SCHEMA_VERSION,
      kind,
      outcome,
      occurredAtMonotonicMs,
      correlation,
      attributes: redactOperationAttributes(inputSnapshot.attributes),
    });

    if (signal.aborted) throw new OperationsRecordingCancelledError();
    await this.deps.eventSink.write(event, { signal });
    this.deps.metrics.increment(kind, outcome);
    return event;
  }

  metricSnapshot(): OperationsMetricSnapshot {
    return this.deps.metrics.snapshot(this.deps.clock.nowMs());
  }
}
