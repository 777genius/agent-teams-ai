import {
  createSafeError,
  isSafeError,
  toSafeError,
  type SafeError,
} from "@agent-teams-control-plane/shared";

import type {
  ClaimedOutboxEvent,
  OutboxRepository,
  RetryClaimMutationResult,
} from "../ports/outbox.repository.js";
import type { OutboxHandlerRegistry } from "../ports/outbox-handler.js";

export type ProcessOutboxBatchInput = Readonly<{
  batch: readonly ClaimedOutboxEvent[];
}>;

export type ProcessOutboxBatchResult = Readonly<{
  completed: number;
  retried: number;
  deadLettered: number;
  staleClaims: number;
}>;

export class ProcessOutboxBatchUseCase {
  public constructor(
    private readonly repository: OutboxRepository,
    private readonly handlers: OutboxHandlerRegistry,
  ) {}

  public async execute(
    input: ProcessOutboxBatchInput,
  ): Promise<ProcessOutboxBatchResult> {
    let completed = 0;
    let retried = 0;
    let deadLettered = 0;
    let staleClaims = 0;

    for (const event of input.batch) {
      const result = await this.processEvent(event);
      if (result === "completed") {
        completed += 1;
      } else if (result === "retried") {
        retried += 1;
      } else if (result === "dead-lettered") {
        deadLettered += 1;
      } else {
        staleClaims += 1;
      }
    }

    return { completed, deadLettered, retried, staleClaims };
  }

  private async processEvent(
    event: ClaimedOutboxEvent,
  ): Promise<"completed" | "retried" | "dead-lettered" | "stale-claim"> {
    const handler = this.handlers.getHandler({
      eventType: event.type,
      eventVersion: event.version,
    });

    if (handler === undefined) {
      const result = await this.repository.markDeadLettered({
        event,
        safeError: createSafeError({
          category: "validation",
          code: "CONTROL_PLANE_OUTBOX_UNKNOWN_EVENT_VERSION",
          message: "Outbox event type or version is not supported.",
          safeDetails: {
            eventType: event.type,
            eventVersion: event.version,
          },
        }),
      });
      return result === "updated" ? "dead-lettered" : "stale-claim";
    }

    try {
      const result = await handler.handle(event);
      if (result.kind === "completed") {
        return (await this.repository.markCompleted({
          claimToken: event.claimToken,
          eventId: event.id,
          workerId: event.lockedBy,
        })) === "updated"
          ? "completed"
          : "stale-claim";
      }
      if (result.kind === "retry") {
        return mapRetryMutationResult(
          await this.repository.markFailedForRetry({
            claimToken: event.claimToken,
            eventId: event.id,
            safeError: toSafeError(result.error),
            workerId: event.lockedBy,
          }),
        );
      }
      return (await this.repository.markDeadLettered({
        event,
        safeError: toSafeError(result.error),
      })) === "updated"
        ? "dead-lettered"
        : "stale-claim";
    } catch (error) {
      const safeError = toHandlerFailureSafeError(error);
      if (!safeError.retryable) {
        return (await this.repository.markDeadLettered({
          event,
          safeError,
        })) === "updated"
          ? "dead-lettered"
          : "stale-claim";
      }

      return mapRetryMutationResult(
        await this.repository.markFailedForRetry({
          claimToken: event.claimToken,
          eventId: event.id,
          safeError,
          workerId: event.lockedBy,
        }),
      );
    }
  }
}

function mapRetryMutationResult(
  result: RetryClaimMutationResult,
): "retried" | "dead-lettered" | "stale-claim" {
  if (result === "updated") {
    return "retried";
  }
  return result;
}

function toHandlerFailureSafeError(error: unknown): SafeError {
  if (isSafeError(error)) {
    return toSafeError(error);
  }

  return createSafeError({
    category: "internal",
    code: "CONTROL_PLANE_OUTBOX_HANDLER_FAILED",
    message: "Outbox handler failed.",
    retryable: true,
  });
}
