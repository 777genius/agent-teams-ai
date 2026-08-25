import type {
  HostedWorkspaceRegistryListResponse,
  HostedWorkspaceRegistrySelectResponse,
} from '../../contracts';
import type { WorkspaceId } from '@shared/contracts/hosted';

export interface HostedWorkspaceRegistryHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedWorkspaceRegistryFetchPort = (
  input: string,
  init: Readonly<{
    method: 'POST';
    credentials: 'include';
    cache: 'no-store';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal: AbortSignal;
  }>
) => Promise<HostedWorkspaceRegistryHttpResponse>;

export interface HostedWorkspaceRegistryRendererPort {
  list(signal?: AbortSignal): Promise<HostedWorkspaceRegistryListResponse>;
  select(
    workspaceId: WorkspaceId,
    signal?: AbortSignal
  ): Promise<HostedWorkspaceRegistrySelectResponse>;
}

export interface CreateHostedWorkspaceRegistryTransportDependencies {
  readonly fetch: HostedWorkspaceRegistryFetchPort;
  readonly getCsrfToken: () => string | null;
  readonly timeoutMs?: number;
}

export type HostedWorkspaceRegistryTransportErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'request_cancelled'
  | 'response_invalid'
  | 'transport_unavailable';

export class HostedWorkspaceRegistryTransportError extends Error {
  constructor(readonly code: HostedWorkspaceRegistryTransportErrorCode) {
    super(`hosted-workspace-registry-transport-${code}`);
    this.name = 'HostedWorkspaceRegistryTransportError';
  }
}
