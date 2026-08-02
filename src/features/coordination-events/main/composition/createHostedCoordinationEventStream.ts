import { HostedCoordinationEventStreamController } from '../adapters/input/http/HostedCoordinationEventStreamController';
import { InProcessCoordinationEventWakeupHub } from '../infrastructure/InProcessCoordinationEventWakeupHub';

import type {
  HostedCoordinationEventReplay,
  HostedCoordinationEventStreamAuthorizer,
  HostedCoordinationEventStreamScheduler,
} from '../adapters/input/http/HostedCoordinationEventStreamController';
import type { FastifyInstance } from 'fastify';

const NODE_STREAM_SCHEDULER: HostedCoordinationEventStreamScheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void): () => void {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return () => clearTimeout(handle);
  },
});

export type { HostedCoordinationEventStreamAuthorizer };

export interface CreateHostedCoordinationEventStreamOptions {
  readonly replay: HostedCoordinationEventReplay;
  readonly authorizer: HostedCoordinationEventStreamAuthorizer;
  /**
   * Supply this same hub as the CoordinationEventHandoff wake-up port. The
   * stream intentionally does not create or own the durable event feature.
   */
  readonly wakeupHub: InProcessCoordinationEventWakeupHub;
  readonly scheduler?: HostedCoordinationEventStreamScheduler;
  readonly replayBatchSize?: number;
  readonly heartbeatIntervalMs?: number;
  readonly slowConsumerTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}

export interface HostedCoordinationEventStream {
  register(app: FastifyInstance): void;
  close(): void;
}

export function createHostedCoordinationEventStream(
  options: CreateHostedCoordinationEventStreamOptions
): HostedCoordinationEventStream {
  const controller = new HostedCoordinationEventStreamController({
    replay: options.replay,
    authorizer: options.authorizer,
    wakeups: options.wakeupHub,
    scheduler: options.scheduler ?? NODE_STREAM_SCHEDULER,
    ...(options.replayBatchSize === undefined ? {} : { replayBatchSize: options.replayBatchSize }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.slowConsumerTimeoutMs === undefined
      ? {}
      : { slowConsumerTimeoutMs: options.slowConsumerTimeoutMs }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });
  let closed = false;
  return Object.freeze({
    register: (app: FastifyInstance) => controller.register(app),
    close: () => {
      if (closed) return;
      closed = true;
      controller.close();
    },
  });
}
