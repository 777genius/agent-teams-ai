import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { Inject, Injectable } from "@nestjs/common";

import {
  getPrismaTransactionClient,
  PRISMA_DATABASE_CLIENT,
  type PrismaClientLike,
  type PrismaDatabaseClient,
  type PrismaTransactionClientLike,
} from "@agent-teams-control-plane/platform-database";
import {
  createSafeError,
  parseExternalActionContentId,
  parseOutboxEventId,
  parseWorkspaceId,
  toUnixMilliseconds,
  type SafeError,
} from "@agent-teams-control-plane/shared";

import type {
  JsonObject,
  NewOutboxEvent,
  OutboxEvent,
  OutboxEventStatus,
} from "../../domain/outbox-event.js";
import type {
  ClaimMutationResult,
  ClaimOutboxBatchInput,
  ClaimedOutboxEvent,
  CompleteOutboxEventInput,
  DeadLetterOutboxEventInput,
  OutboxRepository,
  RetryClaimMutationResult,
  RetryOutboxEventInput,
} from "../../application/ports/outbox.repository.js";
import type { TransactionContext } from "../../application/ports/transaction-context.js";

type OutboxRecord = Awaited<
  ReturnType<ReturnType<PrismaDatabaseClient["getClient"]>["outboxEvent"]["findUnique"]>
>;

type OutboxRow = NonNullable<OutboxRecord>;
type PrismaWriteClient = PrismaClientLike | PrismaTransactionClientLike;

@Injectable()
export class PrismaOutboxRepository implements OutboxRepository {
  public constructor(
    @Inject(PRISMA_DATABASE_CLIENT)
    private readonly databaseClient: PrismaDatabaseClient,
  ) {}

  public async append(
    event: NewOutboxEvent,
    context: TransactionContext,
  ): Promise<OutboxEvent> {
    const client = getPrismaTransactionClient(context);
    await client.outboxEvent.createMany({
      data: {
        eventType: event.type,
        eventVersion: event.version,
        id: event.id,
        idempotencyKey: event.idempotencyKey,
        maxAttempts: event.maxAttempts,
        nextAttemptAt: new Date(event.nextAttemptAtMs),
        payloadJson: event.payload,
        status: "pending",
        ...(event.aggregateId === undefined ? {} : { aggregateId: event.aggregateId }),
        ...(event.aggregateKind === undefined
          ? {}
          : { aggregateKind: event.aggregateKind }),
        ...(event.contentIntegrityHash === undefined
          ? {}
          : { contentIntegrityHash: event.contentIntegrityHash }),
        ...(event.contentRefId === undefined ? {} : { contentRefId: event.contentRefId }),
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
      },
      skipDuplicates: true,
    });

    const existing = await client.outboxEvent.findUnique({
      where: { idempotencyKey: event.idempotencyKey },
    });

    if (existing === null) {
      throw createSafeError({
        category: "internal",
        code: "CONTROL_PLANE_OUTBOX_APPEND_FAILED",
        message: "Outbox event could not be appended.",
      });
    }
    if (isCompatibleDuplicate(existing, event)) {
      return mapRow(existing);
    }
    throw createSafeError({
      category: "conflict",
      code: "CONTROL_PLANE_OUTBOX_IDEMPOTENCY_CONFLICT",
      message: "Outbox idempotency key already exists with different content.",
    });
  }

  public async claimNextBatch(
    input: ClaimOutboxBatchInput,
  ): Promise<readonly ClaimedOutboxEvent[]> {
    const claimToken = randomUUID();
    const client = this.databaseClient.getClient();
    const rows = await client.$queryRaw<OutboxRow[]>`
      UPDATE outbox_events
      SET
        status = 'processing',
        attempts = attempts + 1,
        locked_by = ${input.workerId},
        locked_until = now() + (${input.leaseSeconds} * interval '1 second'),
        claim_token = ${claimToken},
        updated_at = now()
      WHERE id IN (
        SELECT id
        FROM outbox_events
        WHERE status = 'pending'
          AND next_attempt_at <= now()
          AND attempts < max_attempts
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.batchSize}
      )
      RETURNING
        id,
        event_type AS "eventType",
        event_version AS "eventVersion",
        status,
        aggregate_kind AS "aggregateKind",
        aggregate_id AS "aggregateId",
        workspace_id AS "workspaceId",
        idempotency_key AS "idempotencyKey",
        payload_json AS "payloadJson",
        content_ref_id AS "contentRefId",
        content_integrity_hash AS "contentIntegrityHash",
        attempts,
        max_attempts AS "maxAttempts",
        next_attempt_at AS "nextAttemptAt",
        locked_by AS "lockedBy",
        locked_until AS "lockedUntil",
        claim_token AS "claimToken",
        last_error_code AS "lastErrorCode",
        last_error_category AS "lastErrorCategory",
        last_error_message AS "lastErrorMessage",
        last_error_retryable AS "lastErrorRetryable",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        dead_lettered_at AS "deadLetteredAt"
    `;

    return rows.map((row) => mapClaimedRow(row));
  }

  public async markCompleted(
    input: CompleteOutboxEventInput,
  ): Promise<ClaimMutationResult> {
    const result = await this.databaseClient.getClient().outboxEvent.updateMany({
      data: {
        claimToken: null,
        completedAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
        status: "completed",
        updatedAt: new Date(),
      },
      where: claimWhere(input),
    });

    return result.count === 1 ? "updated" : "stale-claim";
  }

  public async markFailedForRetry(
    input: RetryOutboxEventInput,
  ): Promise<RetryClaimMutationResult> {
    return this.databaseClient.getClient().$transaction(async (client) => {
      const rows = await client.$queryRaw<OutboxRow[]>`
        UPDATE outbox_events
        SET
          status = CASE WHEN attempts >= max_attempts THEN 'dead-lettered' ELSE 'pending' END,
          next_attempt_at = CASE
            WHEN attempts >= max_attempts THEN next_attempt_at
            WHEN attempts <= 1 THEN now()
            WHEN attempts = 2 THEN now() + interval '30 seconds' + (random() * interval '5 seconds')
            WHEN attempts = 3 THEN now() + interval '2 minutes' + (random() * interval '5 seconds')
            WHEN attempts = 4 THEN now() + interval '10 minutes' + (random() * interval '5 seconds')
            WHEN attempts = 5 THEN now() + interval '20 minutes' + (random() * interval '5 seconds')
            WHEN attempts = 6 THEN now() + interval '40 minutes' + (random() * interval '5 seconds')
            ELSE now() + interval '1 hour' + (random() * interval '5 seconds')
          END,
          locked_by = NULL,
          locked_until = NULL,
          claim_token = NULL,
          last_error_code = ${input.safeError.code},
          last_error_category = ${input.safeError.category},
          last_error_message = ${input.safeError.message},
          last_error_retryable = ${input.safeError.retryable},
          dead_lettered_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
          updated_at = now()
        WHERE id = ${input.eventId}::uuid
          AND status = 'processing'
          AND locked_by = ${input.workerId}
          AND claim_token = ${input.claimToken}
        RETURNING
          id,
          event_type AS "eventType",
          event_version AS "eventVersion",
          status,
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          workspace_id AS "workspaceId",
          idempotency_key AS "idempotencyKey",
          payload_json AS "payloadJson",
          content_ref_id AS "contentRefId",
          content_integrity_hash AS "contentIntegrityHash",
          attempts,
          max_attempts AS "maxAttempts",
          next_attempt_at AS "nextAttemptAt",
          locked_by AS "lockedBy",
          locked_until AS "lockedUntil",
          claim_token AS "claimToken",
          last_error_code AS "lastErrorCode",
          last_error_category AS "lastErrorCategory",
          last_error_message AS "lastErrorMessage",
          last_error_retryable AS "lastErrorRetryable",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt",
          dead_lettered_at AS "deadLetteredAt"
      `;

      if (rows.length === 0) {
        return "stale-claim";
      }
      if (rows[0]?.status === "dead-lettered") {
        await this.insertDeadLetter(client, rows[0], input.safeError);
        return "dead-lettered";
      }
      return "updated";
    });
  }

  public async markDeadLettered(
    input: DeadLetterOutboxEventInput,
  ): Promise<ClaimMutationResult> {
    return this.databaseClient.getClient().$transaction(async (client) => {
      const result = await client.outboxEvent.updateMany({
        data: {
          claimToken: null,
          deadLetteredAt: new Date(),
          lastErrorCategory: input.safeError.category,
          lastErrorCode: input.safeError.code,
          lastErrorMessage: input.safeError.message,
          lastErrorRetryable: input.safeError.retryable,
          lockedBy: null,
          lockedUntil: null,
          status: "dead-lettered",
          updatedAt: new Date(),
        },
        where: claimWhere({
          claimToken: input.event.claimToken,
          eventId: input.event.id,
          workerId: input.event.lockedBy,
        }),
      });

      if (result.count !== 1) {
        return "stale-claim";
      }

      await this.insertDeadLetterFromEvent(client, input.event, input.safeError);
      return "updated";
    });
  }

  public async recoverStaleProcessing(): Promise<number> {
    return this.databaseClient.getClient().$transaction(async (client) => {
      const terminalRows = await client.$queryRaw<OutboxRow[]>`
        UPDATE outbox_events
        SET
          status = 'dead-lettered',
          locked_by = NULL,
          locked_until = NULL,
          claim_token = NULL,
          last_error_code = 'CONTROL_PLANE_OUTBOX_STALE_MAX_ATTEMPTS',
          last_error_category = 'internal',
          last_error_message = 'Outbox event exhausted attempts after stale processing recovery.',
          last_error_retryable = false,
          dead_lettered_at = now(),
          updated_at = now()
        WHERE status = 'processing'
          AND locked_until < now()
          AND attempts >= max_attempts
        RETURNING
          id,
          event_type AS "eventType",
          event_version AS "eventVersion",
          status,
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          workspace_id AS "workspaceId",
          idempotency_key AS "idempotencyKey",
          payload_json AS "payloadJson",
          content_ref_id AS "contentRefId",
          content_integrity_hash AS "contentIntegrityHash",
          attempts,
          max_attempts AS "maxAttempts",
          next_attempt_at AS "nextAttemptAt",
          locked_by AS "lockedBy",
          locked_until AS "lockedUntil",
          claim_token AS "claimToken",
          last_error_code AS "lastErrorCode",
          last_error_category AS "lastErrorCategory",
          last_error_message AS "lastErrorMessage",
          last_error_retryable AS "lastErrorRetryable",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt",
          dead_lettered_at AS "deadLetteredAt"
      `;

      for (const row of terminalRows) {
        await this.insertDeadLetter(
          client,
          row,
          createSafeError({
            category: "internal",
            code: "CONTROL_PLANE_OUTBOX_STALE_MAX_ATTEMPTS",
            message: "Outbox event exhausted attempts after stale processing recovery.",
          }),
        );
      }

      const recovered = await client.$queryRaw<readonly { id: string }[]>`
        UPDATE outbox_events
        SET
          status = 'pending',
          locked_by = NULL,
          locked_until = NULL,
          claim_token = NULL,
          updated_at = now()
        WHERE status = 'processing'
          AND locked_until < now()
          AND attempts < max_attempts
        RETURNING id
      `;

      return terminalRows.length + recovered.length;
    });
  }

  private async insertDeadLetter(
    client: PrismaWriteClient,
    row: OutboxRow,
    safeError: SafeError,
  ): Promise<void> {
    await client.deadLetterEvent.upsert({
      create: {
        attempts: row.attempts,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        finalErrorJson: safeError,
        id: randomUUID(),
        outboxEventId: row.id,
        payloadSummary: {
          eventId: row.id,
          eventType: row.eventType,
          eventVersion: row.eventVersion,
        },
        ...(row.contentRefId === null ? {} : { contentRefId: row.contentRefId }),
      },
      update: {},
      where: {
        outboxEventId: row.id,
      },
    });
  }

  private async insertDeadLetterFromEvent(
    client: PrismaWriteClient,
    event: OutboxEvent,
    safeError: SafeError,
  ): Promise<void> {
    await client.deadLetterEvent.upsert({
      create: {
        attempts: event.attempts,
        eventType: event.type,
        eventVersion: event.version,
        finalErrorJson: safeError,
        id: randomUUID(),
        outboxEventId: event.id,
        payloadSummary: {
          eventId: event.id,
          eventType: event.type,
          eventVersion: event.version,
        },
        ...(event.contentRefId === undefined ? {} : { contentRefId: event.contentRefId }),
      },
      update: {},
      where: {
        outboxEventId: event.id,
      },
    });
  }
}

function claimWhere(input: CompleteOutboxEventInput) {
  return {
    claimToken: input.claimToken,
    id: input.eventId,
    lockedBy: input.workerId,
    status: "processing",
  } as const;
}

function isCompatibleDuplicate(existing: OutboxRow, event: NewOutboxEvent): boolean {
  return (
    existing.eventType === event.type &&
    existing.eventVersion === event.version &&
    existing.aggregateKind === (event.aggregateKind ?? null) &&
    existing.aggregateId === (event.aggregateId ?? null) &&
    existing.workspaceId === (event.workspaceId ?? null) &&
    isDeepStrictEqual(existing.payloadJson, event.payload) &&
    existing.contentRefId === (event.contentRefId ?? null) &&
    existing.contentIntegrityHash === (event.contentIntegrityHash ?? null)
  );
}

function mapClaimedRow(row: OutboxRow): ClaimedOutboxEvent {
  const event = mapRow(row);
  if (
    event.status !== "processing" ||
    event.lockedBy === undefined ||
    event.lockedUntilMs === undefined ||
    event.claimToken === undefined
  ) {
    throw new Error("Claimed outbox row did not include processing lock fields.");
  }
  return {
    ...event,
    claimToken: event.claimToken,
    lockedBy: event.lockedBy,
    lockedUntilMs: event.lockedUntilMs,
    status: "processing",
  };
}

function mapRow(row: OutboxRow): OutboxEvent {
  const id = parseOutboxEventId(row.id);
  if (!id.ok) {
    throw id.error;
  }
  const workspaceId =
    row.workspaceId === null || row.workspaceId === undefined
      ? undefined
      : parseWorkspaceId(row.workspaceId);
  if (workspaceId !== undefined && !workspaceId.ok) {
    throw workspaceId.error;
  }
  const contentRefId =
    row.contentRefId === null || row.contentRefId === undefined
      ? undefined
      : parseExternalActionContentId(row.contentRefId);
  if (contentRefId !== undefined && !contentRefId.ok) {
    throw contentRefId.error;
  }
  const lastSafeError =
    row.lastErrorCode === null ||
    row.lastErrorCode === undefined ||
    row.lastErrorCategory === null ||
    row.lastErrorCategory === undefined ||
    row.lastErrorMessage === null ||
    row.lastErrorMessage === undefined ||
    row.lastErrorRetryable === null ||
    row.lastErrorRetryable === undefined
      ? undefined
      : createSafeError({
          category: row.lastErrorCategory as SafeError["category"],
          code: row.lastErrorCode,
          message: row.lastErrorMessage,
          retryable: row.lastErrorRetryable,
        });

  return {
    attempts: row.attempts,
    createdAtMs: toUnixMilliseconds(row.createdAt.getTime()),
    id: id.value,
    idempotencyKey: row.idempotencyKey,
    maxAttempts: row.maxAttempts,
    nextAttemptAtMs: toUnixMilliseconds(row.nextAttemptAt.getTime()),
    payload: row.payloadJson as JsonObject,
    status: row.status as OutboxEventStatus,
    type: row.eventType,
    updatedAtMs: toUnixMilliseconds(row.updatedAt.getTime()),
    version: row.eventVersion,
    ...(row.aggregateId === null || row.aggregateId === undefined
      ? {}
      : { aggregateId: row.aggregateId }),
    ...(row.aggregateKind === null || row.aggregateKind === undefined
      ? {}
      : { aggregateKind: row.aggregateKind }),
    ...(row.claimToken === null || row.claimToken === undefined
      ? {}
      : { claimToken: row.claimToken }),
    ...(row.completedAt === null || row.completedAt === undefined
      ? {}
      : { completedAtMs: toUnixMilliseconds(row.completedAt.getTime()) }),
    ...(contentRefId === undefined ? {} : { contentRefId: contentRefId.value }),
    ...(row.contentIntegrityHash === null || row.contentIntegrityHash === undefined
      ? {}
      : { contentIntegrityHash: row.contentIntegrityHash }),
    ...(row.deadLetteredAt === null || row.deadLetteredAt === undefined
      ? {}
      : { deadLetteredAtMs: toUnixMilliseconds(row.deadLetteredAt.getTime()) }),
    ...(lastSafeError === undefined ? {} : { lastSafeError }),
    ...(row.lockedBy === null || row.lockedBy === undefined
      ? {}
      : { lockedBy: row.lockedBy }),
    ...(row.lockedUntil === null || row.lockedUntil === undefined
      ? {}
      : { lockedUntilMs: toUnixMilliseconds(row.lockedUntil.getTime()) }),
    ...(workspaceId === undefined ? {} : { workspaceId: workspaceId.value }),
  };
}
