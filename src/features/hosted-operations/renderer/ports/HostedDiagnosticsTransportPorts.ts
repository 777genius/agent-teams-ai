import type {
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  HostedDiagnosticsRequest,
  HostedDiagnosticsResponse,
} from '../../contracts';

export interface HostedDiagnosticsJsonClientPort {
  post(
    path: typeof HOSTED_DIAGNOSTICS_QUERY_ROUTE,
    request: HostedDiagnosticsRequest,
    context: { readonly signal: AbortSignal }
  ): Promise<unknown>;
}

export interface HostedDiagnosticsTransportPort {
  getDiagnostics(
    request: HostedDiagnosticsRequest,
    signal?: AbortSignal
  ): Promise<HostedDiagnosticsResponse>;
}
