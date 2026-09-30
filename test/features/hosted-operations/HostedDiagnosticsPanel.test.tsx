import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  type HostedDiagnosticsResponse,
  parseDiagnosticId,
  parseOperationalReferenceId,
  parseOperationCorrelationId,
} from '@features/hosted-operations/contracts';
import {
  HostedDiagnosticsPanel,
  type HostedDiagnosticsTransportPort,
} from '@features/hosted-operations/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firstReference = parseOperationalReferenceId(`reference_${'1'.repeat(32)}`);
const secondReference = parseOperationalReferenceId(`reference_${'2'.repeat(32)}`);

function response(referenceId: typeof firstReference): HostedDiagnosticsResponse {
  return Object.freeze({
    schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
    kind: 'success',
    correlation: Object.freeze({
      requestId: parseOperationCorrelationId(`request_${'3'.repeat(32)}`),
      diagnosticId: parseDiagnosticId(`diagnostic_${'4'.repeat(32)}`),
    }),
    items: Object.freeze([
      Object.freeze({
        referenceId,
        kind: 'reference_load',
        outcome: 'succeeded',
        occurredAtMonotonicMs: 1,
        attributes: Object.freeze({}),
        byteLength: 1,
      }),
    ]),
    totalBytes: 1,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('HostedDiagnosticsPanel', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('synchronously hides a prior binding and ignores its late response after rebind', async () => {
    const first = deferred<HostedDiagnosticsResponse>();
    const second = deferred<HostedDiagnosticsResponse>();
    const getDiagnostics = vi
      .fn<HostedDiagnosticsTransportPort['getDiagnostics']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HostedDiagnosticsPanel
          bindingKey="principal-a/workspace-a"
          referenceIds={[firstReference]}
          transport={{ getDiagnostics }}
        />
      );
    });
    await act(async () => {
      first.resolve(response(firstReference));
      await first.promise;
    });
    expect(host.textContent).toContain(firstReference);

    act(() => {
      root.render(
        <HostedDiagnosticsPanel
          bindingKey="principal-b/workspace-b"
          referenceIds={[secondReference]}
          transport={{ getDiagnostics }}
        />
      );
    });
    expect(host.textContent).not.toContain(firstReference);
    expect(host.textContent).toContain('Loading diagnostics');

    await act(async () => {
      second.resolve(response(secondReference));
      await second.promise;
    });
    expect(host.textContent).toContain(secondReference);
    expect(host.textContent).not.toContain(firstReference);
    act(() => root.unmount());
  });
});
