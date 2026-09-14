import type {
  HostedCreateDraftTeamRequest,
  HostedCreateDraftTeamResult,
  HostedDeleteDraftTeamRequest,
  HostedDeleteDraftTeamResult,
  HostedGetSavedTeamRequest,
  HostedGetSavedTeamResult,
  HostedUpdateDraftTeamRequest,
  HostedUpdateDraftTeamResult,
} from '../../contracts/hosted';

export interface HostedTeamConfigurationHttpRequestInit {
  readonly method: 'POST';
  readonly credentials: 'include';
  readonly cache: 'no-store';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HostedTeamConfigurationHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedTeamConfigurationFetchPort = (
  input: string,
  init: HostedTeamConfigurationHttpRequestInit
) => Promise<HostedTeamConfigurationHttpResponse>;

export interface HostedTeamConfigurationTransportDependencies {
  readonly fetch: HostedTeamConfigurationFetchPort;
  /** Reads the current in-memory token. The transport never stores or returns it. */
  readonly getCsrfToken: () => string | null;
}

export interface HostedTeamConfigurationTransportOptions {
  readonly signal?: AbortSignal;
}

export interface HostedTeamConfigurationTransport {
  getSavedRequest(
    request: HostedGetSavedTeamRequest,
    options?: HostedTeamConfigurationTransportOptions
  ): Promise<HostedGetSavedTeamResult>;
  createDraft(
    request: HostedCreateDraftTeamRequest,
    options?: HostedTeamConfigurationTransportOptions
  ): Promise<HostedCreateDraftTeamResult>;
  updateDraft(
    request: HostedUpdateDraftTeamRequest,
    options?: HostedTeamConfigurationTransportOptions
  ): Promise<HostedUpdateDraftTeamResult>;
  deleteDraft(
    request: HostedDeleteDraftTeamRequest,
    options?: HostedTeamConfigurationTransportOptions
  ): Promise<HostedDeleteDraftTeamResult>;
}
