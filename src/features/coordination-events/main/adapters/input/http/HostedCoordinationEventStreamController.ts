import {
  currentProductHostedProducerSseWriteEmitter,
  type ProductSseFrameIdentity,
} from '@features/hosted-producer-provenance/main/hosted';

import {
  type CoordinationEventEnvelope,
  type CoordinationReplayBatch,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_EVENT_STREAM_ROUTE,
  type HostedCoordinationEventProjection,
  type HostedCoordinationResyncReason,
  type ReplayCursor,
} from '../../../../contracts';

import {
  hostedCoordinationEventStreamAuthorizationIsCurrent as authorizationIsCurrent,
  type HostedCoordinationEventStreamCurrentAuthorization,
} from './hostedCoordinationEventStreamAuthorization';
import {
  eventFrame,
  materializeProjectedEnvelope,
  resyncFrame,
} from './HostedCoordinationEventStreamFrames';
import {
  admitsSameOriginEventSource,
  type HostedCoordinationHttpApplication,
  type HostedCoordinationHttpReply,
  type HostedCoordinationHttpRequest,
  boundedCursor,
  initialCursor,
  rawConnectionClosed,
  resyncReason,
} from './HostedCoordinationEventStreamRequestSupport';
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

/** Releases one retained admission fence. A failed generation deliberately
 * leaves its fence retained so the route remains fail-closed. */
export type HostedCoordinationEventStreamAdmissionRelease = () => void;

/** Returns the release for the admission fence synchronously retained before
 * the drain waits for already-admitted writes and their evidence. */
export type RetainHostedCoordinationEventStreamAdmission = () =>
  HostedCoordinationEventStreamAdmissionRelease;

const DEFAULT_REPLAY_BATCH_SIZE = 100;
const MAX_REPLAY_BATCH_SIZE = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SLOW_CONSUMER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1_024;
const REJECTED_ORIGIN_DIAGNOSTIC_ID = 'preauth_origin_invalid';
const AUTHENTICATION_REQUIRED_DIAGNOSTIC_ID = 'preauth_authentication_required';
const STREAM_CLOSED_DIAGNOSTIC_ID = 'preauth_event_stream_closed';
const ABORTED_OPERATION = Symbol('aborted_operation');
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
  private readonly retainedAdmissions = new Set<symbol>();

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

  /** Stop admission synchronously and retain that fence before awaiting any
   * already-admitted writes or their evidence. The caller receives the release
   * only after the drain completes, and must use it only after successor
   * readiness. A failed drain deliberately leaves the fence closed. */
  async runWithStreamsDrained<T>(
    operation: (retainAdmission: RetainHostedCoordinationEventStreamAdmission) => Promise<T>
  ): Promise<T> {
    if (this.admissionClosed()) throw new Error('event_stream_drain_unavailable');
    this.draining = true;
    const releaseAdmission = this.retainAdmission();
    try {
      await Promise.all([...this.pendingWrites]);
      for (const closeStream of [...this.activeStreams]) closeStream();
      return await operation(() => releaseAdmission);
    } finally {
      // The retained fence, not this transient drain state, owns admission
      // after this point. If drain/evidence failed, nobody received its release.
      this.draining = false;
    }
  }

  private retainAdmission(): HostedCoordinationEventStreamAdmissionRelease {
    if (this.closed || !this.draining) throw new Error('event_stream_admission_retain_unavailable');
    const token = Symbol('hosted_coordination_event_stream_admission');
    this.retainedAdmissions.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainedAdmissions.delete(token);
    };
  }

  private admissionClosed(): boolean {
    return this.closed || this.draining || this.retainedAdmissions.size > 0;
  }

  private async handle(
    request: HostedCoordinationHttpRequest,
    reply: HostedCoordinationHttpReply
  ): Promise<void> {
    const originAdmitted = admitsSameOriginEventSource(request.headers, this.options.authorizer.allowedOrigin);
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
    if (this.admissionClosed()) {
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
    if (this.admissionClosed()) return false;
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
      this.admissionClosed() ||
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
      if (!(signal.aborted || this.admissionClosed() || this.rawResponseUnavailable(reply))) {
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
