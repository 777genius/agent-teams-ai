import type { CoordinationEventHandoff } from '../../core/application';
import type {
  HostedCoordinationEventStreamAuthorizer,
  HostedCoordinationEventStreamIdentityFactory,
  HostedCoordinationEventStreamWriteObserver,
} from './HostedCoordinationEventStreamPorts';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

/** Releases one retained admission fence. A failed generation deliberately
 * leaves its fence retained so the route remains fail-closed. */
export type HostedCoordinationEventStreamAdmissionRelease = () => void;

/** Returns the release for the admission fence synchronously retained before
 * the drain waits for already-admitted writes and their evidence. */
export type RetainHostedCoordinationEventStreamAdmission = () =>
  HostedCoordinationEventStreamAdmissionRelease;

/** Scheduler port shared by hosted stream adapters and composition. */
export interface HostedCoordinationEventStreamScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

/** Narrow durable journal capability consumed by the hosted event stream. */
export type HostedCoordinationEventStorage = Pick<
  CoordinationDurabilityStorageGateway,
  | 'coordinationEventInitialize'
  | 'coordinationEventGetWatermark'
  | 'coordinationEventRead'
  | 'coordinationEventAppend'
  | 'coordinationEventPrune'
>;

/** Main-owned composition input; transport implementations remain private. */
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
  /** Payload-free transport observations; observer failures are isolated from
   * stream correctness. */
  readonly diagnosticObserver?: HostedCoordinationEventStreamWriteObserver;
  readonly retentionScheduler?: HostedCoordinationEventStreamScheduler;
  readonly retentionPolicy?: {
    readonly intervalMs: number;
    readonly maxRetainedEvents: number;
  };
}

/** Public hosted stream facade; HTTP adapters are intentionally not exposed. */
export interface HostedCoordinationEventStream {
  readonly handoff: CoordinationEventHandoff;
  /** Lossy latency hint after an atomic commit through the shared storage worker. */
  notifyDurableCommit(): Promise<void>;
  register(app: unknown): void;
  runWithStreamsDrained<T>(
    operation: (retainAdmission: RetainHostedCoordinationEventStreamAdmission) => Promise<T>
  ): Promise<T>;
  close(): void;
}
