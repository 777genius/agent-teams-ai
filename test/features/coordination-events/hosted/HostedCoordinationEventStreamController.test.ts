import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { CoordinationEventHandoff } from '@features/coordination-events/core/application/CoordinationEventHandoff';
import { encodeReplayCursor } from '@features/coordination-events/core/domain';
import {
  HostedCoordinationEventStreamController,
} from '@features/coordination-events/main/adapters/input/http/HostedCoordinationEventStreamController';
import { SqliteCoordinationEventJournal } from '@features/coordination-events/main/adapters/output/SqliteCoordinationEventJournal';
import {
  bindProductHostedProducerInstance,
  clearProductHostedProducerProvenance,
  type HostedProducerProvenance,
  installProductHostedProducerProvenance,
} from '@features/hosted-producer-provenance/main/hosted';
import { resetProductHostedProducerProvenanceForTests } from '@features/hosted-producer-provenance/main/HostedProducerProvenanceRegistry';
import { createProductHostedProducerSseWriteEmitter } from '@main/composition/hosted/hostedProducerProvenanceNodeOperations';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CoordinationEventEnvelope,
  CoordinationJsonValue,
  CoordinationReplayBatch,
  ReplayCursor,
} from '@features/coordination-events/contracts';
import type { HostedCoordinationEventStreamScheduler } from '@features/coordination-events/main';
import type {
  HostedCoordinationEventStreamWriteObservation,
} from '@features/coordination-events/main/hosted';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const cursor = (value: string): ReplayCursor => value as ReplayCursor;
const streamIdentityFactory = Object.freeze({ createStreamId: randomUUID });

afterEach(() => resetProductHostedProducerProvenanceForTests());

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ManualScheduler implements HostedCoordinationEventStreamScheduler {
  readonly pending: Array<{ active: boolean; callback: () => void }> = [];

  schedule(_delayMs: number, callback: () => void): () => void {
    const task = { active: true, callback };
    this.pending.push(task);
    return () => {
      task.active = false;
    };
  }

  runNext(): void {
    const task = this.pending.find((candidate) => candidate.active);
    if (!task) throw new Error('no scheduled task');
    task.active = false;
    task.callback();
  }
}

class FakeRawReply extends EventEmitter {
  destroyed = false;
  headersSent = false;
  writableEnded = false;
  flushes = 0;
  destroyCalls = 0;
  readonly frames: string[] = [];
  readonly headers: Array<{ status: number; headers: Record<string, string> }> = [];
  writeResult = true;
  writeHeadError?: Error;
  flushHeadersError?: Error;
  onFlushHeaders?: () => void;
  onWrite?: (frame: string) => void;

  writeHead(status: number, headers: Record<string, string>): void {
    if (this.writeHeadError) throw this.writeHeadError;
    if (this.headersSent)
      throw Object.assign(new Error('headers already sent'), { code: 'ERR_HTTP_HEADERS_SENT' });
    this.headersSent = true;
    this.headers.push({ status, headers });
  }

  flushHeaders(): void {
    this.onFlushHeaders?.();
    if (this.flushHeadersError) throw this.flushHeadersError;
    this.flushes += 1;
  }

  write(frame: string): boolean {
    this.frames.push(frame);
    this.onWrite?.(frame);
    return this.writeResult;
  }

  end(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
  }

  destroy(): void {
    this.destroyCalls += 1;
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

interface FakeReplyState {
  readonly reply: FastifyReply;
  readonly raw: FakeRawReply;
  readonly hijack: ReturnType<typeof vi.fn>;
  statusCode: number;
  sent: boolean;
  body: unknown;
}

function createReply(): FakeReplyState {
  const raw = new FakeRawReply();
  const hijack = vi.fn();
  const state = {
    raw,
    hijack,
    statusCode: 200,
    sent: false,
    body: undefined as unknown,
  } as FakeReplyState;
  hijack.mockImplementation(() => {
    state.sent = true;
  });
  const reply = {
    raw,
    get sent() {
      return state.sent;
    },
    hijack: state.hijack,
    code: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      if (state.sent || raw.headersSent) {
        throw Object.assign(new Error('headers already sent'), { code: 'ERR_HTTP_HEADERS_SENT' });
      }
      state.sent = true;
      state.body = body;
      return reply;
    }),
  } as unknown as FastifyReply;
  Object.defineProperty(state, 'reply', { value: reply, enumerable: true });
  return state;
}

function createRequest(input: {
  readonly origin?: string;
  readonly accept?: string;
  readonly referer?: string;
  readonly secFetchDest?: string;
  readonly secFetchMode?: string;
  readonly secFetchSite?: string;
  readonly after?: string;
  readonly lastEventId?: string;
}): FastifyRequest {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const raw = Object.assign(new EventEmitter(), {
    socket,
    aborted: false,
    destroyed: false,
  });
  return {
    headers: {
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.accept === undefined ? {} : { accept: input.accept }),
      ...(input.referer === undefined ? {} : { referer: input.referer }),
      ...(input.secFetchDest === undefined ? {} : { 'sec-fetch-dest': input.secFetchDest }),
      ...(input.secFetchMode === undefined ? {} : { 'sec-fetch-mode': input.secFetchMode }),
      ...(input.secFetchSite === undefined ? {} : { 'sec-fetch-site': input.secFetchSite }),
      ...(input.lastEventId === undefined ? {} : { 'last-event-id': input.lastEventId }),
    },
    query: input.after === undefined ? {} : { after: input.after },
    raw,
  } as unknown as FastifyRequest;
}

function registerHandler(
  controller: HostedCoordinationEventStreamController
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  let handler: ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) | undefined;
  controller.register({
    get: vi.fn((_route: string, registered: typeof handler) => {
      handler = registered;
    }),
  } as unknown as FastifyInstance);
  if (!handler) throw new Error('route was not registered');
  return handler;
}

function event(input: {
  readonly sequence: number;
  readonly previous?: string;
}): CoordinationEventEnvelope {
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-1',
    eventEpoch: 'epoch-1',
    eventSequence: input.sequence,
    eventCursor: cursor(`cursor-${input.sequence}`),
    eventId: `event-${input.sequence}`,
    scope: { kind: 'team', scopeId: 'team-1' },
    workspaceId: '/Users/private-owner/workspaces/secret-project',
    teamId: 'team-1',
    actor: { kind: 'operator', actorRef: 'private-actor' },
    eventType: 'team.changed',
    resourceRevision: {
      resourceKey: 'team:team-1',
      generation: 1,
      revision: input.sequence,
    },
    emittedAt: '2026-08-02T00:00:00.000Z',
    payload: {
      publicValue: input.sequence,
      internal: {
        workspacePath: '/Users/private-owner/workspaces/secret-project',
        command: { body: 'rm --private-body' },
        provider: { name: 'private-provider', auth: { accessToken: 'secret-token' } },
      },
    },
  };
}

function batch(input: {
  readonly from: string;
  readonly next: string;
  readonly events: readonly CoordinationEventEnvelope[];
  readonly hasMore: boolean;
}): CoordinationReplayBatch {
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-1',
    eventEpoch: 'epoch-1',
    fromCursor: cursor(input.from),
    nextCursor: cursor(input.next),
    events: input.events,
    watermark: {
      schemaVersion: 1,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      retentionFloorSequence: 0,
      highWatermarkSequence: 3,
    },
    hasMore: input.hasMore,
  };
}

function createWakeups() {
  let listener: (() => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    source: {
      subscribe: vi.fn((next: () => void) => {
        listener = next;
        return unsubscribe;
      }),
    },
    unsubscribe,
    notify: () => listener?.(),
  };
}

describe('HostedCoordinationEventStreamController', () => {
  it('delivers a workspace lifecycle event only for its authorized workspace scope', async () => {
    const publicWorkspaceId = 'workspace_11111111111111111111111111111111';
    const foreignWorkspaceId = 'workspace_22222222222222222222222222222222';
    const lifecycleEvent = (sequence: number, scopeId: string): CoordinationEventEnvelope => ({
      ...event({ sequence }),
      scope: { kind: 'workspace', scopeId },
      workspaceId: scopeId,
      eventType: 'team-lifecycle.lane-status-observed',
      payload: { kind: 'invalidate', resource: 'team_lifecycle' },
    });
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: vi.fn(async () =>
          batch({
            from: 'cursor-0',
            next: 'cursor-2',
            events: [lifecycleEvent(1, foreignWorkspaceId), lifecycleEvent(2, publicWorkspaceId)],
            hasMore: false,
          })
        ),
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: async () => ({
          isCurrent: () => true,
          projectEvent: (committed: CoordinationEventEnvelope) =>
            committed.workspaceId === publicWorkspaceId
              ? {
                  scope: committed.scope,
                  eventType: committed.eventType,
                  publicPayload: {
                    kind: 'invalidate' as const,
                    resource: 'team_lifecycle' as const,
                  },
                }
              : null,
        }),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
    const reply = createReply();
    reply.raw.onWrite = (frame) => {
      if (frame.startsWith('id: ')) (request.raw as unknown as EventEmitter).emit('aborted');
    };
    await registerHandler(controller)(request, reply.reply);
    const frames = reply.raw.frames.filter((frame) => frame.startsWith('id: '));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('id: cursor-2');
    expect(frames[0]).toContain(
      '"scope":{"kind":"workspace","scopeId":"workspace_11111111111111111111111111111111"}'
    );
    expect(frames[0]).not.toContain(foreignWorkspaceId);
    controller.close();
  });
  it('keeps admission closed from drain through successor adoption', async () => {
    const pending = deferred<CoordinationReplayBatch>();
    const entered = deferred<void>();
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay: () => { entered.resolve(); return pending.promise; } },
      authorizer: { allowedOrigin: 'https://host.test', authorize: async () => ({
        isCurrent: () => true,
        projectEvent: (committed: CoordinationEventEnvelope) => ({
          scope: committed.scope, eventType: committed.eventType, publicPayload: {},
        }),
      }) },
      wakeups: createWakeups().source, streamIdentityFactory, scheduler: new ManualScheduler(),
    });
    const handler = registerHandler(controller), old = createReply();
    const serving = handler(createRequest({ origin: 'https://host.test', after: 'cursor-0' }), old.reply);
    await entered.promise;
    const gap = deferred<void>(), release = deferred<void>();
    let releaseAdmission!: () => void;
    const draining = controller.runWithStreamsDrained(async (retainAdmission) => {
      releaseAdmission = retainAdmission();
      gap.resolve();
      await release.promise;
    });
    await gap.promise;
    const rejected = createReply();
    await handler(createRequest({ origin: 'https://host.test', after: 'cursor-0' }), rejected.reply);
    expect(rejected.statusCode).toBe(503);
    release.resolve();
    await draining;
    const retained = createReply();
    await handler(createRequest({ origin: 'https://host.test', after: 'cursor-0' }), retained.reply);
    expect(retained.statusCode).toBe(503);
    releaseAdmission();
    const adopted = createReply();
    await handler(createRequest({ origin: 'https://host.test' }), adopted.reply);
    expect(adopted.raw.headers.at(0)?.status).toBe(200);
    pending.resolve(batch({ from: 'cursor-0', next: 'cursor-1', events: [event({ sequence: 1 })], hasMore: false }));
    await serving;
    expect(old.raw.frames).toEqual([]);
    controller.close();
  });

  it('fails closed without a raw write after the installed product emitter is cleared', async () => {
    const provenance: HostedProducerProvenance = {
      role: 'product-producer',
      controllerNonce: 'c'.repeat(64),
      runId: 'd'.repeat(64),
      emit: vi.fn(),
      bindInvalidation: vi.fn(),
      poison: vi.fn((reason: string) => {
        throw new Error(reason);
      }),
      close: vi.fn(),
    };
    const emitter = vi.fn(() => true);
    installProductHostedProducerProvenance(provenance, emitter);
    clearProductHostedProducerProvenance(provenance);

    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: vi.fn(async () =>
          batch({
            from: 'cursor-0',
            next: 'cursor-1',
            events: [event({ sequence: 1 })],
            hasMore: false,
          })
        ),
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: vi.fn(async (committed: CoordinationEventEnvelope) => ({
            scope: committed.scope,
            eventType: committed.eventType,
            publicPayload: { publicValue: committed.eventSequence },
          })),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();

    await registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );

    expect(reply.raw.frames).toEqual([]);
    expect(emitter).not.toHaveBeenCalled();
    expect(reply.raw.writableEnded).toBe(true);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('flushes an authorized empty stream before the first event or heartbeat', async () => {
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: vi.fn(
          async <TPayload extends CoordinationJsonValue>() =>
            batch({
              from: 'cursor-0',
              next: 'cursor-0',
              events: [],
              hasMore: false,
            }) as CoordinationReplayBatch<TPayload>
        ),
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: vi.fn(),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const request = createRequest({
      accept: 'text/event-stream',
      secFetchDest: 'empty',
      secFetchMode: 'cors',
      secFetchSite: 'same-origin',
      after: 'cursor-0',
    });
    const reply = createReply();
    const handling = registerHandler(controller)(request, reply.reply);

    await vi.waitFor(() => expect(reply.raw.flushes).toBe(1));
    expect(reply.raw.headers).toHaveLength(1);
    expect(reply.raw.frames).toEqual([]);

    (request.raw as unknown as EventEmitter).emit('aborted');
    await handling;
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('closes an empty stream without a heartbeat after its live authorization is revoked', async () => {
    const scheduler = new ManualScheduler();
    const wakeups = createWakeups();
    let current = true;
    const isCurrent = vi.fn(async () => current);
    const replay = vi.fn(
      async <TPayload extends CoordinationJsonValue>() =>
        batch({
          from: 'cursor-0',
          next: 'cursor-0',
          events: [],
          hasMore: false,
        }) as CoordinationReplayBatch<TPayload>
    );
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({ isCurrent, projectEvent: vi.fn() })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler,
      heartbeatIntervalMs: 10,
    });
    const reply = createReply();
    const handling = registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );
    await vi.waitFor(() => expect(reply.raw.flushes).toBe(1));
    await vi.waitFor(() => expect(scheduler.pending.some((task) => task.active)).toBe(true));

    current = false;
    scheduler.runNext();
    await handling;

    expect(replay).toHaveBeenCalledTimes(1);
    expect(isCurrent).toHaveBeenCalledTimes(4);
    expect(reply.raw.frames).toEqual([]);
    expect(reply.raw.writableEnded).toBe(true);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rechecks authorization after replay and never opens a stream revoked during replay', async () => {
    const pendingReplay = deferred<CoordinationReplayBatch>();
    const wakeups = createWakeups();
    let current = true;
    const isCurrent = vi.fn(async () => current);
    const replay = vi.fn(() => pendingReplay.promise);
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({ isCurrent, projectEvent: vi.fn() })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();
    const handling = registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));

    current = false;
    pendingReplay.resolve(
      batch({ from: 'cursor-0', next: 'cursor-0', events: [], hasMore: false })
    );
    await handling;

    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.frames).toEqual([]);
    expect(reply.raw.writableEnded).toBe(true);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rechecks authorization after projection and suppresses a concurrently revoked event', async () => {
    const wakeups = createWakeups();
    let current = true;
    const isCurrent = vi.fn(async () => current);
    const projectEvent = vi.fn(async (committed: CoordinationEventEnvelope) => {
      current = false;
      return {
        scope: committed.scope,
        eventType: committed.eventType,
        publicPayload: { publicValue: committed.eventSequence },
      };
    });
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: async <TPayload extends CoordinationJsonValue>() =>
          batch({
            from: 'cursor-0',
            next: 'cursor-1',
            events: [event({ sequence: 1 })],
            hasMore: false,
          }) as CoordinationReplayBatch<TPayload>,
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({ isCurrent, projectEvent })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();

    await registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );

    expect(projectEvent).toHaveBeenCalledOnce();
    expect(reply.raw.frames).toEqual([]);
    expect(reply.raw.writableEnded).toBe(true);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects Origin and session failures before SSE headers or durable replay', async () => {
    const replay = vi.fn();
    const authorize = vi.fn(async () => null);
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: { allowedOrigin: 'https://host.test', authorize },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const handler = registerHandler(controller);

    const foreignReply = createReply();
    await handler(
      createRequest({ origin: 'https://foreign.test', after: 'cursor-0' }),
      foreignReply.reply
    );
    expect(foreignReply.statusCode).toBe(403);
    expect(foreignReply.raw.headers).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();

    const anonymousReply = createReply();
    await handler(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      anonymousReply.reply
    );
    expect(anonymousReply.statusCode).toBe(401);
    expect(anonymousReply.raw.headers).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
    expect(wakeups.source.subscribe).not.toHaveBeenCalled();
  });

  it('does not attempt a duplicate Fastify response after headers were already committed', async () => {
    const observations: unknown[] = [];
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay: vi.fn() },
      authorizer: { allowedOrigin: 'https://host.test', authorize: vi.fn() },
      wakeups: createWakeups().source,
      streamIdentityFactory: { createStreamId: () => 'stream_duplicate-response' },
      scheduler: new ManualScheduler(),
      diagnosticObserver: (observation: HostedCoordinationEventStreamWriteObservation) =>
        observations.push(observation),
    });
    const reply = createReply();
    reply.raw.headersSent = true;

    await registerHandler(controller)(
      createRequest({ origin: 'https://foreign.test', after: 'cursor-0' }),
      reply.reply
    );

    expect(reply.body).toBeUndefined();
    expect(observations).toEqual([
      expect.objectContaining({
        kind: 'response_lifecycle',
        streamId: 'preauth_origin_invalid',
        writer: 'fastify_json',
        disposition: 'attempted',
        headersSent: true,
      }),
      expect.objectContaining({
        kind: 'response_lifecycle',
        streamId: 'preauth_origin_invalid',
        writer: 'fastify_json',
        disposition: 'skipped_closed',
        headersSent: true,
      }),
    ]);
  });

  it('bounds rejected-origin diagnostic volume and cardinality without allocating stream IDs', async () => {
    const observations: Array<{ readonly streamId: string }> = [];
    const createStreamId = vi.fn(() => 'attacker-controlled-cardinality');
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay: vi.fn() },
      authorizer: { allowedOrigin: 'https://host.test', authorize: vi.fn() },
      wakeups: createWakeups().source,
      streamIdentityFactory: { createStreamId },
      scheduler: new ManualScheduler(),
      diagnosticObserver: (observation: HostedCoordinationEventStreamWriteObservation) =>
        observations.push(observation),
    });
    const handler = registerHandler(controller);

    for (let request = 0; request < 100; request += 1) {
      const reply = createReply();
      await handler(createRequest({ origin: `https://attacker-${request}.test` }), reply.reply);
      expect(reply.statusCode).toBe(403);
    }

    expect(observations).toHaveLength(2);
    expect(new Set(observations.map(({ streamId }) => streamId))).toEqual(
      new Set(['preauth_origin_invalid'])
    );
    expect(createStreamId).not.toHaveBeenCalled();
  });

  it('bounds same-origin unauthenticated diagnostics without allocating stream IDs', async () => {
    const observations: Array<{ readonly streamId: string }> = [];
    const createStreamId = vi.fn(() => 'attacker-controlled-cardinality');
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay: vi.fn() },
      authorizer: { allowedOrigin: 'https://host.test', authorize: vi.fn(async () => null) },
      wakeups: createWakeups().source,
      streamIdentityFactory: { createStreamId },
      scheduler: new ManualScheduler(),
      diagnosticObserver: (observation: HostedCoordinationEventStreamWriteObservation) =>
        observations.push(observation),
    });
    const handler = registerHandler(controller);

    for (let request = 0; request < 100; request += 1) {
      const reply = createReply();
      await handler(createRequest({ origin: 'https://host.test' }), reply.reply);
      expect(reply.statusCode).toBe(401);
      expect(reply.body).toEqual({ error: 'authentication_required' });
    }

    expect(observations).toHaveLength(2);
    expect(new Set(observations.map(({ streamId }) => streamId))).toEqual(
      new Set(['preauth_authentication_required'])
    );
    expect(createStreamId).not.toHaveBeenCalled();
  });

  it('bounds same-origin draining diagnostics without allocating stream IDs', async () => {
    const observations: Array<{ readonly streamId: string }> = [];
    const createStreamId = vi.fn(() => 'attacker-controlled-cardinality');
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay: vi.fn() },
      authorizer: { allowedOrigin: 'https://host.test', authorize: vi.fn() },
      wakeups: createWakeups().source,
      streamIdentityFactory: { createStreamId },
      scheduler: new ManualScheduler(),
      diagnosticObserver: (observation: HostedCoordinationEventStreamWriteObservation) =>
        observations.push(observation),
    });
    const releaseDrain = deferred<void>();
    const draining = controller.runWithStreamsDrained(() => releaseDrain.promise);
    const handler = registerHandler(controller);

    for (let request = 0; request < 100; request += 1) {
      const reply = createReply();
      await handler(createRequest({ origin: 'https://host.test' }), reply.reply);
      expect(reply.statusCode).toBe(503);
      expect(reply.body).toEqual({ error: 'event_stream_closed' });
    }

    expect(observations).toHaveLength(2);
    expect(new Set(observations.map(({ streamId }) => streamId))).toEqual(
      new Set(['preauth_event_stream_closed'])
    );
    expect(createStreamId).not.toHaveBeenCalled();

    releaseDrain.resolve();
    await draining;
  });

  it.each(['writeHead', 'flushHeaders'] as const)(
    'propagates and fully cleans up a live-transport %s failure after Fastify hijack',
    async (failurePoint) => {
      const wakeups = createWakeups();
      const controller = new HostedCoordinationEventStreamController({
        replay: {
          replay: vi.fn(async () =>
            batch({ from: '', next: '', events: [], hasMore: false })
          ),
        },
        authorizer: {
          allowedOrigin: 'https://host.test',
          authorize: vi.fn(async () => ({ isCurrent: vi.fn(() => true), projectEvent: vi.fn() })),
        },
        wakeups: wakeups.source,
        streamIdentityFactory,
        scheduler: new ManualScheduler(),
      });
      const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
      const reply = createReply();
      const failure = new Error(`${failurePoint}_failed`);
      if (failurePoint === 'writeHead') reply.raw.writeHeadError = failure;
      else reply.raw.flushHeadersError = failure;

      await expect(
        registerHandler(controller)(request, reply.reply)
      ).rejects.toBe(failure);
      expect(reply.sent).toBe(true);
      expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
      expect((request.raw as unknown as EventEmitter).listenerCount('aborted')).toBe(0);
      expect((request.raw.socket as unknown as EventEmitter).listenerCount('close')).toBe(0);
      expect(reply.raw.listenerCount('close')).toBe(0);
      expect(reply.raw.listenerCount('error')).toBe(0);
      expect(
        (controller as unknown as { readonly activeStreams: ReadonlySet<unknown> }).activeStreams
          .size
      ).toBe(0);
      expect(reply.raw.destroyed || reply.raw.writableEnded).toBe(true);
      expect(reply.raw.writableEnded).toBe(true);
    }
  );

  it('suppresses an SSE header failure only when the transport closes during the write', async () => {
    const observations: Array<{ readonly kind: string; readonly disposition?: string }> = [];
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay: vi.fn() },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({ isCurrent: vi.fn(() => true), projectEvent: vi.fn() })),
      },
      wakeups: createWakeups().source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
      diagnosticObserver: (observation: HostedCoordinationEventStreamWriteObservation) =>
        observations.push(observation),
    });
    const reply = createReply();
    reply.raw.onFlushHeaders = () => {
      reply.raw.destroyed = true;
    };
    reply.raw.flushHeadersError = new Error('closed_during_flush');

    await expect(
      registerHandler(controller)(
        createRequest({ origin: 'https://host.test' }),
        reply.reply
      )
    ).resolves.toBeUndefined();
    expect(reply.raw.headers).toHaveLength(1);
    expect(reply.raw.frames).toEqual([]);
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: 'response_lifecycle', disposition: 'failed_closed' })
    );
  });

  it('does not write SSE headers or frames when shutdown closes deferred authorization', async () => {
    const pendingAuthorization = deferred<{
      readonly isCurrent: ReturnType<typeof vi.fn>;
      readonly projectEvent: ReturnType<typeof vi.fn>;
    } | null>();
    const replay = vi.fn();
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(() => pendingAuthorization.promise),
      },
      wakeups: createWakeups().source,
      streamIdentityFactory: { createStreamId: () => 'stream_shutdown-race' },
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();
    const handling = registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );
    await Promise.resolve();

    controller.close();
    await handling;

    expect(reply.raw.destroyed).toBe(true);
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.frames).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
  });

  it('captures abort before deferred authorization and leaves no replay or stream behind', async () => {
    const pendingAuthorization = deferred<{
      readonly isCurrent: ReturnType<typeof vi.fn>;
      readonly projectEvent: ReturnType<typeof vi.fn>;
    } | null>();
    const replay = vi.fn();
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(() => pendingAuthorization.promise),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
    const reply = createReply();
    const handling = registerHandler(controller)(request, reply.reply);
    await Promise.resolve();

    (request.raw as unknown as EventEmitter).emit('aborted');
    await handling;

    expect(wakeups.source.subscribe).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.frames).toEqual([]);
    expect(reply.raw.writableEnded).toBe(false);
    expect((request.raw as unknown as EventEmitter).listenerCount('aborted')).toBe(0);
    expect((request.raw.socket as unknown as EventEmitter).listenerCount('close')).toBe(0);

    pendingAuthorization.resolve({
      isCurrent: vi.fn(async () => true),
      projectEvent: vi.fn(),
    });
    await Promise.resolve();
    controller.close();
    expect(wakeups.source.subscribe).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('rejects cross-site or incomplete Origin-less EventSource metadata before authorization', async () => {
    const replay = vi.fn();
    const authorize = vi.fn(async () => ({
      isCurrent: vi.fn(async () => true),
      projectEvent: vi.fn(),
    }));
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: { allowedOrigin: 'https://host.test', authorize },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const handler = registerHandler(controller);
    const nativeHeaders = {
      accept: 'text/event-stream',
      secFetchDest: 'empty',
      secFetchMode: 'cors',
      secFetchSite: 'same-origin',
      after: 'cursor-0',
    } as const;

    for (const request of [
      createRequest({ ...nativeHeaders, origin: 'https://foreign.test' }),
      createRequest({ ...nativeHeaders, secFetchSite: 'cross-site' }),
      createRequest({ ...nativeHeaders, referer: 'https://foreign.test/app' }),
      createRequest({ ...nativeHeaders, accept: 'text/html' }),
      createRequest({ ...nativeHeaders, secFetchDest: 'document' }),
      createRequest({ ...nativeHeaders, secFetchMode: undefined }),
    ]) {
      const reply = createReply();
      await handler(request, reply.reply);
      expect(reply.statusCode).toBe(403);
      expect(reply.body).toEqual({ error: 'origin_invalid' });
      expect(reply.raw.headers).toEqual([]);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not subscribe when raw request state is destroyed during authorization', async () => {
    const replay = vi.fn();
    const wakeups = createWakeups();
    const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => {
          (request.raw as unknown as { destroyed: boolean }).destroyed = true;
          (request.raw.socket as unknown as { destroyed: boolean }).destroyed = true;
          return { isCurrent: vi.fn(async () => true), projectEvent: vi.fn() };
        }),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();

    await registerHandler(controller)(request, reply.reply);

    expect(wakeups.source.subscribe).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.frames).toEqual([]);
  });

  it('does not invoke replay when abort lands synchronously inside subscription', async () => {
    const replay = vi.fn();
    const wakeups = createWakeups();
    const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
    wakeups.source.subscribe.mockImplementation(() => {
      (request.raw as unknown as EventEmitter).emit('aborted');
      return wakeups.unsubscribe;
    });
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: vi.fn(),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();

    await registerHandler(controller)(request, reply.reply);

    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.frames).toEqual([]);
  });

  it('lets Last-Event-ID win, listens before replay, catches up durably, and projects bounded envelopes', async () => {
    const provenanceEmit = vi.fn();
    const provenance: HostedProducerProvenance = {
      role: 'product-producer',
      controllerNonce: 'c'.repeat(64),
      runId: 'd'.repeat(64),
      emit: provenanceEmit,
      bindInvalidation: vi.fn(),
      poison: vi.fn((reason: string) => {
        throw new Error(reason);
      }),
      close: vi.fn(),
    };
    bindProductHostedProducerInstance(provenance, {
      deploymentId: 'deployment_sse',
      bootId: 'boot_sse',
      ownerAuthority: 'owner-authority_sse',
      ownerGeneration: 7,
      ownerSessionId: 'owner-session_sse',
    });
    installProductHostedProducerProvenance(
      provenance,
      createProductHostedProducerSseWriteEmitter(process.env)
    );
    const order: string[] = [];
    const wakeups = createWakeups();
    wakeups.source.subscribe.mockImplementation((listener: () => void) => {
      order.push('subscribe');
      return vi.fn(() => listener);
    });
    const replay = vi
      .fn()
      .mockImplementationOnce(async ({ cursor: replayCursor }) => {
        order.push(`replay:${replayCursor}`);
        return batch({
          from: 'cursor-0',
          next: 'cursor-1',
          events: [event({ sequence: 1 })],
          hasMore: true,
        });
      })
      .mockImplementationOnce(async ({ cursor: replayCursor }) => {
        order.push(`replay:${replayCursor}`);
        return batch({
          from: 'cursor-1',
          next: 'cursor-3',
          events: [event({ sequence: 2 }), event({ sequence: 3 })],
          hasMore: false,
        });
      });
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: async (committed: CoordinationEventEnvelope) =>
            committed.eventSequence === 2
              ? null
              : {
                  scope: committed.scope,
                  eventType: committed.eventType,
                  resourceRevision: committed.resourceRevision,
                  publicPayload: { publicValue: committed.eventSequence },
                },
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();
    const request = createRequest({
      origin: 'https://host.test',
      after: 'ignored-query-cursor',
      lastEventId: 'cursor-0',
    });
    reply.raw.onWrite = (_frame) => {
      if (reply.raw.frames.filter((candidate) => candidate.startsWith('id: ')).length === 2) {
        (request.raw as unknown as EventEmitter).emit('aborted');
      }
    };

    await registerHandler(controller)(request, reply.reply);
    clearProductHostedProducerProvenance(provenance);

    expect(order).toEqual(['subscribe', 'replay:cursor-0', 'replay:cursor-1']);
    const eventFrames = reply.raw.frames.filter((frame) => frame.startsWith('id: '));
    expect(eventFrames).toHaveLength(2);
    expect(provenanceEmit).toHaveBeenCalledTimes(2);
    expect(provenanceEmit.mock.calls).toEqual(
      eventFrames.map((frame) => [
        'productTimeline',
        {
          recordType: 'coordination-sse-write-succeeded',
          operationNonce: expect.stringMatching(/^[0-9a-f]{64}$/u),
          native: expect.objectContaining({
            eventId: expect.stringMatching(/^cursor-/u),
            eventType: 'coordination_event',
            frameBytes: Buffer.byteLength(frame),
            frameKind: 'coordination_event',
            frameSha256: createHash('sha256').update(frame).digest('hex'),
          }),
        },
      ])
    );
    expect(JSON.stringify(provenanceEmit.mock.calls)).not.toContain('private-owner');
    expect(eventFrames[0]).toContain('id: cursor-1\nevent: coordination_event\n');
    expect(eventFrames[1]).toContain('id: cursor-3\nevent: coordination_event\n');
    const envelopes = eventFrames.map((frame) =>
      JSON.parse(frame.match(/data: (.*)\n\n$/)?.[1] ?? 'null')
    );
    expect(envelopes[0]).toMatchObject({
      previousEventCursor: 'cursor-0',
      eventCursor: 'cursor-1',
      payload: { publicValue: 1 },
    });
    expect(envelopes[1]).toMatchObject({
      previousEventCursor: 'cursor-1',
      eventCursor: 'cursor-3',
      payload: { publicValue: 3 },
    });
    expect(envelopes[0]).not.toHaveProperty('actor');
    expect(envelopes[0]).not.toHaveProperty('workspaceId');
    expect(envelopes[0]).not.toHaveProperty('teamId');
    expect(JSON.stringify(envelopes)).not.toContain('/Users/private-owner');
    expect(JSON.stringify(envelopes)).not.toContain('rm --private-body');
    expect(JSON.stringify(envelopes)).not.toContain('private-provider');
    expect(JSON.stringify(envelopes)).not.toContain('secret-token');
    expect(reply.raw.headers[0]).toMatchObject({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  });

  it('aborts and unsubscribes while the first durable replay is deferred', async () => {
    const pendingReplay = deferred<CoordinationReplayBatch>();
    const wakeups = createWakeups();
    const replay = vi.fn(async <TPayload extends CoordinationJsonValue>() =>
      pendingReplay.promise.then((result) => result as CoordinationReplayBatch<TPayload>)
    );
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: vi.fn(),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
    const reply = createReply();
    const handling = registerHandler(controller)(request, reply.reply);
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));

    (request.raw as unknown as EventEmitter).emit('aborted');
    await handling;

    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.writableEnded).toBe(true);
    expect((request.raw as unknown as EventEmitter).listenerCount('aborted')).toBe(0);
    pendingReplay.resolve(
      batch({ from: 'cursor-0', next: 'cursor-0', events: [], hasMore: false })
    );
    await Promise.resolve();
    expect(reply.raw.headers).toEqual([]);
  });

  it('controller close aborts and unsubscribes while the first replay is deferred', async () => {
    const pendingReplay = deferred<CoordinationReplayBatch>();
    const wakeups = createWakeups();
    const replay = vi.fn(async <TPayload extends CoordinationJsonValue>() =>
      pendingReplay.promise.then((result) => result as CoordinationReplayBatch<TPayload>)
    );
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: vi.fn(),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();
    const handling = registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));

    controller.close();
    controller.close();
    await handling;

    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.headers).toEqual([]);
    expect(reply.raw.writableEnded).toBe(true);
    pendingReplay.resolve(
      batch({ from: 'cursor-0', next: 'cursor-0', events: [], hasMore: false })
    );
    await Promise.resolve();
    expect(reply.raw.headers).toEqual([]);
  });

  it('re-queries immediately when a wake lands across the first replay watermark boundary', async () => {
    const firstReplay = deferred<CoordinationReplayBatch>();
    const wakeups = createWakeups();
    const replay = vi
      .fn()
      .mockImplementationOnce(() => firstReplay.promise)
      .mockImplementationOnce(async () =>
        batch({
          from: 'cursor-0',
          next: 'cursor-1',
          events: [event({ sequence: 1 })],
          hasMore: false,
        })
      );
    const controller = new HostedCoordinationEventStreamController({
      replay: { replay },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: (committed: CoordinationEventEnvelope) => ({
            scope: committed.scope,
            eventType: committed.eventType,
            publicPayload: { publicValue: committed.eventSequence },
          }),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const request = createRequest({ origin: 'https://host.test', after: 'cursor-0' });
    const reply = createReply();
    reply.raw.onWrite = (frame) => {
      if (frame.startsWith('id: cursor-1')) {
        (request.raw as unknown as EventEmitter).emit('aborted');
      }
    };
    const handling = registerHandler(controller)(request, reply.reply);
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));

    wakeups.notify();
    firstReplay.resolve(batch({ from: 'cursor-0', next: 'cursor-0', events: [], hasMore: false }));
    await handling;

    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-0' });
    expect(reply.raw.frames.some((frame) => frame.startsWith('id: cursor-1'))).toBe(true);
  });

  it('rejects a projector that attempts to mutate the authorized event scope', async () => {
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: vi.fn(
          async <TPayload extends CoordinationJsonValue>() =>
            batch({
              from: 'cursor-0',
              next: 'cursor-1',
              events: [event({ sequence: 1 })],
              hasMore: false,
            }) as CoordinationReplayBatch<TPayload>
        ),
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: (committed: CoordinationEventEnvelope) => ({
            scope: { ...committed.scope, scopeId: 'team-foreign' },
            eventType: committed.eventType,
            publicPayload: { publicValue: committed.eventSequence },
          }),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();

    await registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );

    expect(reply.raw.frames.join('')).toContain('event: resync_required');
    expect(reply.raw.frames.join('')).toContain('"reason":"projection_invalid"');
    expect(reply.raw.frames.some((frame) => frame.startsWith('id: '))).toBe(false);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid_replay_cursor', 'malformed_cursor'],
    ['replay_cursor_deployment_mismatch', 'foreign_deployment'],
    ['replay_cursor_epoch_mismatch', 'foreign_epoch'],
    ['replay_cursor_stale', 'cursor_expired'],
    ['replay_cursor_ahead', 'cursor_ahead'],
    ['event_sequence_discontinuity', 'event_gap'],
  ] as const)('maps %s to a terminal typed %s frame', async (code, reason) => {
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: vi.fn(async () => {
          throw Object.assign(new Error(code), { code });
        }),
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: vi.fn(),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler: new ManualScheduler(),
    });
    const reply = createReply();

    await registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );

    expect(reply.raw.frames.join('')).toContain('event: resync_required');
    expect(reply.raw.frames.join('')).toContain(`"reason":"${reason}"`);
    expect(reply.raw.writableEnded).toBe(true);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('bounds a slow consumer, releases its wake listener, and closes idempotently', async () => {
    const scheduler = new ManualScheduler();
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: {
        replay: async <TPayload extends CoordinationJsonValue>() =>
          batch({
            from: 'cursor-0',
            next: 'cursor-1',
            events: [event({ sequence: 1 })],
            hasMore: false,
          }) as CoordinationReplayBatch<TPayload>,
      },
      authorizer: {
        allowedOrigin: 'https://host.test',
        authorize: vi.fn(async () => ({
          isCurrent: vi.fn(async () => true),
          projectEvent: async (committed: CoordinationEventEnvelope) => ({
            scope: committed.scope,
            eventType: committed.eventType,
            publicPayload: { publicValue: committed.eventSequence },
          }),
        })),
      },
      wakeups: wakeups.source,
      streamIdentityFactory,
      scheduler,
      slowConsumerTimeoutMs: 10,
    });
    const reply = createReply();
    reply.raw.writeResult = false;
    const handling = registerHandler(controller)(
      createRequest({ origin: 'https://host.test', after: 'cursor-0' }),
      reply.reply
    );
    await vi.waitFor(() => {
      expect(scheduler.pending.some((task) => task.active)).toBe(true);
    });
    scheduler.runNext();
    await handling;

    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reply.raw.destroyCalls).toBe(1);
    expect(reply.raw.destroyed).toBe(true);
    expect(reply.raw.writableEnded).toBe(false);
    controller.close();
    controller.close();
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

// Exercise the real adapter -> handoff -> SSE mapping, with the worker's exact
// transported stale outcome injected only after the valid watermark was read.
describe('SQLite retention race at the SSE boundary', () => {
  function fixture(initialHigh = 2) {
    let high = initialHigh;
    let floor = 0;
    let pruneOnRead = true;
    const metadata = () => ({ deploymentId: 'deployment-1', eventEpoch: 'epoch-1',
      highWatermarkSequence: high, retentionFloorSequence: floor });
    const position = (eventSequence: number) => encodeReplayCursor({ ...metadata(), eventSequence });
    const read = vi.fn(async (input: { afterSequence: number }) => {
      if (pruneOnRead) floor = 1;
      if (input.afterSequence < floor) throw new Error('coordination-event-journal-cursor-stale');
      const draft = {
        actor: { actorRef: 'test-operator', kind: 'operator' }, emittedAt: '2026-08-02T00:00:00.000Z',
        eventId: 'event-2', eventType: 'team-lifecycle.run-accepted', payload: {},
        schemaVersion: 1, scope: { kind: 'team', scopeId: 'team-1' }, teamId: 'team-1',
      };
      return { watermark: metadata(), rows: [{ deploymentId: 'deployment-1', eventEpoch: 'epoch-1',
        eventSequence: 2, eventId: 'event-2', bodyJson: JSON.stringify(draft) }] };
    });
    const storage = {
      coordinationEventInitialize: async () => metadata(),
      coordinationEventGetWatermark: vi.fn(async () => metadata()),
      coordinationEventRead: read,
    } as unknown as CoordinationDurabilityStorageGateway;
    const journal = new SqliteCoordinationEventJournal({ storage, deploymentId: 'deployment-1' });
    const handoff = new CoordinationEventHandoff({ journal,
      deadlineScheduler: { scheduleDeadline: () => () => undefined } });
    return { read, storage, journal, handoff, position,
      advance: () => { high = 2; },
      retain: () => { floor = 1; pruneOnRead = false; },
    };
  }

  it.each(['initial', 'established'] as const)('emits cursor_expired for %s replay when pruning overtakes row read', async (phase) => {
    const f = fixture(phase === 'initial' ? 2 : 0);
    const wakeups = createWakeups();
    const controller = new HostedCoordinationEventStreamController({
      replay: f.handoff, wakeups: wakeups.source, streamIdentityFactory,
      scheduler: new ManualScheduler(),
      authorizer: { allowedOrigin: 'https://host.test', authorize: async () => ({
        isCurrent: async () => true, projectEvent: async () => null,
      }) },
    });
    const reply = createReply();
    const handling = registerHandler(controller)(createRequest({ origin: 'https://host.test', after: f.position(0) }), reply.reply);
    if (phase === 'established') {
      await vi.waitFor(() => expect(reply.raw.flushes).toBe(1));
      expect(f.read).not.toHaveBeenCalled();
      f.advance();
      wakeups.notify();
    }
    await handling;
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 0, throughSequence: 2 }));
    expect(reply.statusCode).toBe(200);
    expect(reply.raw.frames.join('')).toContain('event: resync_required');
    expect(reply.raw.frames.join('')).toContain('"reason":"cursor_expired"');
    expect(reply.raw.frames.join('')).not.toContain('coordination-event-journal-cursor-stale');
    expect(reply.raw.writableEnded).toBe(true);
    expect(wakeups.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects delayed cursor zero after task 1 is pruned, but replays retained launch 2 from floor 1', async () => {
    const f = fixture();
    f.retain();
    await expect(f.handoff.replay({ cursor: f.position(0) })).rejects.toMatchObject({ code: 'replay_cursor_stale' });
    expect(f.read).not.toHaveBeenCalled();
    const replay = await f.handoff.replay({ cursor: f.position(1) });
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({ eventSequence: 2, eventType: 'team-lifecycle.run-accepted', eventCursor: f.position(2) });
    expect(replay.nextCursor).toBe(f.position(2));
  });

  it.each([new Error('database unavailable'), new Error('coordination-event-journal-cursor-stale:other'),
    { message: 'coordination-event-journal-cursor-stale' }])('preserves unrelated storage rejection identity %#', async (failure) => {
    const f = fixture();
    f.read.mockRejectedValueOnce(failure);
    await expect(f.journal.readCommittedEvents({ afterSequence: 0, throughSequence: 2, limit: 10 })).rejects.toBe(failure);
  });
});
