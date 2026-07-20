import { ApplicationCommandRunner } from '../../core/application';
import { createCommandDescriptorRegistry } from '../../core/domain';
import { InternalStorageApplicationCommandLedgerStore } from '../adapters/output/InternalStorageApplicationCommandLedgerStore';
import { NodeApplicationCommandHasher } from '../adapters/output/NodeApplicationCommandHasher';

import type { CommandDescriptor } from '../../contracts';
import type {
  ApplicationCommandLedgerStorageGateway,
  DurableApplicationCommandLedgerStorageGateway,
} from '../../core/application';
import type { CommandDescriptorRegistry } from '../../core/domain';

export interface ApplicationCommandLedgerFeature {
  descriptorRegistry?: CommandDescriptorRegistry | null;
  ledgerStore: InternalStorageApplicationCommandLedgerStore;
  runner: ApplicationCommandRunner;
}

export function createApplicationCommandLedgerFeature(input: {
  storageGateway: ApplicationCommandLedgerStorageGateway &
    Partial<DurableApplicationCommandLedgerStorageGateway>;
  /**
   * Additive durable-command registry. Existing desktop composition may omit
   * it and keeps the legacy ledger surface; durable methods then fail closed.
   */
  commandDescriptors?: readonly CommandDescriptor[];
}): ApplicationCommandLedgerFeature {
  const descriptorRegistry = input.commandDescriptors
    ? createCommandDescriptorRegistry(input.commandDescriptors)
    : null;
  const ledgerStore = new InternalStorageApplicationCommandLedgerStore(
    input.storageGateway,
    descriptorRegistry
  );
  return {
    descriptorRegistry,
    ledgerStore,
    runner: new ApplicationCommandRunner({
      ledger: ledgerStore,
      hasher: new NodeApplicationCommandHasher(),
    }),
  };
}
