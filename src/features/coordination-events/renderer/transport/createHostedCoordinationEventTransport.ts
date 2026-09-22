import {
  COORDINATION_EVENT_SCOPE_KINDS,
  type CoordinationEventScope,
  type CoordinationJsonValue,
  type CoordinationResourceRevision,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_EVENT_STREAM_ROUTE,
  HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
  HOSTED_COORDINATION_RESYNC_REASONS,
  HOSTED_COORDINATION_RESYNC_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type HostedCoordinationResyncReason,
  type ReplayCursor,
} from '../../contracts';

import type {
  HostedCoordinationEventBackoffPort,
  HostedCoordinationEventConnection,
  HostedCoordinationEventDisposition,
  HostedCoordinationEventSourceConstructor,
  HostedCoordinationEventSourceEvent,
  HostedCoordinationEventSourceLike,
  HostedCoordinationEventSourceListener,
  HostedCoordinationEventTimingPort,
  HostedCoordinationEventTransport,
  HostedCoordinationEventTransportConnectInput,
} from '../ports/HostedCoordinationEventRendererPorts';

const DEFAULT_MAXIMUM_RECONNECT_DELAY_MS = 30_000;
const ABSOLUTE_MAXIMUM_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_MAXIMUM_MESSAGE_BYTES = 256 * 1_024;
const MAXIMUM_MESSAGE_BYTES = 1024 * 1_024;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_EVENT_TYPE_LENGTH = 256;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;
const UTF8_ENCODER = new TextEncoder();

export interface CreateHostedCoordinationEventTransportOptions {
  readonly eventSourceConstructor: HostedCoordinationEventSourceConstructor;
  readonly timing: HostedCoordinationEventTimingPort;
  readonly backoff: HostedCoordinationEventBackoffPort;
  /** Optional origin for shells whose EventSource requires an absolute URL. */
  readonly baseUrl?: string;
  readonly maximumReconnectDelayMs?: number;
  readonly maximumMessageBytes?: number;
}

interface ActiveEventSource {
  readonly source: HostedCoordinationEventSourceLike;
  readonly token: number;
  readonly onOpen: HostedCoordinationEventSourceListener;
  readonly onError: HostedCoordinationEventSourceListener;
  readonly onEvent: HostedCoordinationEventSourceListener;
  readonly onResync: HostedCoordinationEventSourceListener;
}

function positiveBounded(value: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`invalid_hosted_coordination_event_transport_option:${field}`);
  }
  return value;
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function validCursor(value: unknown): value is ReplayCursor {
  return validBoundedString(value, MAX_CURSOR_LENGTH);
}

function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readScope(value: unknown): CoordinationEventScope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== 'string' ||
    !COORDINATION_EVENT_SCOPE_KINDS.includes(
      record.kind as (typeof COORDINATION_EVENT_SCOPE_KINDS)[number]
    ) ||
    !validBoundedString(record.scopeId, MAX_IDENTIFIER_LENGTH)
  ) {
    return null;
  }
  return Object.freeze({
    kind: record.kind as CoordinationEventScope['kind'],
    scopeId: record.scopeId,
  });
}

function readResourceRevision(value: unknown): CoordinationResourceRevision | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !validBoundedString(record.resourceKey, MAX_IDENTIFIER_LENGTH) ||
    !validSequence(record.generation) ||
    !validSequence(record.revision)
  ) {
    return null;
  }
  return Object.freeze({
    resourceKey: record.resourceKey,
    generation: record.generation,
    revision: record.revision,
  });
}

function materializeJson(value: unknown): CoordinationJsonValue {
  let nodes = 0;
  const visit = (current: unknown, depth: number): CoordinationJsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('json_budget_exceeded');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('json_number_invalid');
      return current;
    }
    if (Array.isArray(current)) {
      return Object.freeze(current.map((item) => visit(item, depth + 1)));
    }
    if (typeof current !== 'object') throw new Error('json_value_invalid');
    const output: Record<string, CoordinationJsonValue> = {};
    for (const [key, item] of Object.entries(current)) {
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: visit(item, depth + 1),
      });
    }
    return Object.freeze(output);
  };
  return visit(value, 0);
}

function parseEventEnvelope(
  value: unknown,
  lastEventId: unknown
): HostedCoordinationEventEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scope = readScope(record.scope);
  const resourceRevision = readResourceRevision(record.resourceRevision);
  if (
    record.schemaVersion !== HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION ||
    record.kind !== HOSTED_COORDINATION_EVENT_SSE_EVENT ||
    !validBoundedString(record.deploymentId, MAX_IDENTIFIER_LENGTH) ||
    !validBoundedString(record.eventEpoch, MAX_IDENTIFIER_LENGTH) ||
    !validSequence(record.eventSequence) ||
    !validBoundedString(record.eventId, MAX_IDENTIFIER_LENGTH) ||
    !validCursor(record.previousEventCursor) ||
    !validCursor(record.eventCursor) ||
    scope === null ||
    !validBoundedString(record.eventType, MAX_EVENT_TYPE_LENGTH) ||
    resourceRevision === null ||
    !validBoundedString(record.emittedAt, 128) ||
    !Number.isFinite(Date.parse(record.emittedAt)) ||
    (lastEventId !== undefined && lastEventId !== '' && lastEventId !== record.eventCursor)
  ) {
    return null;
  }

  let payload: CoordinationJsonValue;
  try {
    payload = materializeJson(record.payload);
  } catch {
    return null;
  }
  return Object.freeze({
    schemaVersion: HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: record.deploymentId,
    eventEpoch: record.eventEpoch,
    eventSequence: record.eventSequence,
    eventId: record.eventId,
    previousEventCursor: record.previousEventCursor,
    eventCursor: record.eventCursor,
    scope,
    eventType: record.eventType,
    ...(resourceRevision === undefined ? {} : { resourceRevision }),
    emittedAt: record.emittedAt,
    payload,
  });
}

function parseResyncReason(value: unknown): HostedCoordinationResyncReason | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION ||
    record.kind !== HOSTED_COORDINATION_RESYNC_SSE_EVENT ||
    typeof record.reason !== 'string' ||
    !HOSTED_COORDINATION_RESYNC_REASONS.includes(record.reason as HostedCoordinationResyncReason)
  ) {
    return null;
  }
  return record.reason as HostedCoordinationResyncReason;
}

function parseData(event: HostedCoordinationEventSourceEvent, maximumBytes: number): unknown {
  if (typeof event.data !== 'string' || UTF8_ENCODER.encode(event.data).byteLength > maximumBytes) {
    throw new Error('hosted_coordination_event_message_invalid');
  }
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    throw new Error('hosted_coordination_event_message_invalid');
  }
}

function streamUrl(baseUrl: string | undefined, cursor: ReplayCursor): string {
  const relative = `${HOSTED_COORDINATION_EVENT_STREAM_ROUTE}?after=${encodeURIComponent(cursor)}`;
  if (baseUrl === undefined) return relative;
  try {
    return new URL(relative, baseUrl).toString();
  } catch {
    throw new Error('invalid_hosted_coordination_event_transport_option:baseUrl');
  }
}

function transportError(message: string): Error {
  return new Error(message);
}

export function createHostedCoordinationEventTransport(
  options: CreateHostedCoordinationEventTransportOptions
): HostedCoordinationEventTransport {
  if (!options?.eventSourceConstructor || !options.timing || !options.backoff) {
    throw new Error('invalid_hosted_coordination_event_transport_options');
  }
  const maximumReconnectDelayMs = positiveBounded(
    options.maximumReconnectDelayMs ?? DEFAULT_MAXIMUM_RECONNECT_DELAY_MS,
    ABSOLUTE_MAXIMUM_RECONNECT_DELAY_MS,
    'maximumReconnectDelayMs'
  );
  const maximumMessageBytes = positiveBounded(
    options.maximumMessageBytes ?? DEFAULT_MAXIMUM_MESSAGE_BYTES,
    MAXIMUM_MESSAGE_BYTES,
    'maximumMessageBytes'
  );

  return Object.freeze({
    connect<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(
      input: HostedCoordinationEventTransportConnectInput<TPayload>
    ): HostedCoordinationEventConnection {
      if (!validCursor(input?.resumeCursor) || !input.signal || !input.handlers?.onEvent) {
        throw new Error('invalid_hosted_coordination_event_connection_input');
      }

      let cursor = input.resumeCursor;
      let active: ActiveEventSource | null = null;
      let cancelReconnect = (): void => undefined;
      let sourceToken = 0;
      let reconnectAttempt = 0;
      let closed = false;

      const reportError = (error: Error): void => {
        try {
          input.handlers.onError?.(error);
        } catch {
          // Error reporting cannot revive or disrupt the stream state machine.
        }
      };

      const detachActive = (): void => {
        const current = active;
        active = null;
        if (!current) return;
        try {
          current.source.removeEventListener('open', current.onOpen);
          current.source.removeEventListener('error', current.onError);
          current.source.removeEventListener(HOSTED_COORDINATION_EVENT_SSE_EVENT, current.onEvent);
          current.source.removeEventListener(
            HOSTED_COORDINATION_RESYNC_SSE_EVENT,
            current.onResync
          );
        } catch {
          // The source is still closed below even if listener cleanup fails.
        }
        try {
          current.source.close();
        } catch {
          // A failed external close cannot be allowed to revive this token.
        }
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        cancelReconnect();
        cancelReconnect = (): void => undefined;
        detachActive();
        input.signal.removeEventListener('abort', close);
      };

      const requireResync = (reason: HostedCoordinationResyncReason, error?: Error): void => {
        if (closed) return;
        if (error) reportError(error);
        close();
        try {
          input.handlers.onResyncRequired(reason);
        } catch {
          // The connection is already closed and cannot mutate future state.
        }
      };

      let openSource = (): void => undefined;
      const scheduleReconnect = (error: Error): void => {
        if (closed || input.signal.aborted) return;
        reportError(error);
        reconnectAttempt += 1;
        let proposedDelay: number | null;
        try {
          proposedDelay = options.backoff.nextDelayMs(reconnectAttempt);
        } catch {
          proposedDelay = null;
        }
        if (proposedDelay === null) {
          close();
          return;
        }
        if (typeof proposedDelay !== 'number' || !Number.isFinite(proposedDelay)) {
          reportError(transportError('hosted_coordination_event_backoff_invalid'));
          close();
          return;
        }
        const delayMs = Math.min(maximumReconnectDelayMs, Math.max(0, Math.trunc(proposedDelay)));
        try {
          input.handlers.onReconnectScheduled?.({ attempt: reconnectAttempt, delayMs });
        } catch {
          // Status observation is not part of transport correctness.
        }
        try {
          const cancel = options.timing.schedule(delayMs, () => {
            cancelReconnect = (): void => undefined;
            openSource();
          });
          cancelReconnect = () => {
            try {
              cancel();
            } catch {
              // Cancellation is best-effort after the connection is fenced.
            }
          };
        } catch {
          reportError(transportError('hosted_coordination_event_timing_failed'));
          close();
        }
      };

      openSource = (): void => {
        if (closed || input.signal.aborted) return;
        cancelReconnect();
        cancelReconnect = (): void => undefined;
        detachActive();
        const token = ++sourceToken;
        let source: HostedCoordinationEventSourceLike;
        try {
          source = new options.eventSourceConstructor(streamUrl(options.baseUrl, cursor), {
            withCredentials: true,
            lastEventId: cursor,
          });
        } catch {
          scheduleReconnect(transportError('hosted_coordination_event_source_open_failed'));
          return;
        }

        const isCurrent = (): boolean => !closed && active?.token === token;
        const onOpen: HostedCoordinationEventSourceListener = () => {
          if (!isCurrent()) return;
          reconnectAttempt = 0;
          try {
            input.handlers.onOpen?.();
          } catch {
            // Status observation is not part of transport correctness.
          }
        };
        const onError: HostedCoordinationEventSourceListener = () => {
          if (!isCurrent()) return;
          detachActive();
          scheduleReconnect(transportError('hosted_coordination_event_stream_disconnected'));
        };
        const onEvent: HostedCoordinationEventSourceListener = (message) => {
          if (!isCurrent()) return;
          let parsed: HostedCoordinationEventEnvelope | null = null;
          try {
            parsed = parseEventEnvelope(
              parseData(message, maximumMessageBytes),
              message.lastEventId
            );
          } catch {
            // Converted to a terminal projection resync below.
          }
          if (parsed === null) {
            requireResync(
              'projection_invalid',
              transportError('hosted_coordination_event_message_invalid')
            );
            return;
          }
          let disposition: HostedCoordinationEventDisposition;
          try {
            disposition = input.handlers.onEvent(
              parsed as HostedCoordinationEventEnvelope<TPayload>
            );
          } catch {
            requireResync(
              'projection_invalid',
              transportError('hosted_coordination_event_consumer_failed')
            );
            return;
          }
          if (disposition.kind === 'advance' && isCurrent()) {
            if (!validCursor(disposition.resumeCursor)) {
              requireResync(
                'projection_invalid',
                transportError('hosted_coordination_event_consumer_cursor_invalid')
              );
              return;
            }
            cursor = disposition.resumeCursor;
          } else if (disposition.kind !== 'advance') {
            close();
          }
        };
        const onResync: HostedCoordinationEventSourceListener = (message) => {
          if (!isCurrent()) return;
          let reason: HostedCoordinationResyncReason | null = null;
          try {
            reason = parseResyncReason(parseData(message, maximumMessageBytes));
          } catch {
            // Converted to a projection resync below.
          }
          requireResync(
            reason ?? 'projection_invalid',
            reason === null
              ? transportError('hosted_coordination_event_resync_message_invalid')
              : undefined
          );
        };

        active = { source, token, onOpen, onError, onEvent, onResync };
        try {
          source.addEventListener('open', onOpen);
          source.addEventListener('error', onError);
          source.addEventListener(HOSTED_COORDINATION_EVENT_SSE_EVENT, onEvent);
          source.addEventListener(HOSTED_COORDINATION_RESYNC_SSE_EVENT, onResync);
        } catch {
          detachActive();
          scheduleReconnect(transportError('hosted_coordination_event_source_open_failed'));
          return;
        }
        if (closed || input.signal.aborted) close();
      };

      input.signal.addEventListener('abort', close, { once: true });
      if (input.signal.aborted) close();
      else openSource();

      return Object.freeze({
        get cursor(): ReplayCursor {
          return cursor;
        },
        close,
      });
    },
  });
}
