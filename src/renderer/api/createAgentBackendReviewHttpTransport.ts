import {
  AGENT_BACKEND_REVIEW_EVENTS_ROUTE,
  AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
} from '@features/agent-backend/contracts';

import type { AgentBackendReviewWatchHttpPort } from '@features/agent-backend/renderer';

/** Subscribe to the same current server origin used by captured review POST requests. */
export function createAgentBackendReviewHttpTransport(
  getBaseUrl: () => string,
  post: AgentBackendReviewWatchHttpPort['post']
): AgentBackendReviewWatchHttpPort {
  return {
    post,
    subscribe: (callback, status) => {
      const stream = new EventSource(`${getBaseUrl()}${AGENT_BACKEND_REVIEW_EVENTS_ROUTE}`);
      let opened = false;
      stream.onopen = () => {
        status?.(opened ? 'stream-reconnected' : 'ready');
        opened = true;
      };
      stream.onerror = () => status?.('stream-lost');
      stream.addEventListener(AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL, (event) =>
        callback(JSON.parse((event as MessageEvent<string>).data))
      );
      return () => stream.close();
    },
  };
}
