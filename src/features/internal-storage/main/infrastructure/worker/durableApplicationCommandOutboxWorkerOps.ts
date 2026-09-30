import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm';

import * as mapping from './applicationCommandLedgerMapping';
import * as validation from './applicationCommandLedgerValidation';
import { MAX_OUTBOX_PAGE_SIZE } from './applicationCommandLedgerWorkerTypes';
import {
  durableApplicationCommandConsumerApplications,
  durableApplicationCommandConsumerProjections,
  durableApplicationCommandOutbox,
} from './internalStorageSchema';

import type { ApplicationCommandLedgerRecordRepository } from './applicationCommandLedgerRecordRepository';
import type {
  DurableConsumerApplicationRow,
  DurableConsumerProjectionRow,
  DurableOutboxRow,
} from './applicationCommandLedgerWorkerTypes';
import type {
  DurableApplicationCommandConsumerApplyRequest,
  DurableApplicationCommandConsumerApplyResult,
  DurableApplicationCommandConsumerProjectionRecord,
  DurableApplicationCommandConsumerProjectionRequest,
  DurableApplicationCommandOutboxClaimRequest,
  DurableApplicationCommandOutboxDeliveryAcknowledgementRequest,
  DurableApplicationCommandOutboxListRequest,
  DurableApplicationCommandOutboxRecord,
} from '@features/application-command-ledger';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export class DurableApplicationCommandOutboxWorkerOps {
  constructor(
    private readonly getOrm: () => BetterSQLite3Database,
    private readonly repository: ApplicationCommandLedgerRecordRepository
  ) {}

  durableListOutbox(
    input: DurableApplicationCommandOutboxListRequest
  ): DurableApplicationCommandOutboxRecord[] {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new Error('Durable application command outbox afterSequence must be non-negative');
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > MAX_OUTBOX_PAGE_SIZE
    ) {
      throw new Error(
        `Durable application command outbox limit must be between 1 and ${MAX_OUTBOX_PAGE_SIZE}`
      );
    }
    return this.getOrm()
      .select()
      .from(durableApplicationCommandOutbox)
      .where(gt(durableApplicationCommandOutbox.sequence, input.afterSequence))
      .orderBy(asc(durableApplicationCommandOutbox.sequence))
      .limit(input.limit)
      .all()
      .map(mapping.mapOutboxRow);
  }

  durableClaimOutbox(
    input: DurableApplicationCommandOutboxClaimRequest
  ): DurableApplicationCommandOutboxRecord[] {
    validation.validateDurableOutboxClaim(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const rows = orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(isNull(durableApplicationCommandOutbox.deliveryAcknowledgedAt))
          .orderBy(asc(durableApplicationCommandOutbox.sequence))
          .limit(input.limit)
          .all() as DurableOutboxRow[];
        if (rows.length === 0) return [];

        const first = mapping.mapOutboxRow(rows[0]);
        if (first.deliveryLease && !validation.sameOutboxDeliveryClaim(first, input)) {
          if (Date.parse(input.claimedAtIso) < Date.parse(first.deliveryLease.leaseExpiresAt)) {
            return [];
          }
        }

        if (first.deliveryLease && validation.sameOutboxDeliveryClaim(first, input)) {
          const claimed: DurableApplicationCommandOutboxRecord[] = [];
          for (const row of rows) {
            const record = mapping.mapOutboxRow(row);
            if (!validation.sameOutboxDeliveryClaim(record, input)) break;
            claimed.push(record);
          }
          return claimed;
        }

        for (const row of rows) {
          orm
            .update(durableApplicationCommandOutbox)
            .set({
              deliveryGeneration: row.deliveryGeneration + 1,
              deliveryOwnerId: input.ownerId,
              deliveryLeaseToken: input.leaseToken,
              deliveryClaimedAt: input.claimedAtIso,
              deliveryLeaseExpiresAt: input.leaseExpiresAtIso,
            })
            .where(eq(durableApplicationCommandOutbox.sequence, row.sequence))
            .run();
        }

        return orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(isNull(durableApplicationCommandOutbox.deliveryAcknowledgedAt))
          .orderBy(asc(durableApplicationCommandOutbox.sequence))
          .limit(rows.length)
          .all()
          .map(mapping.mapOutboxRow);
      },
      { behavior: 'immediate' }
    );
  }

  durableAcknowledgeOutboxDelivery(
    input: DurableApplicationCommandOutboxDeliveryAcknowledgementRequest
  ): void {
    validation.validateDurableOutboxDeliveryAcknowledgement(input);
    const orm = this.getOrm();
    orm.transaction(
      () => {
        const rows = orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(eq(durableApplicationCommandOutbox.eventId, input.eventId))
          .all();
        const row = rows[0];
        if (!row) {
          throw new Error(`Durable application command outbox event not found: ${input.eventId}`);
        }
        const record = mapping.mapOutboxRow(row);
        validation.assertOutboxDeliveryFence(record, input);
        if (row.deliveryAcknowledgedAt !== null) return;
        if (
          Date.parse(input.acknowledgedAtIso) < Date.parse(record.deliveryLease!.claimedAt) ||
          Date.parse(input.acknowledgedAtIso) >= Date.parse(record.deliveryLease!.leaseExpiresAt)
        ) {
          throw new Error(
            `Durable application command outbox delivery lease expired: ${input.eventId}`
          );
        }
        const earlierUnacknowledged = orm
          .select({ sequence: durableApplicationCommandOutbox.sequence })
          .from(durableApplicationCommandOutbox)
          .where(
            and(
              isNull(durableApplicationCommandOutbox.deliveryAcknowledgedAt),
              lt(durableApplicationCommandOutbox.sequence, record.sequence)
            )
          )
          .limit(1)
          .all();
        if (earlierUnacknowledged.length > 0) {
          throw new Error(
            `Durable application command outbox must acknowledge delivery in sequence order: ${input.eventId}`
          );
        }
        orm
          .update(durableApplicationCommandOutbox)
          .set({ deliveryAcknowledgedAt: input.acknowledgedAtIso })
          .where(eq(durableApplicationCommandOutbox.eventId, input.eventId))
          .run();
      },
      { behavior: 'immediate' }
    );
  }

  durableApplyConsumerEvent(
    input: DurableApplicationCommandConsumerApplyRequest
  ): DurableApplicationCommandConsumerApplyResult {
    validation.validateDurableConsumerApply(input);
    const orm = this.getOrm();
    return orm.transaction(
      () => {
        const eventRow = orm
          .select()
          .from(durableApplicationCommandOutbox)
          .where(eq(durableApplicationCommandOutbox.eventId, input.eventId))
          .get() as DurableOutboxRow | undefined;
        if (!eventRow) {
          throw new Error(`Durable application command consumer event not found: ${input.eventId}`);
        }
        const event = mapping.mapOutboxRow(eventRow);
        if (event.semanticRevision !== input.semanticRevision) {
          throw new Error(
            `Durable application command consumer semantic revision mismatch: ${input.eventId} expected=${event.semanticRevision} actual=${input.semanticRevision}`
          );
        }

        const existingRow = orm
          .select()
          .from(durableApplicationCommandConsumerApplications)
          .where(
            and(
              eq(durableApplicationCommandConsumerApplications.consumerId, input.consumerId),
              eq(durableApplicationCommandConsumerApplications.eventId, input.eventId)
            )
          )
          .get() as DurableConsumerApplicationRow | undefined;
        if (existingRow) {
          const application = mapping.mapConsumerApplicationRow(existingRow);
          if (
            application.semanticRevision !== input.semanticRevision ||
            application.projectionKey !== input.projectionKey ||
            application.stateJson !== input.stateJson
          ) {
            throw new Error(
              `Durable application command consumer replay conflicts with the applied event: ${input.eventId}`
            );
          }
          return {
            outcome: 'duplicate',
            application,
            projection: this.requireDurableConsumerProjection(input),
          };
        }

        const current = this.readDurableConsumerProjection(input);
        if (current && input.semanticRevision <= current.semanticRevision) {
          throw new Error(
            `Durable application command consumer semantic revision must advance: ${input.projectionKey} current=${current.semanticRevision} actual=${input.semanticRevision}`
          );
        }

        orm
          .insert(durableApplicationCommandConsumerApplications)
          .values({
            consumerId: input.consumerId,
            eventId: input.eventId,
            semanticRevision: input.semanticRevision,
            projectionKey: input.projectionKey,
            stateJson: input.stateJson,
            appliedAt: input.appliedAtIso,
          })
          .run();

        if (current) {
          orm
            .update(durableApplicationCommandConsumerProjections)
            .set({
              semanticRevision: input.semanticRevision,
              lastEventId: input.eventId,
              stateJson: input.stateJson,
              applicationCount: current.applicationCount + 1,
              updatedAt: input.appliedAtIso,
            })
            .where(
              and(
                eq(durableApplicationCommandConsumerProjections.consumerId, input.consumerId),
                eq(durableApplicationCommandConsumerProjections.projectionKey, input.projectionKey)
              )
            )
            .run();
        } else {
          orm
            .insert(durableApplicationCommandConsumerProjections)
            .values({
              consumerId: input.consumerId,
              projectionKey: input.projectionKey,
              semanticRevision: input.semanticRevision,
              lastEventId: input.eventId,
              stateJson: input.stateJson,
              applicationCount: 1,
              updatedAt: input.appliedAtIso,
            })
            .run();
        }

        return {
          outcome: 'applied',
          application: mapping.mapConsumerApplicationRow({
            consumerId: input.consumerId,
            eventId: input.eventId,
            semanticRevision: input.semanticRevision,
            projectionKey: input.projectionKey,
            stateJson: input.stateJson,
            appliedAt: input.appliedAtIso,
          }),
          projection: this.requireDurableConsumerProjection(input),
        };
      },
      { behavior: 'immediate' }
    );
  }

  durableGetConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord | null {
    validation.validateDurableConsumerProjectionRequest(input);
    return this.readDurableConsumerProjection(input);
  }

  readDurableConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord | null {
    const row = this.getOrm()
      .select()
      .from(durableApplicationCommandConsumerProjections)
      .where(
        and(
          eq(durableApplicationCommandConsumerProjections.consumerId, input.consumerId),
          eq(durableApplicationCommandConsumerProjections.projectionKey, input.projectionKey)
        )
      )
      .get() as DurableConsumerProjectionRow | undefined;
    return row ? mapping.mapConsumerProjectionRow(row) : null;
  }

  requireDurableConsumerProjection(
    input: DurableApplicationCommandConsumerProjectionRequest
  ): DurableApplicationCommandConsumerProjectionRecord {
    const projection = this.readDurableConsumerProjection(input);
    if (!projection) {
      throw new Error(
        `Durable application command consumer projection not found: ${input.consumerId}/${input.projectionKey}`
      );
    }
    return projection;
  }
}
