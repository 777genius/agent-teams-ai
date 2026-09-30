import {
  HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE,
  HOSTED_DIAGNOSTICS_MAX_REFERENCES,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  parseDiagnosticId,
  parseOperationalReferenceId,
  parseOperationCorrelationId,
} from '@features/hosted-operations/contracts';
import { DiagnosticContextService } from '@features/hosted-operations/core/application/DiagnosticContextService';
import { GetBoundedHostedDiagnostics } from '@features/hosted-operations/core/application/GetBoundedHostedDiagnostics';
import { createQueryContext } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedDiagnosticsCorrelationIdPort,
  HostedDiagnosticsDeadlineSchedulerPort,
  HostedDiagnosticsSourcePort,
} from '@features/hosted-operations/core/application/ports/HostedDiagnosticsPorts';

const DIAGNOSTIC_ID = parseDiagnosticId(`diagnostic_${'d'.repeat(32)}`);
const FALLBACK_CORRELATION_ID = parseOperationCorrelationId(`request_${'c'.repeat(32)}`);
const PRIVATE_VALUE = ['provider', 'private', 'stderr', 'token'].join('-');

function reference(index = 0) {
  return parseOperationalReferenceId(`reference_${index.toString(16).padStart(32, '0')}`);
}

function queryContext(
  options: {
    readonly signal?: AbortSignal;
    readonly requestId?: string;
    readonly deadlineAtMs?: number;
  } = {}
) {
  return createQueryContext({
    actorId: 'actor_diagnostics-test',
    sessionId: 'session_diagnostics-test',
    deploymentId: 'deployment_diagnostics-test',
    bootId: 'boot_diagnostics-test',
    requestId: options.requestId ?? `request_${'a'.repeat(32)}`,
    authorizedScope: 'scope_diagnostics-test',
    deadlineAtMs: options.deadlineAtMs ?? 10_000,
    signal: options.signal ?? new AbortController().signal,
  });
}

function request(referenceIds = [reference()]) {
  return {
    schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
    referenceIds,
  };
}

function createDeadlineHarness(initialNowMs = 0) {
  let nowMs = initialNowMs;
  let onDeadline: (() => void) | undefined;
  const cancel = vi.fn(() => {
    onDeadline = undefined;
  });
  const schedule = vi.fn<HostedDiagnosticsDeadlineSchedulerPort['schedule']>(
    (_delayMs, callback) => {
      onDeadline = callback;
      return cancel;
    }
  );
  const port: HostedDiagnosticsDeadlineSchedulerPort = {
    nowMs: () => nowMs,
    schedule,
  };
  return {
    cancel,
    port,
    schedule,
    elapse(atMs: number) {
      nowMs = atMs;
      onDeadline?.();
    },
  };
}

function useCase(
  source: HostedDiagnosticsSourcePort,
  options: {
    readonly correlationIds?: HostedDiagnosticsCorrelationIdPort;
    readonly deadlineScheduler?: HostedDiagnosticsDeadlineSchedulerPort;
  } = {}
) {
  return new GetBoundedHostedDiagnostics(
    source,
    new DiagnosticContextService({ generateDiagnosticId: () => DIAGNOSTIC_ID }),
    options.correlationIds ?? {
      resolveCorrelationId: () => FALLBACK_CORRELATION_ID,
    },
    options.deadlineScheduler ?? createDeadlineHarness().port
  );
}

describe('GetBoundedHostedDiagnostics', () => {
  it('scopes every bounded read to QueryContext and emits only redacted structured fields', async () => {
    const contexts: ReturnType<typeof queryContext>[] = [];
    const source: HostedDiagnosticsSourcePort = {
      load: vi.fn<HostedDiagnosticsSourcePort['load']>(async (_referenceId, context) => {
        contexts.push(context);
        return {
          value: {
            kind: 'reference_load',
            outcome: 'failed',
            occurredAtMonotonicMs: 42,
            attributes: {
              component: 'reference_loader',
              operation: 'load',
              reason: PRIVATE_VALUE,
              path: '/private/runtime/file',
              token: PRIVATE_VALUE,
            },
          },
          byteLength: 128,
        };
      }),
    };
    const parentContext = queryContext();

    const result = await useCase(source).execute(request(), parentContext);

    expect(result).toEqual({
      schemaVersion: 1,
      kind: 'success',
      correlation: {
        requestId: parentContext.requestId,
        diagnosticId: DIAGNOSTIC_ID,
      },
      items: [
        {
          referenceId: reference(),
          kind: 'reference_load',
          outcome: 'failed',
          occurredAtMonotonicMs: 42,
          attributes: {
            component: 'reference_loader',
            operation: 'load',
            reason: 'redacted',
          },
          byteLength: 128,
        },
      ],
      totalBytes: 128,
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      actorId: parentContext.actorId,
      sessionId: parentContext.sessionId,
      deploymentId: parentContext.deploymentId,
      bootId: parentContext.bootId,
      requestId: parentContext.requestId,
      authorizedScope: parentContext.authorizedScope,
      deadlineAtMs: parentContext.deadlineAtMs,
    });
    expect(contexts[0].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    expect(JSON.stringify(result)).not.toContain('/private/runtime/file');
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.kind === 'success' && Object.isFrozen(result.items)).toBe(true);
  });

  it('resolves a strict correlation ID for a valid non-canonical public requestId', async () => {
    const resolveCorrelationId = vi.fn(() => FALLBACK_CORRELATION_ID);
    const context = queryContext({ requestId: 'request_public-valid-id' });
    const source: HostedDiagnosticsSourcePort = {
      async load() {
        return {
          value: {
            kind: 'reference_load',
            outcome: 'succeeded',
            occurredAtMonotonicMs: 1,
            attributes: {},
          },
          byteLength: 1,
        };
      },
    };

    const result = await useCase(source, {
      correlationIds: { resolveCorrelationId },
    }).execute(request(), context);

    expect(result).toMatchObject({
      kind: 'success',
      correlation: {
        requestId: FALLBACK_CORRELATION_ID,
        diagnosticId: DIAGNOSTIC_ID,
      },
    });
    expect(resolveCorrelationId).toHaveBeenCalledOnce();
    expect(resolveCorrelationId).toHaveBeenCalledWith(context.requestId);
  });

  it('rejects browser budget fields and over-count requests before touching the source', async () => {
    const load = vi.fn<HostedDiagnosticsSourcePort['load']>();
    const getDiagnostics = useCase({ load });

    const clientBudget = await getDiagnostics.execute(
      {
        ...request(),
        maxReferences: Number.MAX_SAFE_INTEGER,
      },
      queryContext()
    );
    const overCount = await getDiagnostics.execute(
      request(
        Array.from({ length: HOSTED_DIAGNOSTICS_MAX_REFERENCES + 1 }, (_, index) =>
          reference(index)
        )
      ),
      queryContext()
    );

    expect(clientBudget).toMatchObject({
      kind: 'error',
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
    expect(overCount).toMatchObject({
      kind: 'error',
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('fails closed when a source item exceeds the fixed per-reference byte budget', async () => {
    const source: HostedDiagnosticsSourcePort = {
      async load() {
        return {
          value: {
            kind: 'reference_load',
            outcome: 'succeeded',
            occurredAtMonotonicMs: 1,
            attributes: {},
          },
          byteLength: HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE + 1,
        };
      },
    };

    const result = await useCase(source).execute(request(), queryContext());

    expect(result).toMatchObject({
      kind: 'error',
      error: {
        code: 'invalid_request',
        reason: 'reference_budget_exceeded',
        diagnosticId: DIAGNOSTIC_ID,
      },
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain(
      String(HOSTED_DIAGNOSTICS_MAX_BYTES_PER_REFERENCE)
    );
  });

  it('fails closed before loading when the authenticated query deadline is already expired', async () => {
    const deadline = createDeadlineHarness(10_000);
    const load = vi.fn<HostedDiagnosticsSourcePort['load']>();
    const context = queryContext({ deadlineAtMs: 10_000 });
    const addEventListener = vi.spyOn(context.signal, 'addEventListener');

    const result = await useCase({ load }, { deadlineScheduler: deadline.port }).execute(
      request(),
      context
    );

    expect(result).toMatchObject({
      kind: 'error',
      error: {
        code: 'cancelled',
        reason: 'request_cancelled',
        diagnosticId: DIAGNOSTIC_ID,
      },
      retryable: false,
    });
    expect(load).not.toHaveBeenCalled();
    expect(deadline.schedule).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('aborts an in-flight bounded load when its query deadline elapses and cleans the scope', async () => {
    const deadline = createDeadlineHarness();
    const parentContext = queryContext({ deadlineAtMs: 10_000 });
    const removeEventListener = vi.spyOn(parentContext.signal, 'removeEventListener');
    let sourceSignal: AbortSignal | undefined;
    const source: HostedDiagnosticsSourcePort = {
      load: vi.fn(
        (_referenceId, context) =>
          new Promise<never>((_resolve, reject) => {
            sourceSignal = context.signal;
            context.signal.addEventListener('abort', () => reject(new Error(PRIVATE_VALUE)), {
              once: true,
            });
          })
      ),
    };
    const pending = useCase(source, { deadlineScheduler: deadline.port }).execute(
      request(),
      parentContext
    );
    await vi.waitFor(() => expect(sourceSignal).toBeInstanceOf(AbortSignal));

    deadline.elapse(parentContext.deadlineAtMs);
    const result = await pending;

    expect(result).toMatchObject({
      kind: 'error',
      error: {
        code: 'cancelled',
        reason: 'request_cancelled',
        diagnosticId: DIAGNOSTIC_ID,
      },
      retryable: false,
    });
    expect(sourceSignal?.aborted).toBe(true);
    expect(deadline.schedule).toHaveBeenCalledWith(10_000, expect.any(Function));
    expect(deadline.cancel).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
  });

  it('returns promptly and aborts the scoped source when the query is cancelled', async () => {
    const controller = new AbortController();
    let sourceSignal: AbortSignal | undefined;
    const source: HostedDiagnosticsSourcePort = {
      load: vi.fn(
        (_referenceId, context) =>
          new Promise<never>((_resolve, reject) => {
            sourceSignal = context.signal;
            context.signal.addEventListener('abort', () => reject(new Error(PRIVATE_VALUE)), {
              once: true,
            });
          })
      ),
    };
    const pending = useCase(source).execute(request(), queryContext({ signal: controller.signal }));
    await vi.waitFor(() => expect(sourceSignal).toBeInstanceOf(AbortSignal));

    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      kind: 'error',
      error: { code: 'cancelled', reason: 'request_cancelled' },
      retryable: false,
    });
    expect(sourceSignal?.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
  });
});
