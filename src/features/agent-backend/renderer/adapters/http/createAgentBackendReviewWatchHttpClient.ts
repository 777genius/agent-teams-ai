import {
  AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
  AGENT_BACKEND_REVIEW_WATCH_ROUTE,
} from '../../../contracts/reviewWatch';

import type {
  AgentBackendReviewWatchApi,
  BackendReviewUnwatchRequest,
  BackendReviewWatchEvent,
  BackendReviewWatchRequest,
} from '../../../contracts/reviewWatch';

/** The app shell owns captured-server POST and event-stream transport; this adapter creates none. */
export interface AgentBackendReviewWatchHttpPort {
  post(
    route: typeof AGENT_BACKEND_REVIEW_WATCH_ROUTE,
    request: BackendReviewWatchRequest
  ): Promise<void>;
  post(
    route: typeof AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
    request: BackendReviewUnwatchRequest
  ): Promise<void>;
  /** Must subscribe only to the same captured server authority as POST, never the unrelated global event feed. */
  subscribe(
    callback: (event: BackendReviewWatchEvent) => void,
    status?: (state: 'ready' | 'stream-lost' | 'stream-reconnected') => void
  ): () => void;
}

export function createAgentBackendReviewWatchHttpClient(
  port: AgentBackendReviewWatchHttpPort
): AgentBackendReviewWatchApi {
  const watches = new Map<string, BackendReviewWatchRequest>();
  const listeners = new Set<{
    callback: (event: BackendReviewWatchEvent) => void;
    lost?: 'stream-lost' | 'stream-reconnected';
  }>();
  const key = (request: BackendReviewUnwatchRequest) =>
    JSON.stringify([request.handle.handleId, request.watchId]);
  function invalidate(
    listener: { callback: (event: BackendReviewWatchEvent) => void },
    request: BackendReviewWatchRequest,
    reason: 'stream-lost' | 'stream-reconnected'
  ) {
    listener.callback({
      handleId: request.handle.handleId,
      watchId: request.watchId,
      type: 'resync-required',
      reason,
    });
  }
  return {
    async watchReviewFiles(request) {
      const captured = structuredClone(request);
      const id = key(captured);
      watches.set(id, captured);
      for (const listener of listeners)
        if (listener.lost) invalidate(listener, captured, listener.lost);
      try {
        await port.post(AGENT_BACKEND_REVIEW_WATCH_ROUTE, captured);
      } catch (error) {
        if (watches.get(id) === captured) watches.delete(id);
        throw error;
      }
    },
    async unwatchReviewFiles(request) {
      watches.delete(key(request));
      await port.post(AGENT_BACKEND_REVIEW_UNWATCH_ROUTE, request);
    },
    onReviewFileChange(callback) {
      const listener: { callback: typeof callback; lost?: 'stream-lost' | 'stream-reconnected' } = {
        callback,
      };
      listeners.add(listener);
      const stop = port.subscribe(callback, (state) => {
        listener.lost = state === 'stream-lost' ? state : undefined;
        if (state !== 'ready')
          for (const request of watches.values()) invalidate(listener, request, state);
      });
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  };
}
