import {
  AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
  AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL,
  AGENT_BACKEND_REVIEW_WATCH_CHANNEL,
} from '../contracts/reviewWatch';

import type {
  AgentBackendReviewWatchApi,
  BackendReviewUnwatchRequest,
  BackendReviewWatchEvent,
  BackendReviewWatchRequest,
} from '../contracts/reviewWatch';

export interface AgentBackendReviewWatchIpcPort {
  invoke(
    channel: typeof AGENT_BACKEND_REVIEW_WATCH_CHANNEL,
    request: BackendReviewWatchRequest
  ): Promise<void>;
  invoke(
    channel: typeof AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL,
    request: BackendReviewUnwatchRequest
  ): Promise<void>;
  on(
    channel: typeof AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
    listener: (event: unknown, value: BackendReviewWatchEvent) => void
  ): unknown;
  removeListener(
    channel: typeof AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
    listener: (event: unknown, value: BackendReviewWatchEvent) => void
  ): unknown;
}

export function createAgentBackendReviewWatchBridge(
  ipc: AgentBackendReviewWatchIpcPort
): AgentBackendReviewWatchApi {
  return {
    watchReviewFiles: (request) => ipc.invoke(AGENT_BACKEND_REVIEW_WATCH_CHANNEL, request),
    unwatchReviewFiles: (request) => ipc.invoke(AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL, request),
    onReviewFileChange(callback) {
      const listener = (_event: unknown, value: BackendReviewWatchEvent) => callback(value);
      ipc.on(AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL, listener);
      return () => {
        ipc.removeListener(AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL, listener);
      };
    },
  };
}
