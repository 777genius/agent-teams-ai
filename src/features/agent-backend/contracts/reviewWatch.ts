import type { BackendHandle } from './index';
import type { ReviewOriginScope } from '@agent-teams/task-change-ledger/review-transport';

export const AGENT_BACKEND_REVIEW_WATCH_CHANNEL = 'agentBackend:reviewWatch';
export const AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL = 'agentBackend:reviewUnwatch';
export const AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL = 'agentBackend:reviewFileChange';
export const AGENT_BACKEND_REVIEW_EVENTS_ROUTE = '/api/agent-backend/review/events';
export const AGENT_BACKEND_REVIEW_WATCH_ROUTE = '/api/agent-backend/review/watch';
export const AGENT_BACKEND_REVIEW_UNWATCH_ROUTE = '/api/agent-backend/review/unwatch';

export interface BackendReviewWatchRequest {
  handle: BackendHandle;
  /** Unique to the originating bound review subscription, retained for its cleanup. */
  watchId: string;
  projectPath: string;
  filePaths: string[];
  /** Original bound view identity; Host derives actor/workspace authority from its own evidence. */
  scope?: ReviewOriginScope;
}

export interface BackendReviewUnwatchRequest {
  handle: BackendHandle;
  watchId: string;
}

export interface BackendReviewFileChangeEvent {
  handleId: string;
  watchId: string;
  path: string;
  type: 'create' | 'change' | 'delete';
}

/** Transport loss invalidates the originating view's snapshots; it is not a filesystem change. */
export interface BackendReviewWatchResyncRequiredEvent {
  handleId: string;
  watchId: string;
  type: 'resync-required';
  reason: 'stream-lost' | 'stream-reconnected';
}
export type BackendReviewWatchEvent =
  | BackendReviewFileChangeEvent
  | BackendReviewWatchResyncRequiredEvent;

export interface AgentBackendReviewWatchApi {
  watchReviewFiles(request: BackendReviewWatchRequest): Promise<void>;
  unwatchReviewFiles(request: BackendReviewUnwatchRequest): Promise<void>;
  onReviewFileChange(callback: (event: BackendReviewWatchEvent) => void): () => void;
}
