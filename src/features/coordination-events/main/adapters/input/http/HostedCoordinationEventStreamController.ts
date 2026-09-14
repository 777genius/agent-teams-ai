import {
  currentProductHostedProducerSseWriteEmitter,
  type ProductSseFrameIdentity,
} from '@features/hosted-producer-provenance/main/hosted';

import {
  type CoordinationEventEnvelope,
  type CoordinationReplayBatch,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_EVENT_STREAM_ROUTE,
  HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
  HOSTED_COORDINATION_RESYNC_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type HostedCoordinationEventProjection,
  type HostedCoordinationResyncReason,
  type HostedCoordinationResyncRequired,
  type ReplayCursor,
} from '../../../../contracts';

import {
  hostedCoordinationEventStreamAuthorizationIsCurrent as authorizationIsCurrent,
  type HostedCoordinationEventStreamCurrentAuthorization,
} from './hostedCoordinationEventStreamAuthorization';
import {
  HostedCoordinationEventStreamWriter,
  hostedCoordinationEventStreamWriteSucceeded,
} from './hostedCoordinationEventStreamWriter';
import {
  type HostedCoordinationEventStreamScheduler,
  WakeSignal,
} from './HostedCoordinationEventWakeSignal';

import type { ReplayCoordinationEventsInput } from '../../../../core/application';
import type {
  HostedCoordinationEventStreamIdentityFactory,
  HostedCoordinationEventStreamWriteObserver,
} from '../../../application/HostedCoordinationEventStreamPorts';
import type { CoordinationEventWakeupListener } from '../../../infrastructure/InProcessCoordinationEventWakeupHub';

export type { HostedCoordinationEventStreamScheduler } from './HostedCoordinationEventWakeSignal';

interface HostedCoordinationHttpSocket {
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}
interface HostedCoordinationHttpRawRequest {
  readonly aborted: boolean;
  readonly destroyed: boolean;
  readonly socket: HostedCoordinationHttpSocket;
  once(event: 'aborted', listener: () => void): unknown;
  removeListener(event: 'aborted', listener: () => void): unknown;
}
interface HostedCoordinationHttpRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly query: unknown;
  readonly raw: HostedCoordinationHttpRawRequest;
}
interface HostedCoordinationHttpRawReply {
  readonly destroyed: boolean;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  destroy(): unknown;
  end(): unknown;
  flushHeaders(): unknown;
  once(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  write(frame: string): boolean;
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown;
}
interface HostedCoordinationHttpReply {
  readonly sent: boolean;
  readonly raw: HostedCoordinationHttpRawReply;
  code(statusCode: number): HostedCoordinationHttpReply;
  hijack(): void;
  send(payload: unknown): unknown;
}
interface HostedCoordinationHttpApplication {
  get(
    route: string,
    handler: (
      request: HostedCoordinationHttpRequest,
      reply: HostedCoordinationHttpReply
    ) => Promise<void>
  ): void;
}
const DEFAULT_REPLAY_BATCH_SIZE = 100;
const MAX_REPLAY_BATCH_SIZE = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SLOW_CONSUMER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1_024;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_IDENTIFIER_LENGTH = 256;
const REJECTED_ORIGIN_DIAGNOSTIC_ID = 'preauth_origin_invalid';
const AUTHENTICATION_REQUIRED_DIAGNOSTIC_ID = 'preauth_authentication_required';
const STREAM_CLOSED_DIAGNOSTIC_ID = 'preauth_event_stream_closed';
const ABORTED_OPERATION = Symbol('aborted_operation');
const UTF8_ENCODER = new TextEncoder();
function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}
interface HostedCoordinationEventReplay {
  replay(input: ReplayCoordinationEventsInput): Promise<CoordinationReplayBatch>;
}
/** Live admission whose projector remains bound to the authorized grant context. */
interface HostedCoordinationEventStreamAuthorization extends HostedCoordinationEventStreamCurrentAuthorization {
  projectEvent(
    event: CoordinationEventEnvelope
  ): HostedCoordinationEventProjection | null | Promise<HostedCoordinationEventProjection | null>;
}
interface HostedCoordinationEventStreamAuthorizer {
  readonly allowedOrigin: string;
  authorize(
    request: HostedCoordinationHttpRequest
  ): Promise<HostedCoordinationEventStreamAuthorization | null>;
}
interface HostedCoordinationEventWakeupSource {
  subscribe(listener: CoordinationEventWakeupListener): () => void;
}
interface HostedCoordinationEventStreamControllerOptions {
  readonly replay: HostedCoordinationEventReplay;
  readonly authorizer: HostedCoordinationEventStreamAuthorizer;
  readonly wakeups: HostedCoordinationEventWakeupSource;
  readonly scheduler: HostedCoordinationEventStreamScheduler;
  readonly replayBatchSize?: number;
  readonly heartbeatIntervalMs?: number;
  readonly slowConsumerTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly streamIdentityFactory: HostedCoordinationEventStreamIdentityFactory;
  readonly diagnosticObserver?: HostedCoordinationEventStreamWriteObserver;
}

interface PreparedStream {
  readonly authorization: HostedCoordinationEventStreamAuthorization;
  readonly requestedCursor: ReplayCursor;
  readonly firstBatch: CoordinationReplayBatch;
  readonly firstReplayWakeVersion: number;
  readonly wakeSignal: WakeSignal;
  readonly signal: AbortSignal;
  readonly closeStream: () => void;
  readonly streamId: string;
}

function positiveBounded(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`invalid_hosted_event_stream_option:${field}`);
  }
  return value;
}

function exactHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function headerContainsMediaType(value: string | null, mediaType: string): boolean {
  return (
    value
      ?.split(',')
      .some((candidate) => candidate.split(';', 1)[0]?.trim().toLowerCase() === mediaType) ?? false
  );
}

function exactRefererOrigin(value: string | null, allowedOrigin: string): boolean {
  if (value === null) return false;
  try {
    return new URL(value).origin === allowedOrigin;
  } catch {
    return false;
  }
}

function admitsSameOriginEventSource(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  allowedOrigin: string
): boolean {
  const origin = exactHeader(headers.origin);
  if (origin !== null) return origin === allowedOrigin;

  // Native same-origin EventSource omits Origin and, under `no-referrer`, also
  // Referer. Fetch Metadata headers are browser-controlled, so require their
  // exact SSE shape instead of weakening the route to any cookie-bearing GET.
  // If a Referer is present despite policy, it must still be same-origin.
  const referer = exactHeader(headers.referer);
  return (
    exactHeader(headers['sec-fetch-site']) === 'same-origin' &&
    exactHeader(headers['sec-fetch-mode']) === 'cors' &&
    exactHeader(headers['sec-fetch-dest']) === 'empty' &&
    headerContainsMediaType(exactHeader(headers.accept), 'text/event-stream') &&
    (referer === null || exactRefererOrigin(referer, allowedOrigin))
  );
}

function initialCursor(request: HostedCoordinationHttpRequest): string | null {
  const reconnectCursor = exactHeader(request.headers['last-event-id']);
  if (reconnectCursor !== null) return reconnectCursor;
  const query = request.query as { readonly after?: unknown } | null;
  return typeof query?.after === 'string' ? query.after : null;
}

function boundedCursor(value: string | null): value is ReplayCursor {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function resyncReason(error: unknown): HostedCoordinationResyncReason | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  switch (code) {
    case 'invalid_replay_cursor':
    case 'unsupported_replay_cursor_version':
      return 'malformed_cursor';
    case 'replay_cursor_deployment_mismatch':
      return 'foreign_deployment';
    case 'replay_cursor_epoch_mismatch':
      return 'foreign_epoch';
    case 'replay_cursor_stale':
      return 'cursor_expired';
    case 'replay_cursor_ahead':
      return 'cursor_ahead';
    case 'event_sequence_discontinuity':
    case 'event_cursor_mismatch':
    case 'journal_watermark_mismatch':
    case 'journal_watermark_regression':
    case 'resource_revision_discontinuity':
    case 'journal_protocol_error':
      return 'event_gap';
    default:
      return null;
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function awaitUnlessAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED_OPERATION> {
  if (signal.aborted) return Promise.resolve(ABORTED_OPERATION);
  return new Promise<T | typeof ABORTED_OPERATION>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ABORTED_OPERATION);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

async function invokeUnlessAborted<T>(
  operation: () => Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED_OPERATION> {
  if (signal.aborted) return ABORTED_OPERATION;
  return await awaitUnlessAborted(operation(), signal);
}

function rawConnectionClosed(
  request: HostedCoordinationHttpRequest,
  reply: HostedCoordinationHttpReply
): boolean {
  return (
    request.raw.aborted ||
    request.raw.destroyed ||
    request.raw.socket.destroyed ||
    reply.raw.destroyed ||
    reply.raw.writableEnded
  );
}

function materializeProjectedEnvelope(input: {
  readonly event: CoordinationEventEnvelope;
  readonly projection: HostedCoordinationEventProjection;
  readonly previousEventCursor: ReplayCursor;
  readonly maxFrameBytes: number;
}): { readonly envelope: HostedCoordinationEventEnvelope; readonly data: string } | null {
  const { event, projection } = input;
  if (
    !validIdentifier(event.deploymentId) ||
    !validIdentifier(event.eventEpoch) ||
    !validIdentifier(event.eventId) ||
    !boundedCursor(event.eventCursor) ||
    !Number.isSafeInteger(event.eventSequence) ||
    event.eventSequence < 0 ||
    !event.scope ||
    !validIdentifier(event.scope.scopeId) ||
    !validIdentifier(projection.eventType) ||
    !projection.scope ||
    !validIdentifier(projection.scope.scopeId) ||
    projection.publicPayload === undefined ||
    projection.scope.kind !== event.scope.kind ||
    projection.scope.scopeId !== event.scope.scopeId
  ) {
    return null;
  }
  const envelope: HostedCoordinationEventEnvelope = Object.freeze({
    schemaVersion: HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: event.deploymentId,
    eventEpoch: event.eventEpoch,
    eventSequence: event.eventSequence,
    eventId: event.eventId,
    previousEventCursor: input.previousEventCursor,
    eventCursor: event.eventCursor,
    scope: Object.freeze({ ...projection.scope }),
    eventType: projection.eventType,
    ...(projection.resourceRevision === undefined
      ? {}
      : { resourceRevision: Object.freeze({ ...projection.resourceRevision }) }),
    emittedAt: event.emittedAt,
    payload: projection.publicPayload,
  });
  let data: string;
  try {
    data = JSON.stringify(envelope);
  } catch {
    return null;
  }
  if (utf8ByteLength(data) > input.maxFrameBytes) return null;
  return Object.freeze({ envelope, data });
}

function eventFrame(cursor: ReplayCursor, data: string): string {
  return `id: ${cursor}\nevent: ${HOSTED_COORDINATION_EVENT_SSE_EVENT}\ndata: ${data}\n\n`;
}

function resyncFrame(reason: HostedCoordinationResyncReason): string {
  const message: HostedCoordinationResyncRequired = Object.freeze({
    schemaVersion: HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
    kind: HOSTED_COORDINATION_RESYNC_SSE_EVENT,
    reason,
  });
  return `event: ${HOSTED_COORDINATION_RESYNC_SSE_EVENT}\ndata: ${JSON.stringify(message)}\n\n`;
}

export class HostedCoordinationEventStreamController {
  private readonly options: HostedCoordinationEventStreamControllerOptions;
  private readonly replayBatchSize: number;
  private readonly heartbeatIntervalMs: number;
  private readonly slowConsumerTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly writer: HostedCoordinationEventStreamWriter;
  private readonly activeStreams = new Set<() => void>();
  private closed = false;
  private draining = false;
  private rejectedOriginDiagnosticRecorded = false;
  private authenticationDiagnosticRecorded = false;
  private streamClosedDiagnosticRecorded = false;
  private readonly pendingWrites = new Set<Promise<boolean>>();

  constructor(options: unknown) {
    const controllerOptions = options as HostedCoordinationEventStreamControllerOptions;
    if (
      !controllerOptions?.replay ||
      !controllerOptions.authorizer ||
      !controllerOptions.wakeups ||
      !controllerOptions.scheduler
    ) {
      throw new Error('invalid_hosted_event_stream_options');
    }
    this.options = controllerOptions;
    this.replayBatchSize = positiveBounded(
      controllerOptions.replayBatchSize ?? DEFAULT_REPLAY_BATCH_SIZE,
      'replayBatchSize',
      MAX_REPLAY_BATCH_SIZE
    );
    this.heartbeatIntervalMs = positiveBounded(
      controllerOptions.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs',
      60 * 60 * 1_000
    );
    this.slowConsumerTimeoutMs = positiveBounded(
      controllerOptions.slowConsumerTimeoutMs ?? DEFAULT_SLOW_CONSUMER_TIMEOUT_MS,
      'slowConsumerTimeoutMs',
      60_000
    );
    this.maxFrameBytes = positiveBounded(
      controllerOptions.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      'maxFrameBytes',
      1024 * 1024
    );
    this.writer = new HostedCoordinationEventStreamWriter({
      maxFrameBytes: this.maxFrameBytes + 512,
      observer: controllerOptions.diagnosticObserver,
      scheduler: controllerOptions.scheduler,
      slowConsumerTimeoutMs: this.slowConsumerTimeoutMs,
    });
  }

  register(app: unknown): void {
    const httpApp = app as HostedCoordinationHttpApplication;
    httpApp.get(HOSTED_COORDINATION_EVENT_STREAM_ROUTE, async (request, reply) => {
      await this.handle(request, reply);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const closeStream of [...this.activeStreams]) closeStream();
  }

  /** Stop admission synchronously; keep admitted writes and evidence alive before retirement. */
  async runWithStreamsDrained<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.draining) throw new Error('event_stream_drain_unavailable');
    this.draining = true;
    try {
      await Promise.all([...this.pendingWrites]);
      for (const closeStream of [...this.activeStreams]) closeStream();
      return await operation();
    } finally {
      this.draining = false;
    }
  }

  private async handle(
    request: HostedCoordinationHttpRequest,
    reply: HostedCoordinationHttpReply
  ): Promise<void> {
    const originAdmitted = admitsSameOriginEventSource(
      request.headers,
      this.options.authorizer.allowedOrigin
    );
    if (!originAdmitted) {
      // Origin failures are pre-auth and attacker-triggerable. Keep one fixed
      // attempted/terminal transition without retaining or logging origin data.
      const observeDiagnostic = !this.rejectedOriginDiagnosticRecorded;
      this.rejectedOriginDiagnosticRecorded = true;
      await this.sendJson(
        reply,
        403,
        { error: 'origin_invalid' },
        REJECTED_ORIGIN_DIAGNOSTIC_ID,
        observeDiagnostic
      );
      return;
    }
    if (this.closed || this.draining) {
      const observeDiagnostic = !this.streamClosedDiagnosticRecorded;
      this.streamClosedDiagnosticRecorded = true;
      await this.sendJson(
        reply,
        503,
        { error: 'event_stream_closed' },
        STREAM_CLOSED_DIAGNOSTIC_ID,
        observeDiagnostic
      );
      return;
    }
    let streamId = AUTHENTICATION_REQUIRED_DIAGNOSTIC_ID;
    const wakeSignal = new WakeSignal();
    const streamController = new AbortController();
    let unsubscribeWakeup = (): void => undefined;
    let streamDisposed = false;
    let streamClosed = false;
    let authorizationComplete = false;
    const disposeStream = (): void => {
      if (streamDisposed) return;
      streamDisposed = true;
      unsubscribeWakeup();
      this.activeStreams.delete(closeStream);
      request.raw.removeListener('aborted', onAborted);
      request.raw.socket.removeListener('close', onAborted);
      reply.raw.removeListener('close', onAborted);
      reply.raw.removeListener('error', onAborted);
    };
    const closeStream = (): void => {
      if (streamClosed) return;
      streamClosed = true;
      streamController.abort();
      disposeStream();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        const observeDiagnostic =
          authorizationComplete || !this.authenticationDiagnosticRecorded;
        if (!authorizationComplete) this.authenticationDiagnosticRecorded = true;
        if (observeDiagnostic) this.observeResponse(reply, streamId, 'sse_close', 'attempted');
        try {
          if (authorizationComplete) reply.raw.end();
          else reply.raw.destroy();
        } catch {
          // Cleanup must not replace the live transport failure which caused it.
          try {
            reply.raw.destroy();
          } catch {
            // The response is already outside Fastify ownership after hijack.
          }
        }
        if (observeDiagnostic) this.observeResponse(reply, streamId, 'sse_close', 'committed');
      }
    };
    const onAborted = (): void => closeStream();
    request.raw.once('aborted', onAborted);
    request.raw.socket.once('close', onAborted);
    reply.raw.once('close', onAborted);
    reply.raw.once('error', onAborted);
    this.activeStreams.add(closeStream);
    if (this.closed || rawConnectionClosed(request, reply)) {
      closeStream();
      return;
    }

    let authorization: HostedCoordinationEventStreamAuthorization | null;
    try {
      const result = await invokeUnlessAborted(
        () => this.options.authorizer.authorize(request),
        streamController.signal
      );
      if (result === ABORTED_OPERATION) return;
      authorization = result;
    } catch {
      if (streamController.signal.aborted) return;
      authorization = null;
    }
    if (streamController.signal.aborted || rawConnectionClosed(request, reply)) {
      closeStream();
      return;
    }
    if (authorization === null) {
      streamController.abort();
      disposeStream();
      const observeDiagnostic = !this.authenticationDiagnosticRecorded;
      this.authenticationDiagnosticRecorded = true;
      await this.sendJson(
        reply,
        401,
        { error: 'authentication_required' },
        AUTHENTICATION_REQUIRED_DIAGNOSTIC_ID,
        observeDiagnostic
      );
      return;
    }
    streamId = this.options.streamIdentityFactory.createStreamId();
    authorizationComplete = true;

    const cursor = initialCursor(request);
    if (!boundedCursor(cursor)) {
      try {
        await this.sendTerminalResync(
          reply,
          'malformed_cursor',
          authorization,
          streamController.signal,
          streamId
        );
      } finally {
        closeStream();
      }
      return;
    }

    try {
      const subscribedUnsubscribe = this.options.wakeups.subscribe(wakeSignal.notify);
      unsubscribeWakeup = subscribedUnsubscribe;
      if (streamDisposed) subscribedUnsubscribe();
    } catch {
      if (streamController.signal.aborted || rawConnectionClosed(request, reply)) {
        closeStream();
        return;
      }
      streamController.abort();
      disposeStream();
      await this.sendJson(reply, 503, { error: 'event_stream_unavailable' }, streamId);
      return;
    }
    if (streamController.signal.aborted || rawConnectionClosed(request, reply)) {
      closeStream();
      return;
    }
    const firstReplayWakeVersion = wakeSignal.version;
    let firstBatch: CoordinationReplayBatch;
    try {
      if (!(await authorizationIsCurrent(authorization, streamController.signal))) {
        closeStream();
        return;
      }
      const result = await invokeUnlessAborted(
        () =>
          this.options.replay.replay({
            cursor,
            maxEvents: this.replayBatchSize,
          }),
        streamController.signal
      );
      if (result === ABORTED_OPERATION) return;
      firstBatch = result;
      if (!(await authorizationIsCurrent(authorization, streamController.signal))) {
        closeStream();
        return;
      }
    } catch (error) {
      if (streamController.signal.aborted) return;
      const reason = resyncReason(error);
      try {
        if (reason !== null) {
          await this.sendTerminalResync(
            reply,
            reason,
            authorization,
            streamController.signal,
            streamId
          );
        } else {
          streamController.abort();
          disposeStream();
          await this.sendJson(reply, 503, { error: 'event_stream_unavailable' }, streamId);
        }
      } finally {
        closeStream();
      }
      return;
    }

    if (streamController.signal.aborted) return;

    const prepared: PreparedStream = {
      authorization,
      requestedCursor: cursor,
      firstBatch,
      firstReplayWakeVersion,
      wakeSignal,
      signal: streamController.signal,
      closeStream,
      streamId,
    };
    await this.runStream(reply, prepared);
  }

  private async sendTerminalResync(
    reply: HostedCoordinationHttpReply,
    reason: HostedCoordinationResyncReason,
    authorization: HostedCoordinationEventStreamAuthorization,
    signal: AbortSignal,
    streamId: string
  ): Promise<void> {
    if (!this.beginSseResponse(reply, signal, streamId)) return;
    await this.writeAuthorized(
      reply,
      resyncFrame(reason),
      { frameKind: 'resync_required', eventId: null, eventType: 'resync_required' },
      authorization,
      signal,
      streamId
    );
    if (!reply.raw.destroyed && !reply.raw.writableEnded && reply.raw.headersSent) reply.raw.end();
  }

  private async runStream(
    reply: HostedCoordinationHttpReply,
    prepared: PreparedStream
  ): Promise<void> {
    if (!(await authorizationIsCurrent(prepared.authorization, prepared.signal))) {
      prepared.closeStream();
      return;
    }
    let setupComplete = false;
    try {
      if (!this.beginSseResponse(reply, prepared.signal, prepared.streamId)) return;
      setupComplete = true;
    } finally {
      if (!setupComplete) prepared.closeStream();
    }
    let replayCursor = prepared.requestedCursor;
    let deliveredCursor = prepared.requestedCursor;
    let nextBatch: CoordinationReplayBatch | null = prepared.firstBatch;
    const replayWakeVersion = prepared.firstReplayWakeVersion;

    try {
      while (!prepared.signal.aborted) {
        const wakeVersionBeforeReplay =
          nextBatch === null ? prepared.wakeSignal.version : replayWakeVersion;
        do {
          let batch: CoordinationReplayBatch;
          if (nextBatch !== null) {
            batch = nextBatch;
            nextBatch = null;
          } else {
            if (!(await authorizationIsCurrent(prepared.authorization, prepared.signal))) {
              return;
            }
            const result = await invokeUnlessAborted(
              () =>
                this.options.replay.replay({
                  cursor: replayCursor,
                  maxEvents: this.replayBatchSize,
                }),
              prepared.signal
            );
            if (result === ABORTED_OPERATION) return;
            batch = result;
            if (!(await authorizationIsCurrent(prepared.authorization, prepared.signal))) {
              return;
            }
          }
          for (const event of batch.events) {
            const projected = await prepared.authorization.projectEvent(event);
            if (projected === null) {
              if (!(await authorizationIsCurrent(prepared.authorization, prepared.signal))) {
                return;
              }
              continue;
            }
            const materialized = materializeProjectedEnvelope({
              event,
              projection: projected,
              previousEventCursor: deliveredCursor,
              maxFrameBytes: this.maxFrameBytes,
            });
            if (materialized === null) {
              await this.writeAuthorized(
                reply,
                resyncFrame('projection_invalid'),
                { frameKind: 'resync_required', eventId: null, eventType: 'resync_required' },
                prepared.authorization,
                prepared.signal,
                prepared.streamId
              );
              return;
            }
            const wrote = await this.writeAuthorized(
              reply,
              eventFrame(event.eventCursor, materialized.data),
              {
                frameKind: 'coordination_event',
                eventId: event.eventCursor,
                eventType: HOSTED_COORDINATION_EVENT_SSE_EVENT,
              },
              prepared.authorization,
              prepared.signal,
              prepared.streamId
            );
            if (!wrote) return;
            deliveredCursor = event.eventCursor;
          }
          replayCursor = batch.nextCursor;
          if (!batch.hasMore) break;
        } while (!prepared.signal.aborted);

        if (prepared.signal.aborted) break;
        if (prepared.wakeSignal.version !== wakeVersionBeforeReplay) continue;
        const wakeResult = await prepared.wakeSignal.wait({
          afterVersion: wakeVersionBeforeReplay,
          delayMs: this.heartbeatIntervalMs,
          signal: prepared.signal,
          scheduler: this.options.scheduler,
        });
        if (wakeResult === 'closed') break;
        if (wakeResult === 'heartbeat') {
          const wrote = await this.writeAuthorized(
            reply,
            ': heartbeat\n\n',
            { frameKind: 'heartbeat', eventId: null, eventType: null },
            prepared.authorization,
            prepared.signal,
            prepared.streamId
          );
          if (!wrote) break;
        }
        // Wake-ups are hints. Both wake and heartbeat re-query durable state.
      }
    } catch (error) {
      const reason = resyncReason(error);
      if (reason !== null && !prepared.signal.aborted) {
        await this.writeAuthorized(
          reply,
          resyncFrame(reason),
          { frameKind: 'resync_required', eventId: null, eventType: 'resync_required' },
          prepared.authorization,
          prepared.signal,
          prepared.streamId
        );
      }
    } finally {
      prepared.closeStream();
    }
  }

  private async writeAuthorized(
    reply: HostedCoordinationHttpReply,
    frame: string,
    identity: ProductSseFrameIdentity,
    authorization: HostedCoordinationEventStreamAuthorization,
    signal: AbortSignal,
    streamId: string
  ): Promise<boolean> {
    if (!(await authorizationIsCurrent(authorization, signal))) return false;
    if (this.closed || this.draining) return false;
    const productSseWriteEmitter = currentProductHostedProducerSseWriteEmitter();
    const pending = (async () => {
      const disposition = await this.writer.write({ frame, raw: reply.raw, signal, streamId });
      const wrote = hostedCoordinationEventStreamWriteSucceeded(disposition);
      return await (productSseWriteEmitter?.(frame, identity, wrote) ?? wrote);
    })();
    this.pendingWrites.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingWrites.delete(pending);
    }
  }

  private responseCommittedOrUnavailable(reply: HostedCoordinationHttpReply): boolean {
    return reply.sent || reply.raw.headersSent || this.rawResponseUnavailable(reply);
  }

  private rawResponseUnavailable(reply: HostedCoordinationHttpReply): boolean {
    return reply.raw.destroyed || reply.raw.writableEnded;
  }

  private observeResponse(
    reply: HostedCoordinationHttpReply,
    streamId: string,
    writer: 'fastify_json' | 'sse_headers' | 'sse_close',
    disposition: 'attempted' | 'committed' | 'skipped_closed' | 'failed_closed'
  ): void {
    try {
      this.options.diagnosticObserver?.({
        kind: 'response_lifecycle',
        streamId,
        writer,
        disposition,
        replySent: reply.sent,
        headersSent: reply.raw.headersSent,
        destroyed: reply.raw.destroyed,
        writableEnded: reply.raw.writableEnded,
      });
    } catch {
      // Diagnostics cannot affect the response lifecycle.
    }
  }

  private async sendJson(
    reply: HostedCoordinationHttpReply,
    statusCode: number,
    payload: unknown,
    streamId: string,
    observeDiagnostic = true
  ): Promise<void> {
    if (observeDiagnostic) this.observeResponse(reply, streamId, 'fastify_json', 'attempted');
    if (this.responseCommittedOrUnavailable(reply)) {
      if (observeDiagnostic) this.observeResponse(reply, streamId, 'fastify_json', 'skipped_closed');
      return;
    }
    try {
      await reply.code(statusCode).send(payload);
      if (observeDiagnostic) this.observeResponse(reply, streamId, 'fastify_json', 'committed');
    } catch (error) {
      if (!this.responseCommittedOrUnavailable(reply)) throw error;
      if (observeDiagnostic) this.observeResponse(reply, streamId, 'fastify_json', 'failed_closed');
    }
  }

  private beginSseResponse(
    reply: HostedCoordinationHttpReply,
    signal: AbortSignal,
    streamId: string
  ): boolean {
    this.observeResponse(reply, streamId, 'sse_headers', 'attempted');
    if (
      signal.aborted ||
      this.closed ||
      this.draining ||
      this.responseCommittedOrUnavailable(reply)
    ) {
      this.observeResponse(reply, streamId, 'sse_headers', 'skipped_closed');
      return false;
    }
    try {
      reply.hijack();
      if (
        signal.aborted ||
        reply.raw.destroyed ||
        reply.raw.writableEnded ||
        reply.raw.headersSent
      ) {
        this.observeResponse(reply, streamId, 'sse_headers', 'skipped_closed');
        return false;
      }
      reply.raw.writeHead(200, this.sseHeaders(streamId));
      reply.raw.flushHeaders();
      this.observeResponse(reply, streamId, 'sse_headers', 'committed');
      return true;
    } catch (error) {
      // Fastify marks reply.sent at hijack time. It therefore cannot identify a
      // closed transport here: live writeHead/flushHeaders failures must escape.
      if (!(signal.aborted || this.closed || this.draining || this.rawResponseUnavailable(reply))) {
        throw error;
      }
      this.observeResponse(reply, streamId, 'sse_headers', 'failed_closed');
      return false;
    }
  }

  private sseHeaders(streamId: string): Readonly<Record<string, string>> {
    return Object.freeze({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, private',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Agent-Teams-Event-Stream-Id': streamId,
    });
  }
}
