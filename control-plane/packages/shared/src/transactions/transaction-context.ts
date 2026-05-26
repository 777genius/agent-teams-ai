declare const transactionContextBrand: unique symbol;

export type TransactionContext = Readonly<{
  transactionId: string;
  readonly [transactionContextBrand]: "TransactionContext";
}>;
