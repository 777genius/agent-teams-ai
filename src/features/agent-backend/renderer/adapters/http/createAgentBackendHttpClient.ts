import { AGENT_BACKEND_OPERATIONS_ROUTE } from '../../../contracts';

import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts';

/** Existing app HTTP transport supplies its origin, credentials and timeout policy. */
export type AgentBackendHttpPost = (
  route: typeof AGENT_BACKEND_OPERATIONS_ROUTE,
  request: BackendOperationRequest
) => Promise<BackendOperationResult>;

export function createAgentBackendHttpClient(post: AgentBackendHttpPost): AgentBackendApi {
  return {
    // An HTTP timeout is response uncertainty; this adapter never retries the intent.
    invoke: (request) => post(AGENT_BACKEND_OPERATIONS_ROUTE, request),
  };
}
