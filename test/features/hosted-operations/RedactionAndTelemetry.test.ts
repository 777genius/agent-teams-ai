import {
  BoundedMetricAccumulator,
  createOperationCorrelationContext,
  DiagnosticContextService,
  type DiagnosticId,
  OperationsRecordingCancelledError,
  OperationsTelemetryService,
  parseOperationCorrelationId,
  type RecordOperationsEventInput,
  redactOperationAttributes,
  type SafeOperationsEvent,
} from '@features/hosted-operations';
import { describe, expect, it, vi } from 'vitest';

const REQUEST_ID = parseOperationCorrelationId(`request_${'0'.repeat(32)}`);
const TEAM_ID = `team_${'1'.repeat(32)}`;
const DIAGNOSTIC_ID = `diagnostic_${'2'.repeat(32)}` as DiagnosticId;
const POST_VALIDATION_SECRET = ['sk', 'post', 'validation', 'secret'].join('-');

describe('operations redaction and telemetry', () => {
  it('allowlists machine attributes without reading accessors or retaining content fields', () => {
    let getterRead = false;
    const attributes = Object.defineProperties(
      {
        component: 'team_controller',
        reason: 'private_prompt_content',
        message: 'private prompt content',
        token: 'provider-secret',
      },
      {
        state: {
          enumerable: true,
          get() {
            getterRead = true;
            return 'ready';
          },
        },
      }
    );

    const redacted = redactOperationAttributes(attributes);

    expect(redacted).toEqual({
      component: 'team_controller',
      reason: 'redacted',
    });
    expect(getterRead).toBe(false);
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(JSON.stringify(redacted)).not.toContain('private prompt');
    expect(Object.isFrozen(redacted)).toBe(true);
  });

  it('emits a frozen safe failure event and derives metrics only from fixed labels', async () => {
    const events: SafeOperationsEvent[] = [];
    const clockValues = [41, 42];
    const service = new OperationsTelemetryService({
      clock: { nowMs: () => clockValues.shift() ?? 42 },
      eventSink: {
        async write(event) {
          events.push(event);
        },
      },
      diagnostics: new DiagnosticContextService({
        generateDiagnosticId: () => DIAGNOSTIC_ID,
      }),
      metrics: new BoundedMetricAccumulator({ maxSeries: 4 }),
    });
    const correlation = createOperationCorrelationContext({
      requestId: REQUEST_ID,
      teamId: TEAM_ID,
    });

    const event = await service.record({
      kind: 'team_operation',
      outcome: 'failed',
      correlation,
      attributes: {
        component: 'team_controller',
        operation: 'launch',
        reason: 'failure included private task body',
        content: 'do not emit this task content',
        apiKey: 'sk-super-secret',
      },
      signal: new AbortController().signal,
    });
    const snapshot = service.metricSnapshot();
    const serialized = JSON.stringify({ event, snapshot });

    expect(events).toEqual([event]);
    expect(event).toEqual({
      schemaVersion: 1,
      kind: 'team_operation',
      outcome: 'failed',
      occurredAtMonotonicMs: 41,
      correlation: {
        requestId: REQUEST_ID,
        teamId: TEAM_ID,
        diagnosticId: DIAGNOSTIC_ID,
      },
      attributes: {
        component: 'team_controller',
        operation: 'launch',
        reason: 'redacted',
      },
    });
    expect(snapshot.series).toEqual([
      {
        name: 'operation_events_total',
        labels: { area: 'team', outcome: 'failed' },
        value: 1,
      },
    ]);
    expect(serialized).not.toContain('private task');
    expect(serialized).not.toContain('sk-super-secret');
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.correlation)).toBe(true);
  });

  it('honors cancellation before producing an event or metric', async () => {
    const write = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const metrics = new BoundedMetricAccumulator({ maxSeries: 2 });
    const service = new OperationsTelemetryService({
      clock: { nowMs: () => 1 },
      eventSink: { write },
      diagnostics: new DiagnosticContextService({
        generateDiagnosticId: () => DIAGNOSTIC_ID,
      }),
      metrics,
    });

    await expect(
      service.record({
        kind: 'http_request',
        outcome: 'succeeded',
        correlation: createOperationCorrelationContext({ requestId: REQUEST_ID }),
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(OperationsRecordingCancelledError);
    expect(write).not.toHaveBeenCalled();
    expect(metrics.snapshot(2).series).toEqual([]);
  });

  it('rejects an event missing its required scoped correlation', async () => {
    const service = new OperationsTelemetryService({
      clock: { nowMs: () => 1 },
      eventSink: { write: vi.fn() },
      diagnostics: new DiagnosticContextService({
        generateDiagnosticId: () => DIAGNOSTIC_ID,
      }),
      metrics: new BoundedMetricAccumulator({ maxSeries: 2 }),
    });

    await expect(
      service.record({
        kind: 'sse_connection',
        outcome: 'started',
        correlation: createOperationCorrelationContext({ requestId: REQUEST_ID }),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('hosted-operations-correlation-scope-missing');
  });

  it('rejects stateful input accessors before validation or event delivery', async () => {
    let getterReads = 0;
    let descriptorReads = 0;
    const write = vi.fn();
    const service = new OperationsTelemetryService({
      clock: { nowMs: () => 1 },
      eventSink: { write },
      diagnostics: new DiagnosticContextService({
        generateDiagnosticId: () => DIAGNOSTIC_ID,
      }),
      metrics: new BoundedMetricAccumulator({ maxSeries: 2 }),
    });
    const accessorInput = Object.defineProperties(
      {},
      {
        kind: {
          enumerable: true,
          get() {
            getterReads += 1;
            return getterReads === 1 ? 'team_operation' : POST_VALIDATION_SECRET;
          },
        },
        outcome: { enumerable: true, value: 'succeeded' },
        correlation: {
          enumerable: true,
          value: createOperationCorrelationContext({ requestId: REQUEST_ID, teamId: TEAM_ID }),
        },
        signal: { enumerable: true, value: new AbortController().signal },
      }
    );
    const input = new Proxy(accessorInput, {
      getOwnPropertyDescriptor(target, key) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    await expect(service.record(input as RecordOperationsEventInput)).rejects.toThrow(
      'hosted-operations-event-input-invalid'
    );
    expect(getterReads).toBe(0);
    expect(descriptorReads).toBeGreaterThan(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('uses one descriptor snapshot and never re-reads a stateful proxy', async () => {
    const events: SafeOperationsEvent[] = [];
    let directReads = 0;
    let kindDescriptorReads = 0;
    const target: Record<string, unknown> = {
      kind: 'team_operation',
      outcome: 'succeeded',
      correlation: createOperationCorrelationContext({ requestId: REQUEST_ID, teamId: TEAM_ID }),
      signal: new AbortController().signal,
    };
    const input = new Proxy(target, {
      get(current, key, receiver) {
        directReads += 1;
        if (key === 'kind') return POST_VALIDATION_SECRET;
        return Reflect.get(current, key, receiver);
      },
      getOwnPropertyDescriptor(current, key) {
        if (key === 'kind') kindDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(current, key);
      },
    });
    const service = new OperationsTelemetryService({
      clock: {
        nowMs() {
          target.kind = POST_VALIDATION_SECRET;
          target.outcome = POST_VALIDATION_SECRET;
          return 7;
        },
      },
      eventSink: {
        async write(event) {
          events.push(event);
        },
      },
      diagnostics: new DiagnosticContextService({
        generateDiagnosticId: () => DIAGNOSTIC_ID,
      }),
      metrics: new BoundedMetricAccumulator({ maxSeries: 2 }),
    });

    const event = await service.record(input as unknown as RecordOperationsEventInput);

    expect(event.kind).toBe('team_operation');
    expect(event.outcome).toBe('succeeded');
    expect(events).toEqual([event]);
    expect(directReads).toBe(0);
    expect(kindDescriptorReads).toBe(1);
    expect(JSON.stringify(event)).not.toContain(POST_VALIDATION_SECRET);
  });

  it('does not call the sink when diagnostic enrichment returns secret-bearing correlation', async () => {
    const write = vi.fn();
    const diagnostics = new DiagnosticContextService({
      generateDiagnosticId: () => DIAGNOSTIC_ID,
    });
    vi.spyOn(diagnostics, 'ensureDiagnosticId').mockReturnValue({
      requestId: 'request_sk-super-secret',
      teamId: TEAM_ID,
      diagnosticId: DIAGNOSTIC_ID,
    } as never);
    const service = new OperationsTelemetryService({
      clock: { nowMs: () => 1 },
      eventSink: { write },
      diagnostics,
      metrics: new BoundedMetricAccumulator({ maxSeries: 2 }),
    });

    await expect(
      service.record({
        kind: 'team_operation',
        outcome: 'failed',
        correlation: createOperationCorrelationContext({ requestId: REQUEST_ID, teamId: TEAM_ID }),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('hosted-operations-correlation-invalid');
    expect(write).not.toHaveBeenCalled();
  });
});
