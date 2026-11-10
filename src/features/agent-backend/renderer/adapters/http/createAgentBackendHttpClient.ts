import {
  AGENT_BACKEND_CONNECTIONS_ROUTE,
  AGENT_BACKEND_OPERATIONS_ROUTE,
  STOPPED_TEAM_IMPORT_ROUTE,
} from '../../../contracts';

import {
  type AgentBackendReviewWatchHttpPort,
  createAgentBackendReviewWatchHttpClient,
} from './createAgentBackendReviewWatchHttpClient';

import type {
  AgentBackendApi,
  BackendConnectionSnapshot,
  BackendOperationRequest,
  BackendOperationResult,
  StoppedTeamImportAction,
  StoppedTeamImportResult,
} from '../../../contracts';

/** Existing app HTTP transport supplies its origin, credentials and timeout policy. */
export type AgentBackendHttpPost = (
  route: typeof AGENT_BACKEND_OPERATIONS_ROUTE,
  request: BackendOperationRequest
) => Promise<BackendOperationResult>;

export type AgentBackendHttpGet = (
  route: typeof AGENT_BACKEND_CONNECTIONS_ROUTE
) => Promise<BackendConnectionSnapshot>;

export function createAgentBackendHttpClient(
  post: AgentBackendHttpPost,
  get: AgentBackendHttpGet,
  watch?: AgentBackendReviewWatchHttpPort,
  stoppedImport?: (
    route: typeof STOPPED_TEAM_IMPORT_ROUTE,
    request: StoppedTeamImportAction
  ) => Promise<StoppedTeamImportResult>
): AgentBackendApi {
  return {
    ...(watch ? createAgentBackendReviewWatchHttpClient(watch) : {}),
    // An HTTP timeout is response uncertainty; this adapter never retries the intent.
    invoke: (request) => post(AGENT_BACKEND_OPERATIONS_ROUTE, request),
    getConnections: () => get(AGENT_BACKEND_CONNECTIONS_ROUTE),
    ...(stoppedImport
      ? {
          stoppedImport: (request: StoppedTeamImportAction) =>
            stoppedImport(STOPPED_TEAM_IMPORT_ROUTE, request),
        }
      : {}),
  };
}
