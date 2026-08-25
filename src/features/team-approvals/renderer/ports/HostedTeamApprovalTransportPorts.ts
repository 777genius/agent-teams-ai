import type {
  DecideHostedTeamApprovalResult,
  GetHostedTeamApprovalPageResult,
  GetHostedTeamApprovalPreviewResult,
  HostedTeamApprovalDecisionCommand,
  HostedTeamApprovalPageRequest,
  HostedTeamApprovalPreviewRequest,
} from '../../contracts';

export interface HostedTeamApprovalHttpRequestInit {
  readonly method: 'POST';
  readonly credentials: 'include';
  readonly cache: 'no-store';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HostedTeamApprovalHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedTeamApprovalFetchPort = (
  input: string,
  init: HostedTeamApprovalHttpRequestInit
) => Promise<HostedTeamApprovalHttpResponse>;

export interface HostedTeamApprovalTransportDependencies {
  readonly fetch: HostedTeamApprovalFetchPort;
  /** Returns only the current in-memory token. The transport never persists or returns it. */
  readonly getCsrfToken: () => string | null;
}

export interface HostedTeamApprovalTransportOptions {
  readonly signal?: AbortSignal;
}

export interface HostedTeamApprovalTransport {
  getPage(
    request: HostedTeamApprovalPageRequest,
    options?: HostedTeamApprovalTransportOptions
  ): Promise<GetHostedTeamApprovalPageResult>;
  getPreview(
    request: HostedTeamApprovalPreviewRequest,
    options?: HostedTeamApprovalTransportOptions
  ): Promise<GetHostedTeamApprovalPreviewResult>;
  decide(
    command: HostedTeamApprovalDecisionCommand,
    options?: HostedTeamApprovalTransportOptions
  ): Promise<DecideHostedTeamApprovalResult>;
}
