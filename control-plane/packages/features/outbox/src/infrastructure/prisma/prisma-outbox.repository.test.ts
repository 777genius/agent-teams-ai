import { describe, expect, it } from "vitest";

import { createSafeError, toUnixMilliseconds } from "@agent-teams-control-plane/shared";
import type { PrismaDatabaseClient } from "@agent-teams-control-plane/platform-database";

import type { ClaimedOutboxEvent } from "../../application/ports/outbox.repository.js";
import { PrismaOutboxRepository } from "./prisma-outbox.repository.js";

describe("PrismaOutboxRepository", () => {
  it("dead-letters claimed events in the same database transaction", async () => {
    const operations: string[] = [];
    const repository = new PrismaOutboxRepository(
      fakeDatabaseClient({
        $transaction: async (work: (client: unknown) => Promise<unknown>) => {
          operations.push("transaction:start");
          const result = await work({
            deadLetterEvent: {
              upsert: async () => {
                operations.push("dead-letter:upsert");
              },
            },
            outboxEvent: {
              updateMany: async () => {
                operations.push("outbox:update");
                return { count: 1 };
              },
            },
          });
          operations.push("transaction:commit");
          return result;
        },
      }),
    );

    await expect(
      repository.markDeadLettered({
        event: claimedEvent(),
        safeError: createSafeError({
          category: "validation",
          code: "TEST_TERMINAL",
          message: "terminal",
        }),
      }),
    ).resolves.toBe("updated");
    expect(operations).toEqual([
      "transaction:start",
      "outbox:update",
      "dead-letter:upsert",
      "transaction:commit",
    ]);
  });
});

function fakeDatabaseClient(client: unknown): PrismaDatabaseClient {
  return {
    getClient: () => client,
  } as unknown as PrismaDatabaseClient;
}

function claimedEvent(): ClaimedOutboxEvent {
  return {
    attempts: 1,
    claimToken: "claim-token",
    createdAtMs: toUnixMilliseconds(0),
    id: "event-1" as never,
    idempotencyKey: "workspace:event",
    lockedBy: "worker-1",
    lockedUntilMs: toUnixMilliseconds(1000),
    maxAttempts: 3,
    nextAttemptAtMs: toUnixMilliseconds(0),
    payload: {},
    status: "processing",
    type: "test.event",
    updatedAtMs: toUnixMilliseconds(0),
    version: 1,
  };
}
