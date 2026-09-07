import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import { encodeReplayCursor } from '@features/coordination-events/core/domain';
import { createHostedCoordinationEventStream } from '@features/coordination-events/main/hosted';

/** Real production registry and Node backpressure; only durable storage and auth are fixtures. */
export function generationCoordinationStream() {
  const metadata = { deploymentId: 'deployment-1', eventEpoch: 'epoch-1',
    highWatermarkSequence: 0, retentionFloorSequence: 0 };
  let heartbeat!: () => void;
  let releaseWrite!: () => void;
  let backpressure!: () => void;
  const blocked = new Promise<void>(resolve => { backpressure = resolve; });
  const stream = createHostedCoordinationEventStream({
    deploymentId: metadata.deploymentId,
    storage: {
      coordinationEventInitialize: async () => metadata,
      coordinationEventGetWatermark: async () => metadata,
      coordinationEventRead: async () => ({ watermark: metadata, rows: [] }),
      coordinationEventAppend: async () => { throw new Error('unused append'); },
      coordinationEventPrune: async () => { throw new Error('unused prune'); },
    },
    authorizer: { allowedOrigin: 'https://hosted.example',
      authorize: async () => ({ isCurrent: () => true, projectEvent: () => null }),
      captureTeamBootstrapFence: async () => null },
    streamIdentityFactory: { createStreamId: () => 'generation-stream' },
    scheduler: { schedule: (delay, callback) => {
      if (delay === 1_000) heartbeat = callback;
      return () => {};
    } },
    heartbeatIntervalMs: 1_000,
    retentionScheduler: { schedule: () => () => {} },
    diagnosticObserver: observation => {
      if (observation.kind === 'backpressure_entered') backpressure();
    },
  });
  type Handler = (request: unknown, reply: unknown) => Promise<void>;
  let handler!: Handler;
  const registered = new Map<string, Handler>();
  stream.register({
    get: (route: string, callback: Handler) => {
      registered.set('GET ' + route, callback);
      if (route === '/api/hosted/v1/events') handler = callback;
    },
    post: (route: string, callback: Handler) => {
      registered.set('POST ' + route, callback);
    },
  });
  const request = () => ({ headers: { origin: 'https://hosted.example', accept: 'text/event-stream' },
    query: { after: encodeReplayCursor({ ...metadata, eventSequence: 0 }) }, raw: Object.assign(new EventEmitter(), {
      aborted: false, destroyed: false, socket: Object.assign(new EventEmitter(), { destroyed: false }),
    }) });
  const raw = Object.assign(new Writable({ highWaterMark: 1,
    write(_chunk, _encoding, callback) { releaseWrite = () => callback(); } }), {
    writeHead() {}, flushHeaders() {},
  });
  const reply = { raw, hijack() {}, code() { return this; }, send() {} };
  return { stream, blocked, raw,
    open: () => handler(request(), reply),
    heartbeat: () => heartbeat(), releaseWrite: () => releaseWrite(),
    gapRequest: async () => {
      let status = 200;
      await handler(request(), { ...reply, code(value: number) { status = value; return this; } });
      return status;
    },
  };
}
