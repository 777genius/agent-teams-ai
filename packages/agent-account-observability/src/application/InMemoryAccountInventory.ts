import type { AccountSlot } from "../domain/model";
import type { AccountInventoryPort } from "./ports";

export class InMemoryAccountInventory implements AccountInventoryPort {
  constructor(private readonly accounts: readonly AccountSlot[]) {}

  async listAccounts(input?: {
    readonly provider?: AccountSlot["provider"];
  }): Promise<readonly AccountSlot[]> {
    return input?.provider
      ? this.accounts.filter((account) => account.provider === input.provider)
      : this.accounts;
  }
}
