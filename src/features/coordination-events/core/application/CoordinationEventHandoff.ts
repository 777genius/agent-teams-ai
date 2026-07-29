import {
  type CoordinationEventEnvelope,
  type CoordinationJsonValue,
  type CoordinationReplayBatch,
  type CoordinationSnapshotEnvelope,
  type EventJournalWatermark,
} from '../../contracts';
import {
  assertCommittedEventMatchesDraft,
  assertCoordinationEventDraft,
  assertCoordinationEventRecoveryPoint,
  assertCoordinationSnapshotMetadata,
  assertJournalWatermark,
  assertJournalWatermarkProgression,
  createCoordinationReplayBatch,
  createCoordinationSnapshotMetadata,
  decodeReplayCursor,
  materializeCoordinationSnapshotData,
  materializeEventJournalWatermark,
  validateReplayCursor,
} from '../domain';

import { CoordinationEventHandoffError } from './coordinationEventHandoffError';
import {
  assertBoundedPositiveInteger,
  assertIdentifier,
  assertRecoveryIdentifier,
  assertSameJournalIdentity,
  assertSnapshotLeaseDeadline,
  assertSnapshotRequest,
  bindTrustedEventAttribution,
  encodePosition,
  freezeRecoveryStage,
  invalidOptions,
  journalProtocolError,
  materializeCommittedEventAppend,
  materializeJournalReplayRead,
  recoveryProtocolError,
  sameRecoveryPoint,
  sameRecoveryStage,
} from './coordinationEventHandoffSupport';

import type {
  CoordinationEventJournal,
  CoordinationEventRecoveryPointParticipant,
  CoordinationEventRecoveryPointStage,
  CoordinationEventWakeup,
  CoordinationSnapshotRequest,
  ExternalCoordinationSnapshotSource,
  PublishCoordinationEventCommand,
  SameTransactionCoordinationSnapshotSource,
  SnapshotRetentionLease,
  SnapshotRetentionLeaseCoordinator,
  SnapshotRetentionLeaseReleaseContext,
  VerifiedCoordinationEventRecoveryPoint,
} from './ports';

const DEFAULT_MAX_REPLAY_EVENTS = 500;
const DEFAULT_REPLAY_BATCH_SIZE = 100;
const DEFAULT_SNAPSHOT_LEASE_TTL_MS = 15_000;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_SNAPSHOT_LEASE_TTL_MS = 60_000;

export {
  CoordinationEventHandoffError,
  type CoordinationEventHandoffErrorCode,
} from './coordinationEventHandoffError';

export interface CoordinationEventHandoffOptions {
  readonly journal: CoordinationEventJournal;
  readonly retentionLeases: SnapshotRetentionLeaseCoordinator;
  readonly wakeup?: CoordinationEventWakeup;
  readonly defaultMaxReplayEvents?: number;
  readonly replayBatchSize?: number;
  readonly snapshotLeaseTtlMs?: number;
}

export interface ReplayCoordinationEventsInput {
  readonly cursor: string;
  readonly maxEvents?: number;
}

export interface PublishCommittedCoordinationEventResult<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly event: CoordinationEventEnvelope<TPayload>;
  readonly liveWakeup: 'not_configured' | 'delivered' | 'failed';
}

type SnapshotDeadlinePhase = 'acquisition' | 'lease_callback' | 'read' | 'delivery';

function settleSnapshotPhaseBeforeDeadline<T>(input: {
  readonly operation: Promise<T>;
  readonly deadlineAtMs: number;
  readonly abortController: AbortController;
  readonly phase: SnapshotDeadlinePhase | (() => SnapshotDeadlinePhase);
  readonly leaseId?: string;
}): Promise<T> {
  const remainingMs = input.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    input.abortController.abort();
    return Promise.reject(snapshotDeadlineError(input));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      input.abortController.abort();
      reject(snapshotDeadlineError(input));
    }, remainingMs);

    input.operation.then(
      (value) => {
        if (settled) {
          return;
        }
        if (input.abortController.signal.aborted || Date.now() >= input.deadlineAtMs) {
          settled = true;
          clearTimeout(deadline);
          input.abortController.abort();
          reject(snapshotDeadlineError(input));
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        if (input.abortController.signal.aborted || Date.now() >= input.deadlineAtMs) {
          settled = true;
          clearTimeout(deadline);
          input.abortController.abort();
          reject(snapshotDeadlineError(input));
          return;
        }
        settled = true;
        clearTimeout(deadline);
        reject(error);
      }
    );
  });
}

function snapshotDeadlineError(input: {
  readonly phase: SnapshotDeadlinePhase | (() => SnapshotDeadlinePhase);
  readonly deadlineAtMs: number;
  readonly leaseId?: string;
}): CoordinationEventHandoffError {
  const phaseDescription: Record<SnapshotDeadlinePhase, string> = {
    acquisition: 'retention lease acquisition',
    lease_callback: 'retention lease callback',
    read: 'source observation',
    delivery: 'snapshot delivery',
  };
  const phase = typeof input.phase === 'function' ? input.phase() : input.phase;
  return new CoordinationEventHandoffError(
    'snapshot_retry',
    `External snapshot ${phaseDescription[phase]} exceeded its deadline`,
    {
      phase,
      deadlineAtMs: input.deadlineAtMs,
      ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
    }
  );
}

function isSnapshotDeadlineError(
  error: unknown,
  phase: SnapshotDeadlinePhase
): error is CoordinationEventHandoffError {
  return (
    error instanceof CoordinationEventHandoffError &&
    error.code === 'snapshot_retry' &&
    error.details.phase === phase
  );
}

function releaseLateSnapshotLease(
  acquisition: Promise<SnapshotRetentionLease>,
  deadlineAtMs: number,
  retentionLeases: SnapshotRetentionLeaseCoordinator
): void {
  void acquisition
    .then(async (lateLease) => {
      if (typeof lateLease?.leaseId === 'string' && lateLease.leaseId.length > 0) {
        await releaseSnapshotLeaseBeforeDeadline({
          leaseId: lateLease.leaseId,
          deadlineAtMs,
          retentionLeases,
        });
      }
    })
    .catch(() => undefined);
}

function releaseSnapshotLeaseBeforeDeadline(input: {
  readonly leaseId: string;
  readonly deadlineAtMs: number;
  readonly retentionLeases: SnapshotRetentionLeaseCoordinator;
}): Promise<void> {
  const abortController = new AbortController();
  const context: SnapshotRetentionLeaseReleaseContext = Object.freeze({
    signal: abortController.signal,
    deadlineAtMs: input.deadlineAtMs,
  });
  const operation = (async (): Promise<void> =>
    input.retentionLeases.releaseSnapshotLease(input.leaseId, context))();

  const remainingMs = input.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    abortController.abort();
    void operation.catch(() => undefined);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      abortController.abort();
      resolve();
    }, remainingMs);

    operation.then(
      () => {
        if (settled) {
          return;
        }
        if (Date.now() >= input.deadlineAtMs) {
          settled = true;
          clearTimeout(deadline);
          abortController.abort();
          resolve();
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve();
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        if (Date.now() >= input.deadlineAtMs) {
          settled = true;
          clearTimeout(deadline);
          abortController.abort();
          resolve();
          return;
        }
        settled = true;
        clearTimeout(deadline);
        reject(error);
      }
    );
  });
}

export class CoordinationEventHandoff {
  private readonly journal: CoordinationEventJournal;
  private readonly retentionLeases: SnapshotRetentionLeaseCoordinator;
  private readonly wakeup: CoordinationEventWakeup | undefined;
  private readonly defaultMaxReplayEvents: number;
  private readonly replayBatchSize: number;
  private readonly snapshotLeaseTtlMs: number;
  private lastObservedWatermark: EventJournalWatermark | undefined;

  constructor(options: CoordinationEventHandoffOptions) {
    if (!options?.journal || !options.retentionLeases) {
      throw invalidOptions('Coordination event journal and retention coordinator are required');
    }
    this.journal = options.journal;
    this.retentionLeases = options.retentionLeases;
    this.wakeup = options.wakeup;
    this.defaultMaxReplayEvents = options.defaultMaxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.replayBatchSize = options.replayBatchSize ?? DEFAULT_REPLAY_BATCH_SIZE;
    this.snapshotLeaseTtlMs = options.snapshotLeaseTtlMs ?? DEFAULT_SNAPSHOT_LEASE_TTL_MS;

    assertBoundedPositiveInteger(
      this.defaultMaxReplayEvents,
      'defaultMaxReplayEvents',
      MAX_REPLAY_EVENTS
    );
    assertBoundedPositiveInteger(this.replayBatchSize, 'replayBatchSize', MAX_REPLAY_EVENTS);
    assertBoundedPositiveInteger(
      this.snapshotLeaseTtlMs,
      'snapshotLeaseTtlMs',
      MAX_SNAPSHOT_LEASE_TTL_MS
    );
  }

  async captureSameTransactionSnapshot<TSnapshot>(input: {
    readonly request: CoordinationSnapshotRequest;
    readonly source: SameTransactionCoordinationSnapshotSource<TSnapshot>;
  }): Promise<CoordinationSnapshotEnvelope<TSnapshot>> {
    assertSnapshotRequest(input.request);
    const read = await input.source.readSnapshotWithEventBarrier(input.request);
    const watermark = materializeEventJournalWatermark(read.watermark);
    this.observeJournalWatermark(watermark);
    const metadata = createCoordinationSnapshotMetadata({
      watermark,
      handoffMode: 'same_transaction',
      revisionVector: read.revisionVector,
    });
    assertCoordinationSnapshotMetadata(metadata, watermark);
    const snapshot = materializeCoordinationSnapshotData(read.snapshot);
    return Object.freeze({ metadata, snapshot });
  }

  async captureExternalSnapshot<TSnapshot>(input: {
    readonly request: CoordinationSnapshotRequest;
    readonly source: ExternalCoordinationSnapshotSource<TSnapshot>;
    /** Runs while the coordinator still owns a valid retention pin. */
    readonly deliver: (
      snapshot: CoordinationSnapshotEnvelope<TSnapshot>,
      context: { readonly signal: AbortSignal; readonly deadlineAtMs: number }
    ) => Promise<void>;
  }): Promise<void> {
    assertSnapshotRequest(input.request);
    if (typeof input.deliver !== 'function') {
      throw invalidOptions('External snapshot delivery boundary is required');
    }
    const deadlineController = new AbortController();
    const acquisitionDeadlineAtMs = Date.now() + this.snapshotLeaseTtlMs;
    const acquisition = Promise.resolve().then(() =>
      this.retentionLeases.acquireSnapshotLease({
        request: input.request,
        ttlMs: this.snapshotLeaseTtlMs,
        deadlineAtMs: acquisitionDeadlineAtMs,
        signal: deadlineController.signal,
      })
    );
    let lease: SnapshotRetentionLease;
    try {
      lease = await settleSnapshotPhaseBeforeDeadline({
        operation: acquisition,
        deadlineAtMs: acquisitionDeadlineAtMs,
        abortController: deadlineController,
        phase: 'acquisition',
      });
    } catch (error) {
      if (isSnapshotDeadlineError(error, 'acquisition')) {
        releaseLateSnapshotLease(acquisition, acquisitionDeadlineAtMs, this.retentionLeases);
      }
      throw error;
    }

    const leaseId = lease.leaseId;
    let captureFailed = false;
    let captureError: unknown;
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      assertIdentifier(leaseId, 'leaseId');
      assertSnapshotLeaseDeadline(lease.deadlineAtMs, acquisitionDeadlineAtMs);
      const leaseWatermark = materializeEventJournalWatermark(lease.watermark);
      this.observeJournalWatermark(leaseWatermark);

      let currentLeasePhase: SnapshotDeadlinePhase = 'lease_callback';
      const leaseRun = Promise.resolve().then(() =>
        this.retentionLeases.runWithSnapshotLease({
          leaseId,
          run: async (status) => {
            const statusWatermark = materializeEventJournalWatermark(status.watermark);
            this.observeJournalWatermark(statusWatermark);
            if (!status.active) {
              throw new CoordinationEventHandoffError(
                'snapshot_retry',
                'External snapshot retention lease expired before handoff completed',
                { leaseId }
              );
            }
            assertSameJournalIdentity(leaseWatermark, statusWatermark);

            try {
              validateReplayCursor(
                encodePosition(leaseWatermark, leaseWatermark.highWatermarkSequence),
                statusWatermark
              );
            } catch (error) {
              throw new CoordinationEventHandoffError(
                'snapshot_retry',
                'External snapshot replay barrier is no longer retained',
                { leaseId },
                error
              );
            }

            const remainingMs = lease.deadlineAtMs - Date.now();
            if (remainingMs <= 0) {
              deadlineController.abort();
              throw new CoordinationEventHandoffError(
                'snapshot_retry',
                'External snapshot lease deadline elapsed before source observation',
                { leaseId, deadlineAtMs: lease.deadlineAtMs }
              );
            }
            currentLeasePhase = 'read';
            const read = await settleSnapshotPhaseBeforeDeadline({
              operation: Promise.resolve().then(() =>
                input.source.readStableSnapshot(input.request, {
                  signal: deadlineController.signal,
                  deadlineAtMs: lease.deadlineAtMs,
                })
              ),
              deadlineAtMs: lease.deadlineAtMs,
              abortController: deadlineController,
              phase: 'read',
              leaseId,
            });

            assertIdentifier(read.sourceGenerationBefore, 'sourceGenerationBefore');
            assertIdentifier(read.sourceGenerationAfter, 'sourceGenerationAfter');
            if (read.sourceGenerationBefore !== read.sourceGenerationAfter) {
              throw new CoordinationEventHandoffError(
                'snapshot_retry',
                'External snapshot source generation changed during the stable read',
                {
                  sourceGenerationBefore: read.sourceGenerationBefore,
                  sourceGenerationAfter: read.sourceGenerationAfter,
                }
              );
            }

            const metadata = createCoordinationSnapshotMetadata({
              watermark: leaseWatermark,
              handoffMode: 'lower_barrier',
              revisionVector: read.revisionVector,
            });
            const snapshot = materializeCoordinationSnapshotData(read.snapshot);
            currentLeasePhase = 'delivery';
            await settleSnapshotPhaseBeforeDeadline({
              operation: Promise.resolve().then(() =>
                input.deliver(Object.freeze({ metadata, snapshot }), {
                  signal: deadlineController.signal,
                  deadlineAtMs: lease.deadlineAtMs,
                })
              ),
              deadlineAtMs: lease.deadlineAtMs,
              abortController: deadlineController,
              phase: 'delivery',
              leaseId,
            });
            currentLeasePhase = 'lease_callback';
          },
        })
      );
      await settleSnapshotPhaseBeforeDeadline({
        operation: leaseRun,
        deadlineAtMs: lease.deadlineAtMs,
        abortController: deadlineController,
        phase: () => currentLeasePhase,
        leaseId,
      });
    } catch (error) {
      captureFailed = true;
      captureError = error;
    } finally {
      deadlineController.abort();
      try {
        await releaseSnapshotLeaseBeforeDeadline({
          leaseId,
          deadlineAtMs: lease.deadlineAtMs,
          retentionLeases: this.retentionLeases,
        });
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
    }
    if (captureFailed) {
      throw captureError;
    }
    if (releaseFailed) {
      throw releaseError;
    }
  }

  async replay<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(
    input: ReplayCoordinationEventsInput
  ): Promise<CoordinationReplayBatch<TPayload>> {
    const maxEvents = input.maxEvents ?? this.defaultMaxReplayEvents;
    assertBoundedPositiveInteger(maxEvents, 'maxEvents', MAX_REPLAY_EVENTS);

    const initialWatermark = materializeEventJournalWatermark(await this.journal.getWatermark());
    this.observeJournalWatermark(initialWatermark);
    const from = validateReplayCursor(input.cursor, initialWatermark);
    const targetSequence = initialWatermark.highWatermarkSequence;
    let currentSequence = from.eventSequence;
    const events: CoordinationEventEnvelope<TPayload>[] = [];

    while (currentSequence < targetSequence && events.length < maxEvents) {
      const limit = Math.min(
        this.replayBatchSize,
        maxEvents - events.length,
        targetSequence - currentSequence
      );
      const read = materializeJournalReplayRead<TPayload>(
        await this.journal.readCommittedEvents<TPayload>({
          afterSequence: currentSequence,
          throughSequence: targetSequence,
          limit,
        }),
        limit
      );
      this.observeJournalWatermark(read.watermark);
      assertSameJournalIdentity(initialWatermark, read.watermark);
      if (read.watermark.highWatermarkSequence < targetSequence) {
        throw journalProtocolError('Event journal high watermark regressed during replay', {
          targetSequence,
          observedHighWatermarkSequence: read.watermark.highWatermarkSequence,
        });
      }

      const page = createCoordinationReplayBatch({
        fromCursor: encodePosition(initialWatermark, currentSequence),
        events: read.events,
        watermark: read.watermark,
        maxEvents: limit,
        throughSequence: targetSequence,
      });
      events.push(...page.events);
      currentSequence = decodeReplayCursor(page.nextCursor).eventSequence;
    }

    const finalWatermark = materializeEventJournalWatermark(await this.journal.getWatermark());
    this.observeJournalWatermark(finalWatermark);
    assertSameJournalIdentity(initialWatermark, finalWatermark);
    if (finalWatermark.highWatermarkSequence < targetSequence) {
      throw journalProtocolError('Event journal high watermark regressed after replay', {
        targetSequence,
        observedHighWatermarkSequence: finalWatermark.highWatermarkSequence,
      });
    }
    validateReplayCursor(encodePosition(initialWatermark, currentSequence), finalWatermark);

    const boundedTargetSequence = Math.min(targetSequence, from.eventSequence + maxEvents);
    const validated = createCoordinationReplayBatch({
      fromCursor: input.cursor,
      events,
      watermark: initialWatermark,
      maxEvents,
      throughSequence: boundedTargetSequence,
    });
    return Object.freeze({
      ...validated,
      watermark: Object.freeze({ ...finalWatermark }),
      hasMore: currentSequence < finalWatermark.highWatermarkSequence,
    });
  }

  /**
   * Durable append always precedes the lossy live wake-up. A wake-up failure is
   * reported but never turns a committed mutation/event into a retryable write.
   */
  async publishCommittedEvent<TPayload extends CoordinationJsonValue>(
    command: PublishCoordinationEventCommand<TPayload>
  ): Promise<PublishCommittedCoordinationEventResult<TPayload>> {
    const draft = bindTrustedEventAttribution(command);
    assertCoordinationEventDraft(draft);
    const committed = materializeCommittedEventAppend<TPayload>(
      await this.journal.appendCommittedEvent(draft)
    );
    this.observeJournalWatermark(committed.watermark);
    assertCommittedEventMatchesDraft(committed.event, draft);
    if (committed.event.eventSequence <= committed.watermark.retentionFloorSequence) {
      throw journalProtocolError(
        'Newly committed event is not replayable above the retention floor',
        {
          eventId: committed.event.eventId,
          eventSequence: committed.event.eventSequence,
          retentionFloorSequence: committed.watermark.retentionFloorSequence,
        }
      );
    }

    if (!this.wakeup) {
      return Object.freeze({ event: committed.event, liveWakeup: 'not_configured' });
    }
    try {
      await this.wakeup.notifyCommittedEvent(committed.event);
      return Object.freeze({ event: committed.event, liveWakeup: 'delivered' });
    } catch {
      return Object.freeze({ event: committed.event, liveWakeup: 'failed' });
    }
  }

  /**
   * Produces one verified event-journal participant artifact in the only safe
   * order. The backup feature remains responsible for commit-marker-last root
   * publication after every participant has verified.
   */
  async prepareRecoveryPoint(input: {
    readonly participant: CoordinationEventRecoveryPointParticipant;
    readonly recoveryRunId: string;
    readonly deploymentId: string;
  }): Promise<VerifiedCoordinationEventRecoveryPoint> {
    assertIdentifier(input.participant.participantId, 'participantId');
    assertIdentifier(input.recoveryRunId, 'recoveryRunId');
    assertIdentifier(input.deploymentId, 'deploymentId');

    const preparation = await input.participant.prepare({
      recoveryRunId: input.recoveryRunId,
      deploymentId: input.deploymentId,
    });
    if (
      preparation.schemaVersion !== 1 ||
      preparation.participantId !== input.participant.participantId ||
      preparation.recoveryRunId !== input.recoveryRunId ||
      preparation.deploymentId !== input.deploymentId
    ) {
      throw recoveryProtocolError('Recovery-point preparation identity is invalid');
    }
    const immutablePreparation = Object.freeze({ ...preparation });

    const recoveryPoint = await input.participant.flush(immutablePreparation);
    try {
      assertCoordinationEventRecoveryPoint(recoveryPoint);
    } catch (error) {
      throw recoveryProtocolError('Flushed event barrier is invalid', error);
    }
    if (
      recoveryPoint.participantId !== immutablePreparation.participantId ||
      recoveryPoint.deploymentId !== immutablePreparation.deploymentId
    ) {
      throw recoveryProtocolError('Flushed event barrier does not match its preparation');
    }
    this.observeJournalWatermark({
      schemaVersion: 1,
      deploymentId: recoveryPoint.deploymentId,
      eventEpoch: recoveryPoint.eventEpoch,
      retentionFloorSequence: recoveryPoint.retentionFloorSequence,
      highWatermarkSequence: recoveryPoint.highWatermarkSequence,
    });
    const immutableRecoveryPoint = Object.freeze({ ...recoveryPoint });

    const stage = await input.participant.stage(
      Object.freeze({
        preparation: immutablePreparation,
        recoveryPoint: immutableRecoveryPoint,
      })
    );
    this.assertRecoveryStage(stage, immutablePreparation.recoveryRunId, immutableRecoveryPoint);
    const immutableStage = freezeRecoveryStage(stage);
    const verified = await input.participant.verify(immutableStage);
    this.assertRecoveryStage(verified, immutablePreparation.recoveryRunId, immutableRecoveryPoint);
    if (verified.verified !== true) {
      throw recoveryProtocolError('Recovery-point participant did not return verified evidence');
    }
    if (!sameRecoveryStage(immutableStage, verified)) {
      throw recoveryProtocolError(
        'Recovery-point verification changed the staged artifact identity'
      );
    }
    return freezeRecoveryStage(verified);
  }

  private observeJournalWatermark(watermark: EventJournalWatermark): void {
    assertJournalWatermark(watermark);
    if (this.lastObservedWatermark) {
      try {
        assertJournalWatermarkProgression(this.lastObservedWatermark, watermark);
      } catch (error) {
        throw journalProtocolError('Event journal watermark regressed or changed identity', {
          previousWatermark: this.lastObservedWatermark,
          currentWatermark: watermark,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.lastObservedWatermark = Object.freeze({ ...watermark });
  }

  private assertRecoveryStage(
    stage: CoordinationEventRecoveryPointStage,
    recoveryRunId: string,
    recoveryPoint: CoordinationEventRecoveryPointStage['recoveryPoint']
  ): void {
    if (
      stage?.schemaVersion !== 1 ||
      stage.recoveryRunId !== recoveryRunId ||
      stage.participantId !== recoveryPoint.participantId
    ) {
      throw recoveryProtocolError('Recovery-point stage identity is invalid');
    }
    assertRecoveryIdentifier(stage.stagedArtifactRef, 'stagedArtifactRef');
    assertRecoveryIdentifier(stage.contentDigest, 'contentDigest');
    try {
      assertCoordinationEventRecoveryPoint(stage.recoveryPoint);
    } catch (error) {
      throw recoveryProtocolError('Recovery-point stage contains an invalid event barrier', error);
    }
    if (!sameRecoveryPoint(stage.recoveryPoint, recoveryPoint)) {
      throw recoveryProtocolError('Recovery-point stage changed the flushed event barrier');
    }
  }
}
