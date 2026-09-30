import {
  type OperationEventKind,
  type OperationOutcome,
  OPERATIONS_EVENT_COUNT_METRIC,
  type OperationsMetricSeries,
  type OperationsMetricSnapshot,
} from '../../contracts';
import { snapshotExactDataRecord } from '../../contracts/exactDataSnapshot';
import {
  assertOperationEventKind,
  assertOperationOutcome,
  operationAreaForEventKind,
} from '../domain';

interface MutableSeries {
  readonly kind: OperationEventKind;
  readonly outcome: OperationOutcome;
  value: number;
}

export interface BoundedMetricAccumulatorOptions {
  readonly maxSeries: number;
}

/** Instance-scoped accumulator with fixed labels and a hard cap on accepted label sets. */
export class BoundedMetricAccumulator {
  readonly #maxSeries: number;
  readonly #series = new Map<string, MutableSeries>();
  #discardedObservations = 0;

  constructor(options: BoundedMetricAccumulatorOptions) {
    const snapshot = snapshotExactDataRecord(
      options,
      ['maxSeries'],
      'hosted-operations-metric-limit-invalid',
      { rejectProxy: true }
    );
    const maxSeries = snapshot.maxSeries;
    if (typeof maxSeries !== 'number' || !Number.isSafeInteger(maxSeries) || maxSeries < 0) {
      throw new TypeError('hosted-operations-metric-limit-invalid');
    }
    this.#maxSeries = maxSeries;
  }

  increment(kind: OperationEventKind, outcome: OperationOutcome, amount = 1): void {
    assertOperationEventKind(kind);
    assertOperationOutcome(outcome);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new TypeError('hosted-operations-metric-amount-invalid');
    }

    const area = operationAreaForEventKind(kind);
    const seriesKey = `${area}\u0000${outcome}`;
    const existing = this.#series.get(seriesKey);
    if (existing) {
      existing.value = Math.min(Number.MAX_SAFE_INTEGER, existing.value + amount);
      return;
    }
    if (this.#series.size >= this.#maxSeries) {
      this.#discardedObservations = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#discardedObservations + amount
      );
      return;
    }
    this.#series.set(seriesKey, { kind, outcome, value: amount });
  }

  snapshot(capturedAtMonotonicMs: number): OperationsMetricSnapshot {
    if (!Number.isSafeInteger(capturedAtMonotonicMs) || capturedAtMonotonicMs < 0) {
      throw new TypeError('hosted-operations-metric-time-invalid');
    }

    const series: OperationsMetricSeries[] = [...this.#series.entries()]
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
      .map(([, item]) =>
        Object.freeze({
          name: OPERATIONS_EVENT_COUNT_METRIC,
          labels: Object.freeze({
            area: operationAreaForEventKind(item.kind),
            outcome: item.outcome,
          }),
          value: item.value,
        })
      );

    return Object.freeze({
      capturedAtMonotonicMs,
      maxSeries: this.#maxSeries,
      series: Object.freeze(series),
      discardedObservations: this.#discardedObservations,
    });
  }
}
