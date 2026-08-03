import type {
  CoordinationEventScope,
  CoordinationJsonValue,
  CoordinationSnapshotEnvelope,
  HostedCoordinationEventEnvelope,
  HostedCoordinationResyncReason,
  ReplayCursor,
} from '../../contracts';

export interface HostedCoordinationEventSourceEvent {
  readonly data?: unknown;
  readonly lastEventId?: unknown;
}

export type HostedCoordinationEventSourceListener = (
  event: HostedCoordinationEventSourceEvent
) => void;

/** The deliberately small browser boundary used by the hosted SSE transport. */
export interface HostedCoordinationEventSourceLike {
  addEventListener(type: string, listener: HostedCoordinationEventSourceListener): void;
  removeEventListener(type: string, listener: HostedCoordinationEventSourceListener): void;
  close(): void;
}

/**
 * `lastEventId` is a transport hint for EventSource-like implementations that
 * can set the Last-Event-ID request header. The browser implementation still
 * resumes through the `after` query because native EventSource does not expose
 * request headers when a new instance is created.
 */
export interface HostedCoordinationEventSourceInit {
  readonly withCredentials: true;
  readonly lastEventId: ReplayCursor;
}

export type HostedCoordinationEventSourceConstructor = new (
  url: string,
  init: HostedCoordinationEventSourceInit
) => HostedCoordinationEventSourceLike;

export interface HostedCoordinationEventTimingPort {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface HostedCoordinationEventBackoffPort {
  /** `null` deliberately stops reconnecting. Attempts are one-based. */
  nextDelayMs(attempt: number): number | null;
}

export type HostedCoordinationEventDisposition =
  | {
      readonly kind: 'advance';
      /** The reconciler's authoritative cursor after consuming this event. */
      readonly resumeCursor: ReplayCursor;
    }
  | { readonly kind: 'stop' };

export interface HostedCoordinationEventTransportHandlers<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly onOpen?: () => void;
  readonly onEvent: (
    event: HostedCoordinationEventEnvelope<TPayload>
  ) => HostedCoordinationEventDisposition;
  readonly onResyncRequired: (reason: HostedCoordinationResyncReason) => void;
  readonly onReconnectScheduled?: (input: {
    readonly attempt: number;
    readonly delayMs: number;
  }) => void;
  readonly onError?: (error: Error) => void;
}

export interface HostedCoordinationEventTransportConnectInput<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly resumeCursor: ReplayCursor;
  readonly signal: AbortSignal;
  readonly handlers: HostedCoordinationEventTransportHandlers<TPayload>;
}

export interface HostedCoordinationEventConnection {
  readonly cursor: ReplayCursor;
  close(): void;
}

export interface HostedCoordinationEventTransport {
  connect<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(
    input: HostedCoordinationEventTransportConnectInput<TPayload>
  ): HostedCoordinationEventConnection;
}

export type HostedCoordinationSnapshotResyncCause = 'initial' | HostedCoordinationResyncReason;

export interface HostedCoordinationSnapshotResyncInput {
  readonly scope: CoordinationEventScope;
  readonly cause: HostedCoordinationSnapshotResyncCause;
  readonly signal: AbortSignal;
}

export interface HostedCoordinationSnapshotResyncPort<TSnapshot> {
  loadSnapshot(
    input: HostedCoordinationSnapshotResyncInput
  ): Promise<CoordinationSnapshotEnvelope<TSnapshot>>;
}
