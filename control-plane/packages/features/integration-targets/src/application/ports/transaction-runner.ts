import type { TransactionContext } from "@agent-teams-control-plane/shared";

export type { TransactionContext } from "@agent-teams-control-plane/shared";

export interface TransactionRunner {
  runInTransaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}
