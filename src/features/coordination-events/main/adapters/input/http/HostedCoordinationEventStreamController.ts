import {
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_EVENT_STREAM_ROUTE,
  HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
  HOSTED_COORDINATION_RESYNC_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type HostedCoordinationEventProjection,
  type HostedCoordinationResyncReason,
  type HostedCoordinationResyncRequired,
} from '../../../../contracts';

import type {
  CoordinationEventEnvelope,
  CoordinationReplayBatch,
  ReplayCursor,
} from '../../../../contracts';
import type { ReplayCoordinationEventsInput } from '../../../../core/application';
import type { CoordinationEventWakeupListener } from '../../../infrastructure/InProcessCoordinationEventWakeupHub';

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
  readonly writableEnded: boolean;
  end(): unknown;
  once(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  write(frame: string): boolean;
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown;
}

interface HostedCoordinationHttpReply {
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
const ABORTED_OPERATION = Symbol('aborted_operation');
const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

interface HostedCoordinationEventReplay {
  replay(input: ReplayCoordinationEventsInput): Promise<CoordinationReplayBatch>;
}

/**
 * Returned only after exact Origin, live session, and complete stream-scope
 * authorization. The closure projects each event through the already-bound
 * grant context and returns null for a scope that is no longer readable.
 */
interface HostedCoordinationEventStreamAuthorization {
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

export interface HostedCoordinationEventStreamScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
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
}

type WakeResult = 'wakeup' | 'heartbeat' | 'closed';

interface PreparedStream {
  readonly authorization: HostedCoordinationEventStreamAuthorization;
  readonly requestedCursor: ReplayCursor;
  readonly firstBatch: CoordinationReplayBatch;
  readonly firstReplayWakeVersion: number;
  readonly wakeSignal: WakeSignal;
  readonly signal: AbortSignal;
  readonly closeStream: () => void;
}

class WakeSignal {
  private versionValue = 0;
  private readonly listeners = new Set<() => void>();

  get version(): number {
    return this.versionValue;
  }

  notify = (): void => {
    this.versionValue += 1;
    for (const listener of [...this.listeners]) listener();
  };

  wait(input: {
    readonly afterVersion: number;
    readonly delayMs: number;
    readonly signal: AbortSignal;
    readonly scheduler: HostedCoordinationEventStreamScheduler;
  }): Promise<WakeResult> {
    if (input.signal.aborted) return Promise.resolve('closed');
    if (this.versionValue !== input.afterVersion) return Promise.resolve('wakeup');
    return new Promise<WakeResult>((resolve) => {
      let settled = false;
      let cancelSchedule = (): void => undefined;
      const finish = (result: WakeResult): void => {
        if (settled) return;
        settled = true;
        cancelSchedule();
        this.listeners.delete(onWakeup);
        input.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onWakeup = (): void => finish('wakeup');
      const onAbort = (): void => finish('closed');
      cancelSchedule = input.scheduler.schedule(input.delayMs, () => finish('heartbeat'));
      this.listeners.add(onWakeup);
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (this.versionValue !== input.afterVersion) finish('wakeup');
    });
  }
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
  private readonly activeStreams = new Set<() => void>();
  private closed = false;

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

  private async handle(
    request: HostedCoordinationHttpRequest,
    reply: HostedCoordinationHttpReply
  ): Promise<void> {
    if (this.closed) {
      await reply.code(503).send({ error: 'event_stream_closed' });
      return;
    }
    if (exactHeader(request.headers.origin) !== this.options.authorizer.allowedOrigin) {
      await reply.code(403).send({ error: 'origin_invalid' });
      return;
    }

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
      if (authorizationComplete && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
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
      await reply.code(401).send({ error: 'authentication_required' });
      return;
    }
    authorizationComplete = true;

    const cursor = initialCursor(request);
    if (!boundedCursor(cursor)) {
      try {
        await this.sendTerminalResync(reply, 'malformed_cursor', streamController.signal);
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
      await reply.code(503).send({ error: 'event_stream_unavailable' });
      return;
    }
    if (streamController.signal.aborted || rawConnectionClosed(request, reply)) {
      closeStream();
      return;
    }
    const firstReplayWakeVersion = wakeSignal.version;
    let firstBatch: CoordinationReplayBatch;
    try {
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
    } catch (error) {
      if (streamController.signal.aborted) return;
      const reason = resyncReason(error);
      try {
        if (reason !== null) {
          await this.sendTerminalResync(reply, reason, streamController.signal);
        } else {
          streamController.abort();
          disposeStream();
          await reply.code(503).send({ error: 'event_stream_unavailable' });
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
    };
    await this.runStream(reply, prepared);
  }

  private async sendTerminalResync(
    reply: HostedCoordinationHttpReply,
    reason: HostedCoordinationResyncReason,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    reply.hijack();
    reply.raw.writeHead(200, this.sseHeaders());
    await this.writeBounded(reply, resyncFrame(reason), signal);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  }

  private async runStream(
    reply: HostedCoordinationHttpReply,
    prepared: PreparedStream
  ): Promise<void> {
    reply.hijack();
    reply.raw.writeHead(200, this.sseHeaders());
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
          }
          for (const event of batch.events) {
            const projected = await prepared.authorization.projectEvent(event);
            if (projected === null) continue;
            const materialized = materializeProjectedEnvelope({
              event,
              projection: projected,
              previousEventCursor: deliveredCursor,
              maxFrameBytes: this.maxFrameBytes,
            });
            if (materialized === null) {
              await this.writeBounded(reply, resyncFrame('projection_invalid'), prepared.signal);
              return;
            }
            const wrote = await this.writeBounded(
              reply,
              eventFrame(event.eventCursor, materialized.data),
              prepared.signal
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
          const wrote = await this.writeBounded(reply, ': heartbeat\n\n', prepared.signal);
          if (!wrote) break;
        }
        // Wake-ups are hints. Both wake and heartbeat re-query durable state.
      }
    } catch (error) {
      const reason = resyncReason(error);
      if (reason !== null && !prepared.signal.aborted) {
        await this.writeBounded(reply, resyncFrame(reason), prepared.signal);
      }
    } finally {
      prepared.closeStream();
    }
  }

  private writeBounded(
    reply: HostedCoordinationHttpReply,
    frame: string,
    signal: AbortSignal
  ): Promise<boolean> {
    if (
      signal.aborted ||
      reply.raw.destroyed ||
      reply.raw.writableEnded ||
      utf8ByteLength(frame) > this.maxFrameBytes + 512
    ) {
      return Promise.resolve(false);
    }
    try {
      if (reply.raw.write(frame)) return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let cancelDeadline = (): void => undefined;
      const finish = (writable: boolean): void => {
        if (settled) return;
        settled = true;
        cancelDeadline();
        reply.raw.removeListener('drain', onDrain);
        reply.raw.removeListener('close', onClose);
        signal.removeEventListener('abort', onClose);
        resolve(writable);
      };
      const onDrain = (): void => finish(true);
      const onClose = (): void => finish(false);
      cancelDeadline = this.options.scheduler.schedule(this.slowConsumerTimeoutMs, onClose);
      reply.raw.once('drain', onDrain);
      reply.raw.once('close', onClose);
      signal.addEventListener('abort', onClose, { once: true });
      if (signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) onClose();
    });
  }

  private sseHeaders(): Readonly<Record<string, string>> {
    return Object.freeze({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, private',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }
}
