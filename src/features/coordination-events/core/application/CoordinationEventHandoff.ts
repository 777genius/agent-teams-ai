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
  assertSameJournalIdentity,
  assertSnapshotRequest,
  bindTrustedEventAttribution,
  encodePosition,
  invalidOptions,
  journalProtocolError,
  materializeCommittedEventAppend,
  materializeJournalReplayRead,
} from './coordinationEventHandoffSupport';

import type {
  CoordinationEventJournal,
  CoordinationEventWakeup,
  CoordinationSnapshotRequest,
  ExternalCoordinationSnapshotSource,
  PublishCoordinationEventCommand,
  SameTransactionCoordinationSnapshotSource,
} from './ports';

const DEFAULT_MAX_REPLAY_EVENTS = 500;
const DEFAULT_REPLAY_BATCH_SIZE = 100;
const DEFAULT_EXTERNAL_SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_EXTERNAL_SNAPSHOT_TIMEOUT_MS = 60_000;

export {
  CoordinationEventHandoffError,
  type CoordinationEventHandoffErrorCode,
} from './coordinationEventHandoffError';

export interface CoordinationEventHandoffOptions {
  readonly journal: CoordinationEventJournal;
  readonly wakeup?: CoordinationEventWakeup;
  readonly defaultMaxReplayEvents?: number;
  readonly replayBatchSize?: number;
  readonly externalSnapshotTimeoutMs?: number;
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

type SnapshotDeadlinePhase = 'barrier' | 'read';

function settleSnapshotPhaseBeforeDeadline<T>(input: {
  readonly operation: Promise<T>;
  readonly deadlineAtMs: number;
  readonly abortController: AbortController;
  readonly phase: SnapshotDeadlinePhase | (() => SnapshotDeadlinePhase);
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
        reject(
          error instanceof Error
            ? error
            : new Error('External snapshot operation rejected', { cause: error })
        );
      }
    );
  });
}

function snapshotDeadlineError(input: {
  readonly phase: SnapshotDeadlinePhase | (() => SnapshotDeadlinePhase);
  readonly deadlineAtMs: number;
}): CoordinationEventHandoffError {
  const phaseDescription: Record<SnapshotDeadlinePhase, string> = {
    barrier: 'journal barrier observation',
    read: 'source observation',
  };
  const phase = typeof input.phase === 'function' ? input.phase() : input.phase;
  return new CoordinationEventHandoffError(
    'snapshot_retry',
    `External snapshot ${phaseDescription[phase]} exceeded its deadline`,
    {
      phase,
      deadlineAtMs: input.deadlineAtMs,
    }
  );
}

export class CoordinationEventHandoff {
  private readonly journal: CoordinationEventJournal;
  private readonly wakeup: CoordinationEventWakeup | undefined;
  private readonly defaultMaxReplayEvents: number;
  private readonly replayBatchSize: number;
  private readonly externalSnapshotTimeoutMs: number;
  private lastObservedWatermark: EventJournalWatermark | undefined;

  constructor(options: CoordinationEventHandoffOptions) {
    if (!options?.journal) {
      throw invalidOptions('Coordination event journal is required');
    }
    this.journal = options.journal;
    this.wakeup = options.wakeup;
    this.defaultMaxReplayEvents = options.defaultMaxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.replayBatchSize = options.replayBatchSize ?? DEFAULT_REPLAY_BATCH_SIZE;
    this.externalSnapshotTimeoutMs =
      options.externalSnapshotTimeoutMs ?? DEFAULT_EXTERNAL_SNAPSHOT_TIMEOUT_MS;

    assertBoundedPositiveInteger(
      this.defaultMaxReplayEvents,
      'defaultMaxReplayEvents',
      MAX_REPLAY_EVENTS
    );
    assertBoundedPositiveInteger(this.replayBatchSize, 'replayBatchSize', MAX_REPLAY_EVENTS);
    assertBoundedPositiveInteger(
      this.externalSnapshotTimeoutMs,
      'externalSnapshotTimeoutMs',
      MAX_EXTERNAL_SNAPSHOT_TIMEOUT_MS
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
  }): Promise<CoordinationSnapshotEnvelope<TSnapshot>> {
    assertSnapshotRequest(input.request);
    const deadlineController = new AbortController();
    const deadlineAtMs = Date.now() + this.externalSnapshotTimeoutMs;
    try {
      const lowerBarrier = materializeEventJournalWatermark(
        await settleSnapshotPhaseBeforeDeadline({
          operation: Promise.resolve().then(() => this.journal.getWatermark()),
          deadlineAtMs,
          abortController: deadlineController,
          phase: 'barrier',
        })
      );
      this.observeJournalWatermark(lowerBarrier);

      const read = await settleSnapshotPhaseBeforeDeadline({
        operation: Promise.resolve().then(() =>
          input.source.readStableSnapshot(input.request, {
            signal: deadlineController.signal,
            deadlineAtMs,
          })
        ),
        deadlineAtMs,
        abortController: deadlineController,
        phase: 'read',
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

      const finalWatermark = materializeEventJournalWatermark(
        await settleSnapshotPhaseBeforeDeadline({
          operation: Promise.resolve().then(() => this.journal.getWatermark()),
          deadlineAtMs,
          abortController: deadlineController,
          phase: 'barrier',
        })
      );
      this.observeJournalWatermark(finalWatermark);
      assertSameJournalIdentity(lowerBarrier, finalWatermark);
      try {
        validateReplayCursor(
          encodePosition(lowerBarrier, lowerBarrier.highWatermarkSequence),
          finalWatermark
        );
      } catch (error) {
        throw new CoordinationEventHandoffError(
          'snapshot_retry',
          'External snapshot replay barrier is no longer retained',
          {
            replayBarrierSequence: lowerBarrier.highWatermarkSequence,
            retentionFloorSequence: finalWatermark.retentionFloorSequence,
          },
          error
        );
      }

      const metadata = createCoordinationSnapshotMetadata({
        watermark: lowerBarrier,
        handoffMode: 'lower_barrier',
        revisionVector: read.revisionVector,
      });
      const snapshot = materializeCoordinationSnapshotData(read.snapshot);
      return Object.freeze({ metadata, snapshot });
    } finally {
      deadlineController.abort();
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
}
