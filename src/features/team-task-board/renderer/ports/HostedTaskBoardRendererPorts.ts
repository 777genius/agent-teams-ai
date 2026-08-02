import type {
  GetHostedTaskBoardPageResult,
  HostedTaskBoardPageRequest,
} from '../../contracts/hosted';

export interface HostedTaskBoardHttpRequestInit {
  readonly method: 'POST';
  readonly credentials: 'include';
  readonly cache: 'no-store';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HostedTaskBoardHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedTaskBoardFetchPort = (
  input: string,
  init: HostedTaskBoardHttpRequestInit
) => Promise<HostedTaskBoardHttpResponse>;

export interface HostedTaskBoardTransportDependencies {
  readonly fetch: HostedTaskBoardFetchPort;
  /** Returns only the current in-memory token. The transport never persists or returns it. */
  readonly getCsrfToken: () => string | null;
}

export interface HostedTaskBoardTransportOptions {
  readonly signal?: AbortSignal;
}

export interface HostedTaskBoardTransport {
  getPage(
    request: HostedTaskBoardPageRequest,
    options?: HostedTaskBoardTransportOptions
  ): Promise<GetHostedTaskBoardPageResult>;
}
