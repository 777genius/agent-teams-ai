import type { HostedReadinessProjection } from '../../contracts';
import type { BootId, DeploymentId } from '@shared/contracts/hosted';

export interface HostedReadinessHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedReadinessFetchPort = (
  input: string,
  init: Readonly<{
    method: 'GET';
    credentials: 'include';
    cache: 'no-store';
    headers: Readonly<{ Accept: 'application/json' }>;
    signal: AbortSignal;
  }>
) => Promise<HostedReadinessHttpResponse>;

export interface HostedReadinessRendererTransport {
  load(signal?: AbortSignal): Promise<HostedReadinessProjection>;
}

export interface CreateHostedReadinessTransportDependencies {
  readonly fetch: HostedReadinessFetchPort;
  readonly expectedDeploymentId: DeploymentId;
  readonly expectedBootId: BootId;
  readonly timeoutMs?: number;
}

export type HostedReadinessTransportErrorCode =
  | 'request_cancelled'
  | 'deadline_exceeded'
  | 'transport_unavailable'
  | 'response_invalid'
  | 'stale_deployment'
  | 'stale_boot'
  | 'stale_revision'
  | 'revision_conflict';

export class HostedReadinessTransportError extends Error {
  constructor(readonly code: HostedReadinessTransportErrorCode) {
    super(`hosted-readiness-transport-${code}`);
    this.name = 'HostedReadinessTransportError';
  }
}
