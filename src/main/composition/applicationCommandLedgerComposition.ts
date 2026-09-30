import { createApplicationCommandLedgerFeature as createFeature } from '@features/application-command-ledger/main';
import { TaskBoardCommandFacade } from '@features/task-board-commands';
import { NodeApplicationCommandHasher } from '@main/services/infrastructure/NodeApplicationCommandHasher';

import type {
  ApplicationCommandHasher,
  ApplicationCommandRunner,
} from '@features/application-command-ledger';
import type { InternalStorageApplicationCommandLedgerBackend } from '@features/internal-storage/main';

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

export function createTaskBoardCommandComposition(
  backend: InternalStorageApplicationCommandLedgerBackend
): {
  runner: ApplicationCommandRunner;
  facade: TaskBoardCommandFacade;
} {
  const hasher = createApplicationCommandHasher();
  const feature = createFeature({ storageGateway: backend.gateway, hasher });
  return {
    runner: feature.runner,
    facade: new TaskBoardCommandFacade(feature.runner, {
      isDurableStorageAvailable: () => backend.selector.select(true, false),
      hashPayload: (payload) => hasher.hashJson(payload),
    }),
  };
}
