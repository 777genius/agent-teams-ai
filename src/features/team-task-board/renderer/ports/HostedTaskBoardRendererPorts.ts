import type {
  ExecuteHostedTaskMutationResult,
  GetHostedTaskBoardPageResult,
  HostedTaskBoardCoreV1MutationCommand,
  HostedTaskBoardPageRequest,
  HostedTaskBoardSourceGeneration,
} from '../../contracts/hosted';
import type { Revision, TeamId } from '@shared/contracts/hosted';

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
  /** Supplied only by a composition that has advertised the matching mutation route. */
  readonly mutationsEnabled?: boolean;
}

export interface HostedTaskBoardTransportOptions {
  readonly signal?: AbortSignal;
}

/**
 * A trusted transport can publish this after an SSE or another external writer observes a newer
 * task-board snapshot. The page treats each delivery as a monotonic local watermark, rather than
 * assuming opaque revisions can be ordered lexically.
 */
export interface HostedTaskBoardRevisionEvent {
  readonly teamId: TeamId;
  readonly sourceGeneration: HostedTaskBoardSourceGeneration;
  readonly revision: Revision;
}

export type HostedTaskBoardRevisionEventListener = (event: HostedTaskBoardRevisionEvent) => void;

export interface HostedTaskBoardTransport {
  getPage(
    request: HostedTaskBoardPageRequest,
    options?: HostedTaskBoardTransportOptions
  ): Promise<GetHostedTaskBoardPageResult>;
  /** Omitted by read-only hosted compositions; the page keeps that capability unadvertised. */
  executeMutation?(
    command: HostedTaskBoardCoreV1MutationCommand,
    options?: HostedTaskBoardTransportOptions
  ): Promise<ExecuteHostedTaskMutationResult>;
  /** Optional because the HTTP-only composition has no SSE/event source yet. */
  subscribeToRevisionEvents?(
    teamId: TeamId,
    listener: HostedTaskBoardRevisionEventListener
  ): () => void;
}
