import { BoundedMetricAccumulator } from '@features/hosted-operations';
import { describe, expect, it } from 'vitest';

describe('BoundedMetricAccumulator', () => {
  it('caps label cardinality and never turns correlation identifiers into labels', () => {
    const metrics = new BoundedMetricAccumulator({ maxSeries: 2 });

    metrics.increment('http_request', 'succeeded');
    metrics.increment('http_request', 'succeeded');
    metrics.increment('sse_connection', 'failed');
    metrics.increment('run_operation', 'started');
    metrics.increment('team_operation', 'rejected', 2);

    const snapshot = metrics.snapshot(100);

    expect(snapshot.series).toEqual([
      {
        name: 'operation_events_total',
        labels: { area: 'http', outcome: 'succeeded' },
        value: 2,
      },
      {
        name: 'operation_events_total',
        labels: { area: 'sse', outcome: 'failed' },
        value: 1,
      },
    ]);
    expect(snapshot.series).toHaveLength(2);
    expect(snapshot.discardedObservations).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain('request_');
    expect(Object.isFrozen(snapshot.series)).toBe(true);
    expect(Object.isFrozen(snapshot.series[0].labels)).toBe(true);
  });

  it('supports a zero-series budget without growing internal cardinality', () => {
    const metrics = new BoundedMetricAccumulator({ maxSeries: 0 });
    metrics.increment('retention', 'succeeded', 3);

    expect(metrics.snapshot(0)).toMatchObject({
      maxSeries: 0,
      series: [],
      discardedObservations: 3,
    });
  });
});
