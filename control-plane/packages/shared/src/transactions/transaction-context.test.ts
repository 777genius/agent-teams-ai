import { describe, expect, it } from "vitest";

import type { TransactionContext } from "./transaction-context.js";

describe("TransactionContext", () => {
  it("keeps the public runtime shape minimal", () => {
    const context = { transactionId: "tx-1" } as TransactionContext;

    expect(context.transactionId).toBe("tx-1");
  });
});

function acceptsTransactionContext(_context: TransactionContext): void {
  void _context;
  return undefined;
}

function assertTransactionContextIsOpaque(): void {
  // @ts-expect-error TransactionContext must not be structurally constructible.
  acceptsTransactionContext({ transactionId: "tx-1" });
}

void assertTransactionContextIsOpaque;
