import type {
  GetHostedMemberLogPageResult,
  HostedMemberLogPageRequest,
} from '../../../contracts/hosted';

export interface HostedMemberLogHttpRequestInit {
  readonly method: 'POST';
  readonly credentials: 'include';
  readonly cache: 'no-store';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HostedMemberLogHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** The URL is always feature-owned and relative, so this can only use the current origin. */
export type HostedMemberLogFetchPort = (
  input: string,
  init: HostedMemberLogHttpRequestInit
) => Promise<HostedMemberLogHttpResponse>;

export interface HostedMemberLogTransportDependencies {
  readonly fetch: HostedMemberLogFetchPort;
  /** Reads only an in-memory CSRF token; it is never persisted or returned by this transport. */
  readonly getCsrfToken: () => string | null;
}

export interface HostedMemberLogTransportOptions {
  readonly signal?: AbortSignal;
}

export interface HostedMemberLogTransport {
  getPage(
    request: HostedMemberLogPageRequest,
    options?: HostedMemberLogTransportOptions
  ): Promise<GetHostedMemberLogPageResult>;
}
