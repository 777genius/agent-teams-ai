import { ApplicationCommandRunner } from '../../core/application';
import { InternalStorageApplicationCommandLedgerStore } from '../adapters/output/InternalStorageApplicationCommandLedgerStore';
import { NodeApplicationCommandHasher } from '../adapters/output/NodeApplicationCommandHasher';

import type { ApplicationCommandLedgerStorageGateway } from '@features/internal-storage/core/application/ports';

export interface ApplicationCommandLedgerFeature {
  ledgerStore: InternalStorageApplicationCommandLedgerStore;
  runner: ApplicationCommandRunner;
}

export function createApplicationCommandLedgerFeature(input: {
  storageGateway: ApplicationCommandLedgerStorageGateway;
}): ApplicationCommandLedgerFeature {
  const ledgerStore = new InternalStorageApplicationCommandLedgerStore(input.storageGateway);
  return {
    ledgerStore,
    runner: new ApplicationCommandRunner({
      ledger: ledgerStore,
      hasher: new NodeApplicationCommandHasher(),
    }),
  };
}
