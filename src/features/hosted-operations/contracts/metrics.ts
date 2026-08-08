import type { OperationOutcome } from './events';

export const OPERATION_AREAS = Object.freeze([
  'http',
  'sse',
  'run',
  'team',
  'reference',
  'retention',
] as const);

export type OperationArea = (typeof OPERATION_AREAS)[number];

export const OPERATIONS_EVENT_COUNT_METRIC = 'operation_events_total' as const;

export interface OperationsMetricLabels {
  readonly area: OperationArea;
  readonly outcome: OperationOutcome;
}

export interface OperationsMetricSeries {
  readonly name: typeof OPERATIONS_EVENT_COUNT_METRIC;
  readonly labels: OperationsMetricLabels;
  readonly value: number;
}

export interface OperationsMetricSnapshot {
  readonly capturedAtMonotonicMs: number;
  readonly maxSeries: number;
  readonly series: readonly OperationsMetricSeries[];
  /** Observations dropped because accepting their label set would exceed maxSeries. */
  readonly discardedObservations: number;
}
