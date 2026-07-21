import {
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  type CoordinationJsonValue,
  EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION,
  type EventJournalWatermark,
} from '../../../contracts';
import {
  encodeReplayCursor,
  materializeCoordinationEventEnvelope,
  materializeEventJournalWatermark,
} from '../../../core/domain';

import type {
  CommittedCoordinationEventAppend,
  CoordinationEventJournal,
  CoordinationJournalReplayRead,
} from '../../../core/application';
import type {
  CoordinationDurabilityStorageGateway,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
} from '@features/internal-storage/main';

export interface SqliteCoordinationEventJournalOptions {
  readonly storage: CoordinationDurabilityStorageGateway;
  readonly deploymentId: string;
  readonly eventEpoch?: string;
  readonly now?: () => Date;
}

/** The only durable event authority; command outbox rows are journaled into these same rows. */
export class SqliteCoordinationEventJournal implements CoordinationEventJournal {
  private readonly now: () => Date;
  private initialization: Promise<StoredEventJournalMetadata> | null = null;

  constructor(private readonly options: SqliteCoordinationEventJournalOptions) {
    if (!options.storage || !options.deploymentId) {
      throw new TypeError('sqlite-coordination-event-journal-options-invalid');
    }
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<EventJournalWatermark> {
    return mapWatermark(await this.requireInitialization());
  }

  async getWatermark(): Promise<EventJournalWatermark> {
    await this.requireInitialization();
    return mapWatermark(
      await this.options.storage.coordinationEventGetWatermark(this.options.deploymentId)
    );
  }

  async readCommittedEvents<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Promise<CoordinationJournalReplayRead<TPayload>> {
    await this.requireInitialization();
    const result = await this.options.storage.coordinationEventRead({
      deploymentId: this.options.deploymentId,
      ...input,
    });
    const watermark = mapWatermark(result.watermark);
    return Object.freeze({
      events: Object.freeze(
        result.rows.map((row) => materializeStoredEvent<TPayload>(row, watermark))
      ),
      watermark,
    });
  }

  async appendCommittedEvent<TPayload extends CoordinationJsonValue>(
    draft: CoordinationEventDraft<TPayload>
  ): Promise<CommittedCoordinationEventAppend<TPayload>> {
    const initialized = await this.requireInitialization();
    const result = await this.options.storage.coordinationEventAppend({
      deploymentId: this.options.deploymentId,
      eventEpoch: initialized.eventEpoch,
      draft: draft as CoordinationEventDraft<CoordinationJsonValue>,
      bodyJson: canonicalJson(draft),
      nowIso: this.now().toISOString(),
    });
    const watermark = mapWatermark(result.watermark);
    return Object.freeze({
      event: materializeStoredEvent<TPayload>(result.row, watermark),
      watermark,
    });
  }

  async pruneThrough(throughSequence: number): Promise<EventJournalWatermark> {
    const initialized = await this.requireInitialization();
    const now = this.now();
    return mapWatermark(
      await this.options.storage.coordinationEventPrune({
        deploymentId: this.options.deploymentId,
        eventEpoch: initialized.eventEpoch,
        throughSequence,
        nowMs: now.getTime(),
        nowIso: now.toISOString(),
      })
    );
  }

  private requireInitialization(): Promise<StoredEventJournalMetadata> {
    this.initialization ??= this.options.storage.coordinationEventInitialize({
      deploymentId: this.options.deploymentId,
      ...(this.options.eventEpoch === undefined ? {} : { eventEpoch: this.options.eventEpoch }),
      nowIso: this.now().toISOString(),
    });
    return this.initialization;
  }
}

function materializeStoredEvent<TPayload extends CoordinationJsonValue>(
  row: StoredCoordinationEventRow,
  watermark: EventJournalWatermark
): CoordinationEventEnvelope<TPayload> {
  let body: unknown;
  try {
    body = JSON.parse(row.bodyJson) as unknown;
  } catch (error) {
    throw new Error('sqlite-coordination-event-body-corrupt', { cause: error });
  }
  if (canonicalJson(body) !== row.bodyJson) {
    throw new Error('sqlite-coordination-event-body-not-canonical');
  }
  if (row.deploymentId !== watermark.deploymentId || row.eventEpoch !== watermark.eventEpoch) {
    throw new Error('sqlite-coordination-event-identity-mismatch');
  }
  return materializeCoordinationEventEnvelope<TPayload>(
    Object.freeze({
      ...(body as CoordinationEventDraft<TPayload>),
      deploymentId: row.deploymentId,
      eventEpoch: row.eventEpoch,
      eventSequence: row.eventSequence,
      eventCursor: encodeReplayCursor({
        deploymentId: row.deploymentId,
        eventEpoch: row.eventEpoch,
        eventSequence: row.eventSequence,
      }),
    }),
    watermark
  );
}

function mapWatermark(metadata: StoredEventJournalMetadata): EventJournalWatermark {
  return materializeEventJournalWatermark({
    schemaVersion: EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION,
    deploymentId: metadata.deploymentId,
    eventEpoch: metadata.eventEpoch,
    retentionFloorSequence: metadata.retentionFloorSequence,
    highWatermarkSequence: metadata.highWatermarkSequence,
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('coordination-event-json-number-invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') throw new TypeError('coordination-event-json-invalid');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = normalize(child);
  }
  return result;
}
