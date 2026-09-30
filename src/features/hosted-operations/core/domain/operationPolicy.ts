import {
  OPERATION_EVENT_KINDS,
  OPERATION_OUTCOMES,
  type OperationArea,
  type OperationCorrelationContext,
  type OperationEventKind,
  type OperationOutcome,
} from '../../contracts';

const AREA_BY_EVENT_KIND: Readonly<Record<OperationEventKind, OperationArea>> = Object.freeze({
  http_request: 'http',
  sse_connection: 'sse',
  run_operation: 'run',
  team_operation: 'team',
  reference_load: 'reference',
  retention: 'retention',
});

export function assertOperationEventKind(value: unknown): asserts value is OperationEventKind {
  if (!OPERATION_EVENT_KINDS.includes(value as OperationEventKind)) {
    throw new TypeError('hosted-operations-event-kind-invalid');
  }
}

export function assertOperationOutcome(value: unknown): asserts value is OperationOutcome {
  if (!OPERATION_OUTCOMES.includes(value as OperationOutcome)) {
    throw new TypeError('hosted-operations-outcome-invalid');
  }
}

export function operationAreaForEventKind(kind: OperationEventKind): OperationArea {
  assertOperationEventKind(kind);
  return AREA_BY_EVENT_KIND[kind];
}

export function assertCorrelationSupportsEvent(
  kind: OperationEventKind,
  correlation: OperationCorrelationContext
): void {
  const missingRequiredScope =
    (kind === 'sse_connection' && correlation.sseConnectionId === undefined) ||
    (kind === 'run_operation' && correlation.runId === undefined) ||
    (kind === 'team_operation' && correlation.teamId === undefined);

  if (missingRequiredScope) {
    throw new TypeError('hosted-operations-correlation-scope-missing');
  }
}
