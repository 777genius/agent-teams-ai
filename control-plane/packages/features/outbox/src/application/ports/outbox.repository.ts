import type { OutboxEvent, NewOutboxEvent } from "../../domain/outbox-event.js";
import type { SafeError } from "@agent-teams-control-plane/shared";
import type { TransactionContext } from "./transaction-context.js";

export type ClaimOutboxBatchInput = Readonly<{
  batchSize: number;
  leaseSeconds: number;
  workerId: string;
}>;

export type ClaimedOutboxEvent = OutboxEvent &
  Readonly<{
    status: "processing";
    lockedBy: string;
    lockedUntilMs: number;
    claimToken: string;
  }>;

export type CompleteOutboxEventInput = Readonly<{
  eventId: OutboxEvent["id"];
  workerId: string;
  claimToken: string;
}>;

export type RetryOutboxEventInput = Readonly<{
  eventId: OutboxEvent["id"];
  workerId: string;
  claimToken: string;
  safeError: SafeError;
}>;

export type DeadLetterOutboxEventInput = Readonly<{
  event: ClaimedOutboxEvent;
  safeError: SafeError;
}>;

export type RecoverStaleOutboxInput = Readonly<{
  workerId: string;
}>;

export type ClaimMutationResult = "updated" | "stale-claim";
export type RetryClaimMutationResult = ClaimMutationResult | "dead-lettered";

export interface OutboxRepository {
  append(event: NewOutboxEvent, context: TransactionContext): Promise<OutboxEvent>;
  claimNextBatch(input: ClaimOutboxBatchInput): Promise<readonly ClaimedOutboxEvent[]>;
  markCompleted(input: CompleteOutboxEventInput): Promise<ClaimMutationResult>;
  markFailedForRetry(input: RetryOutboxEventInput): Promise<RetryClaimMutationResult>;
  markDeadLettered(input: DeadLetterOutboxEventInput): Promise<ClaimMutationResult>;
  recoverStaleProcessing(input: RecoverStaleOutboxInput): Promise<number>;
}
