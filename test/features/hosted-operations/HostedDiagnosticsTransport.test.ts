import {
  createHostedDiagnosticsFailure,
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  type HostedDiagnosticsResponse,
  parseDiagnosticId,
  parseOperationalReferenceId,
  parseOperationCorrelationId,
} from '@features/hosted-operations/contracts';
import {
  createHostedDiagnosticsTransport,
  type HostedDiagnosticsJsonClientPort,
} from '@features/hosted-operations/renderer';
import { describe, expect, it, vi } from 'vitest';

const REFERENCE_ID = parseOperationalReferenceId(`reference_${'4'.repeat(32)}`);
const REQUEST_ID = parseOperationCorrelationId(`request_${'5'.repeat(32)}`);
const DIAGNOSTIC_ID = parseDiagnosticId(`diagnostic_${'6'.repeat(32)}`);
const PRIVATE_VALUE = ['provider', 'secret', 'stderr', 'path'].join('-');

const request = Object.freeze({
  schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  referenceIds: Object.freeze([REFERENCE_ID]),
});

const response: HostedDiagnosticsResponse = Object.freeze({
  schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  kind: 'success',
  correlation: Object.freeze({ requestId: REQUEST_ID, diagnosticId: DIAGNOSTIC_ID }),
  items: Object.freeze([]),
  totalBytes: 0,
});

describe('createHostedDiagnosticsTransport', () => {
  it('uses only the injected JSON client and validates the returned DTO', async () => {
    const post = vi.fn<HostedDiagnosticsJsonClientPort['post']>(async () => response);
    const signal = new AbortController().signal;
    const transport = createHostedDiagnosticsTransport({ post });

    const result = await transport.getDiagnostics(request, signal);

    expect(result).toEqual(response);
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      HOSTED_DIAGNOSTICS_QUERY_ROUTE,
      request,
      expect.objectContaining({ signal })
    );
  });

  it('returns a safe local failure when the response contains a raw field', async () => {
    const post = vi.fn<HostedDiagnosticsJsonClientPort['post']>(async () => ({
      ...response,
      environment: { token: PRIVATE_VALUE },
    }));
    const result = await createHostedDiagnosticsTransport({ post }).getDiagnostics(request);

    expect(result).toEqual(createHostedDiagnosticsFailure('response_invalid'));
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    expect(JSON.stringify(result)).not.toContain('environment');
  });

  it('does not invoke the client for invalid or already-cancelled requests', async () => {
    const post = vi.fn<HostedDiagnosticsJsonClientPort['post']>();
    const transport = createHostedDiagnosticsTransport({ post });
    const controller = new AbortController();
    controller.abort();

    const invalid = await transport.getDiagnostics({ ...request, budget: 999 } as never);
    const cancelled = await transport.getDiagnostics(request, controller.signal);

    expect(invalid).toEqual(createHostedDiagnosticsFailure('request_invalid'));
    expect(cancelled).toEqual(createHostedDiagnosticsFailure('request_cancelled'));
    expect(post).not.toHaveBeenCalled();
  });

  it('returns promptly when an injected client ignores cancellation', async () => {
    const post = vi.fn<HostedDiagnosticsJsonClientPort['post']>(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = createHostedDiagnosticsTransport({ post }).getDiagnostics(
      request,
      controller.signal
    );
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pending).resolves.toEqual(createHostedDiagnosticsFailure('request_cancelled'));
  });

  it('does not expose a rejected client error', async () => {
    const post = vi.fn<HostedDiagnosticsJsonClientPort['post']>(async () => {
      throw new Error(PRIVATE_VALUE);
    });

    const result = await createHostedDiagnosticsTransport({ post }).getDiagnostics(request);

    expect(result).toEqual(createHostedDiagnosticsFailure('transport_unavailable'));
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
  });
});
