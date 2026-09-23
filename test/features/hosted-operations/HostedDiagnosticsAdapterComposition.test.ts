import {
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  parseHostedDiagnosticsRequest,
} from '@features/hosted-operations/contracts';
import {
  createHostedDiagnosticsAdapters,
  createHostedDiagnosticsFeature,
} from '@features/hosted-operations/main/hosted';
import { createQueryContext } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostedDiagnosticsSourceRecord } from '@features/hosted-operations/main/hosted';

function context() {
  return createQueryContext({
    actorId: 'actor_diagnostics-composition',
    sessionId: 'session_diagnostics-composition',
    deploymentId: 'deployment_diagnostics-composition',
    bootId: 'boot_diagnostics-composition',
    requestId: `request_${'a'.repeat(32)}`,
    authorizedScope: 'scope_diagnostics-composition',
    deadlineAtMs: Date.now() + 10_000,
    signal: new AbortController().signal,
  });
}

function sourceRecord(attributes: unknown = {}): HostedDiagnosticsSourceRecord {
  return {
    kind: 'reference_load',
    outcome: 'failed',
    occurredAtMonotonicMs: 7,
    attributes,
  };
}

describe('createHostedDiagnosticsAdapters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wires the bounded store into the hosted diagnostics use case', async () => {
    const adapters = createHostedDiagnosticsAdapters();
    const queryContext = context();
    const privateDetail = ['private', 'diagnostic', 'detail'].join('-');
    const referenceId = adapters.recorder.record(
      sourceRecord({
        component: 'reference_loader',
        operation: 'load',
        reason: privateDetail,
        ignored: ['runtime', 'location'].join('-'),
      }),
      queryContext
    );
    const result = await createHostedDiagnosticsFeature(adapters).getDiagnostics(
      {
        schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
        referenceIds: [referenceId],
      },
      queryContext
    );

    expect(result).toMatchObject({
      kind: 'success',
      correlation: {
        requestId: queryContext.requestId,
        diagnosticId: expect.stringMatching(/^diagnostic_[0-9a-f]{32}$/),
      },
      items: [
        {
          referenceId,
          attributes: {
            component: 'reference_loader',
            operation: 'load',
            reason: 'redacted',
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    adapters.close();
  });

  it('queries only retained server responses for the authenticated deployment and boot', async () => {
    const adapters = createHostedDiagnosticsAdapters({
      retentionBudget: { maxEntries: 2, maxAgeMs: 60_000, maxTotalBytes: 10_000 },
    });
    const owner = context();
    adapters.recorder.recordServerResponse(200, owner);
    adapters.recorder.recordServerResponse(503, owner, true);
    adapters.recorder.recordServerResponse(401, owner);
    const feature = createHostedDiagnosticsFeature(adapters);
    const request = {
      schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
      referenceIds: [],
      recentServerLogs: true,
    };
    expect(
      parseHostedDiagnosticsRequest({ ...request, referenceIds: ['reference_' + 'a'.repeat(32)] })
        .ok
    ).toBe(false);
    const result = await feature.getDiagnostics(request, owner);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('Expected server diagnostics');
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.outcome)).toEqual(['failed', 'rejected']);
    expect(result.items.every((item) => /^request_[0-9a-f]{32}$/.test(item.requestId ?? ''))).toBe(
      true
    );
    expect(
      result.items.every((item) => /^diagnostic_[0-9a-f]{32}$/.test(item.diagnosticId ?? ''))
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('provider');
    expect(JSON.stringify(result)).not.toContain('token');
    const otherBoot = createQueryContext({ ...owner, bootId: 'boot_other' });
    const isolated = await feature.getDiagnostics(request, otherBoot);
    expect(isolated).toMatchObject({ kind: 'success', items: [] });
    adapters.close();
  });

  it('mints parser-valid IDs, runs deadlines once, and cancels timers', async () => {
    vi.useFakeTimers();
    const adapters = createHostedDiagnosticsAdapters();
    const deadline = vi.fn();
    const cancelled = vi.fn();
    const cancelDeadline = adapters.deadlineScheduler.schedule(25, deadline);
    const cancelOutstanding = adapters.deadlineScheduler.schedule(25, cancelled);

    expect(adapters.diagnosticIds.generateDiagnosticId()).toMatch(/^diagnostic_[0-9a-f]{32}$/);
    expect(adapters.correlationIds.resolveCorrelationId(context().requestId)).toMatch(
      /^request_[0-9a-f]{32}$/
    );
    cancelOutstanding();
    cancelOutstanding();
    await vi.advanceTimersByTimeAsync(25);
    expect(deadline).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    cancelDeadline();
    adapters.close();
  });

  it('rejects accessor options without invoking them and invalidates references after restart', async () => {
    let getterReads = 0;
    const accessorOptions = Object.defineProperty({}, 'retentionBudget', {
      enumerable: true,
      get() {
        getterReads += 1;
        return { maxEntries: 1, maxAgeMs: 1, maxTotalBytes: 1 };
      },
    });

    expect(() => createHostedDiagnosticsAdapters(accessorOptions)).toThrow(
      'hosted-diagnostics-adapters-options-invalid'
    );
    expect(getterReads).toBe(0);

    const owner = context();
    const firstProcess = createHostedDiagnosticsAdapters();
    const referenceId = firstProcess.recorder.record(sourceRecord(), owner);
    const restarted = createHostedDiagnosticsAdapters();

    await expect(restarted.source.load(referenceId, owner)).rejects.toThrow(
      'hosted-diagnostics-unavailable'
    );
    firstProcess.close();
    restarted.close();
  });
});
