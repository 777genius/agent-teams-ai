import { createApplicationCommandLedgerFeature as createFeature } from '@features/application-command-ledger/main';
import { NodeApplicationCommandHasher } from '@main/services/infrastructure/NodeApplicationCommandHasher';

import type { ApplicationCommandHasher } from '@features/application-command-ledger';

type ApplicationCommandLedgerCompositionInput = Omit<Parameters<typeof createFeature>[0], 'hasher'>;

export function createApplicationCommandHasher(): ApplicationCommandHasher {
  return new NodeApplicationCommandHasher();
}

export function createApplicationCommandLedgerFeature(
  input: ApplicationCommandLedgerCompositionInput
): ReturnType<typeof createFeature> {
  return createFeature({
    ...input,
    hasher: createApplicationCommandHasher(),
  });
}
