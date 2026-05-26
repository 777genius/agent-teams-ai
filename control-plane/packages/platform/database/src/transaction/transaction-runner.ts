import { randomUUID } from "node:crypto";

import type { TransactionContext } from "@agent-teams-control-plane/shared";

import type {
  PrismaDatabaseClient,
  PrismaTransactionClientLike,
} from "../prisma/prisma-database-client.js";

export type { TransactionContext } from "@agent-teams-control-plane/shared";

export interface TransactionRunner {
  runInTransaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}

const prismaTransactionContextBrand = Symbol("prismaTransactionContext");

type PrismaTransactionContext = TransactionContext & {
  readonly [prismaTransactionContextBrand]: {
    active: boolean;
    client: PrismaTransactionClientLike;
  };
};

export class PrismaTransactionRunner implements TransactionRunner {
  public constructor(private readonly databaseClient: PrismaDatabaseClient) {}

  public async runInTransaction<T>(
    work: (context: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.databaseClient.getClient().$transaction(async (client) => {
      const context = createPrismaTransactionContext(client);
      try {
        return await work(context);
      } finally {
        context[prismaTransactionContextBrand].active = false;
      }
    });
  }
}

export function getPrismaTransactionClient(
  context: TransactionContext,
): PrismaTransactionClientLike {
  if (!isPrismaTransactionContext(context)) {
    throw new Error("TransactionContext was not created by PrismaTransactionRunner.");
  }
  if (!context[prismaTransactionContextBrand].active) {
    throw new Error("TransactionContext cannot be reused after commit or rollback.");
  }
  return context[prismaTransactionContextBrand].client;
}

export function isPrismaTransactionContext(
  context: TransactionContext,
): context is PrismaTransactionContext {
  return (
    typeof context === "object" &&
    context !== null &&
    prismaTransactionContextBrand in context
  );
}

function createPrismaTransactionContext(
  client: PrismaTransactionClientLike,
): PrismaTransactionContext {
  return {
    [prismaTransactionContextBrand]: {
      active: true,
      client,
    },
    transactionId: randomUUID(),
  } as PrismaTransactionContext;
}
