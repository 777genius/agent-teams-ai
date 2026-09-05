import { HostedCoordinationEventBootstrapController } from '../adapters/input/http/HostedCoordinationEventBootstrapController';
import { HostedCoordinationEventStreamController } from '../adapters/input/http/HostedCoordinationEventStreamController';
import { InProcessCoordinationEventWakeupHub } from '../infrastructure/InProcessCoordinationEventWakeupHub';

import { createCoordinationEventsFeature } from './createCoordinationEventsFeature';

import type { CoordinationEventEnvelope, CoordinationReplayBatch } from '../../contracts';
import type {
  CoordinationEventHandoff,
  ReplayCoordinationEventsInput,
} from '../../core/application';
import type {
  HostedCoordinationEventStreamAuthorizer,
  HostedCoordinationEventStreamIdentityFactory,
  HostedCoordinationEventStreamWriteObserver,
} from '../application/HostedCoordinationEventStreamPorts';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';
import type { TeamId } from '@shared/contracts/hosted';

const NODE_STREAM_SCHEDULER: HostedCoordinationEventStreamScheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void): () => void {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return () => clearTimeout(handle);
  },
});

const DEFAULT_RETENTION_POLICY = Object.freeze({
  intervalMs: 60_000,
  maxRetainedEvents: 10_000,
});

export interface HostedCoordinationEventStreamScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export type HostedCoordinationEventStorage = Pick<
  CoordinationDurabilityStorageGateway,
  | 'coordinationEventInitialize'
  | 'coordinationEventGetWatermark'
  | 'coordinationEventRead'
  | 'coordinationEventAppend'
  | 'coordinationEventPrune'
>;

export interface CreateHostedCoordinationEventStreamOptions {
  readonly storage: HostedCoordinationEventStorage;
  readonly deploymentId: string;
  readonly authorizer: HostedCoordinationEventStreamAuthorizer;
  readonly streamIdentityFactory: HostedCoordinationEventStreamIdentityFactory;
  readonly scheduler?: HostedCoordinationEventStreamScheduler;
  readonly replayBatchSize?: number;
  readonly heartbeatIntervalMs?: number;
  readonly slowConsumerTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  /**
   * Payload-free transport observations; observer failures are isolated from
   * stream correctness.
   */
  readonly diagnosticObserver?: HostedCoordinationEventStreamWriteObserver;
  readonly retentionScheduler?: HostedCoordinationEventStreamScheduler;
  readonly retentionPolicy?: {
    readonly intervalMs: number;
    readonly maxRetainedEvents: number;
  };
}

export interface HostedCoordinationEventStream {
  readonly handoff: CoordinationEventHandoff;
  /** Lossy latency hint after an atomic commit through the shared storage worker. */
  notifyDurableCommit(): Promise<void>;
  register(app: unknown): void;
  close(): void;
}

type PresentedCoordinationEvent = CoordinationEventEnvelope & {
  scope: { kind: CoordinationEventEnvelope['scope']['kind']; scopeId: string };
};

function presentationReplay(input: {
  readonly handoff: CoordinationEventHandoff;
  readonly sourceEvents: WeakMap<CoordinationEventEnvelope, CoordinationEventEnvelope>;
}) {
  return Object.freeze({
    replay: async (request: ReplayCoordinationEventsInput): Promise<CoordinationReplayBatch> => {
      const batch = await input.handoff.replay(request);
      return Object.freeze({
        ...batch,
        events: Object.freeze(
          batch.events.map((event) => {
            const presented: PresentedCoordinationEvent = {
              ...event,
              scope: { ...event.scope },
            };
            input.sourceEvents.set(presented, event);
            return presented;
          })
        ),
      });
    },
  });
}

function presentationAuthorizer(input: {
  readonly authorizer: HostedCoordinationEventStreamAuthorizer;
  readonly sourceEvents: WeakMap<CoordinationEventEnvelope, CoordinationEventEnvelope>;
}): HostedCoordinationEventStreamAuthorizer {
  return Object.freeze({
    allowedOrigin: input.authorizer.allowedOrigin,
    captureTeamBootstrapFence: (request: unknown, teamId: TeamId) =>
      input.authorizer.captureTeamBootstrapFence(request, teamId),
    authorize: async (request: unknown) => {
      const authorization = await input.authorizer.authorize(request);
      if (authorization === null) return null;
      return Object.freeze({
        isCurrent: () => authorization.isCurrent(),
        projectEvent: async (presented: CoordinationEventEnvelope) => {
          const source = input.sourceEvents.get(presented);
          if (source === undefined) return null;
          const projection = await authorization.projectEvent(source);
          if (projection === null) return null;
          const mutable = presented as PresentedCoordinationEvent;
          mutable.scope.kind = projection.scope.kind;
          mutable.scope.scopeId = projection.scope.scopeId;
          return projection;
        },
      });
    },
  });
}

export function createHostedCoordinationEventStream(
  options: CreateHostedCoordinationEventStreamOptions
): HostedCoordinationEventStream {
  const wakeupHub = new InProcessCoordinationEventWakeupHub();
  // The reusable feature currently names the broader coordination durability
  // port, but its event journal consumes exactly this five-operation gateway.
  const feature = createCoordinationEventsFeature({
    storage: options.storage as CoordinationDurabilityStorageGateway,
    deploymentId: options.deploymentId,
    wakeup: wakeupHub,
    retention: {
      policy: options.retentionPolicy ?? DEFAULT_RETENTION_POLICY,
      scheduler: options.retentionScheduler ?? NODE_STREAM_SCHEDULER,
    },
  });
  const { handoff } = feature;
  const sourceEvents = new WeakMap<CoordinationEventEnvelope, CoordinationEventEnvelope>();
  const controller = new HostedCoordinationEventStreamController({
    replay: presentationReplay({ handoff, sourceEvents }),
    authorizer: presentationAuthorizer({ authorizer: options.authorizer, sourceEvents }),
    wakeups: wakeupHub,
    scheduler: options.scheduler ?? NODE_STREAM_SCHEDULER,
    streamIdentityFactory: options.streamIdentityFactory,
    ...(options.replayBatchSize === undefined ? {} : { replayBatchSize: options.replayBatchSize }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.slowConsumerTimeoutMs === undefined
      ? {}
      : { slowConsumerTimeoutMs: options.slowConsumerTimeoutMs }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.diagnosticObserver === undefined
      ? {}
      : { diagnosticObserver: options.diagnosticObserver }),
  });
  const bootstrapController = new HostedCoordinationEventBootstrapController({
    handoff,
    authorizer: options.authorizer,
  });
  let closed = false;
  return Object.freeze({
    handoff,
    notifyDurableCommit: () => wakeupHub.notifyCommittedEvent({} as CoordinationEventEnvelope),
    register: (app: unknown) => {
      controller.register(app);
      bootstrapController.register(app);
    },
    close: () => {
      if (closed) return;
      closed = true;
      controller.close();
      bootstrapController.close();
      feature.close();
      wakeupHub.close();
    },
  });
}
