import type {
  GetHostedMessagePageResult,
  HostedMessagePageRequest,
  SendHostedTeamMessageCommand,
  SendHostedTeamMessageResult,
} from '../../contracts/hosted';

export interface HostedTeamMessageHttpRequestInit {
  readonly method: 'POST';
  readonly credentials: 'include';
  readonly cache: 'no-store';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HostedTeamMessageHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedTeamMessageFetchPort = (
  input: string,
  init: HostedTeamMessageHttpRequestInit
) => Promise<HostedTeamMessageHttpResponse>;

export interface HostedTeamMessageTransportDependencies {
  readonly fetch: HostedTeamMessageFetchPort;
  /** Reads only the current in-memory token; the transport neither persists nor returns it. */
  readonly getCsrfToken: () => string | null;
}

export interface HostedTeamMessageTransportOptions {
  readonly signal?: AbortSignal;
}

export interface HostedTeamMessageTransport {
  getPage(
    request: HostedMessagePageRequest,
    options?: HostedTeamMessageTransportOptions
  ): Promise<GetHostedMessagePageResult>;
  sendMessage(
    command: SendHostedTeamMessageCommand,
    options?: HostedTeamMessageTransportOptions
  ): Promise<SendHostedTeamMessageResult>;
}
