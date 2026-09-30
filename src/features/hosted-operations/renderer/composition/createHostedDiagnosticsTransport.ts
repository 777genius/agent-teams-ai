import {
  createHostedDiagnosticsFailure,
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  type HostedDiagnosticsRequest,
  parseHostedDiagnosticsRequest,
  parseHostedDiagnosticsResponse,
} from '../../contracts';

import type {
  HostedDiagnosticsJsonClientPort,
  HostedDiagnosticsTransportPort,
} from '../ports/HostedDiagnosticsTransportPorts';

const CANCELLED = Symbol('hosted-diagnostics-transport-cancelled');

async function raceCancellation(
  operation: Promise<unknown>,
  signal: AbortSignal
): Promise<unknown | typeof CANCELLED> {
  let cancel: (() => void) | undefined;
  const cancellation = new Promise<typeof CANCELLED>((resolve) => {
    cancel = () => resolve(CANCELLED);
    signal.addEventListener('abort', cancel, { once: true });
  });
  if (signal.aborted) cancel?.();
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}

/** Creates a browser transport without reading a global fetch, token, cookie, or header source. */
export function createHostedDiagnosticsTransport(
  client: HostedDiagnosticsJsonClientPort
): HostedDiagnosticsTransportPort {
  return Object.freeze({
    async getDiagnostics(request: HostedDiagnosticsRequest, suppliedSignal?: AbortSignal) {
      const parsedRequest = parseHostedDiagnosticsRequest(request);
      if (!parsedRequest.ok) return createHostedDiagnosticsFailure('request_invalid');
      if (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal)) {
        return createHostedDiagnosticsFailure('request_invalid');
      }

      const signal = suppliedSignal ?? new AbortController().signal;
      if (signal.aborted) return createHostedDiagnosticsFailure('request_cancelled');

      try {
        const response = await raceCancellation(
          client.post(
            HOSTED_DIAGNOSTICS_QUERY_ROUTE,
            parsedRequest.value,
            Object.freeze({ signal })
          ),
          signal
        );
        if (response === CANCELLED || signal.aborted) {
          return createHostedDiagnosticsFailure('request_cancelled');
        }
        const parsedResponse = parseHostedDiagnosticsResponse(response);
        return parsedResponse.ok
          ? parsedResponse.value
          : createHostedDiagnosticsFailure('response_invalid');
      } catch {
        return createHostedDiagnosticsFailure(
          signal.aborted ? 'request_cancelled' : 'transport_unavailable'
        );
      }
    },
  });
}
