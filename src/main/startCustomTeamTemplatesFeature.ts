/**
 * Custom-team-templates startup for the Electron main process.
 *
 * The composition root in `src/main/index.ts` is frozen by
 * `scripts/ci/check-source-file-size.mjs`, so this module owns the feature's
 * lifecycle instead: it composes the feature over the internal-storage worker
 * gateway, registers the IPC bridge, and returns one disposer that undoes both.
 *
 * A missing worker bundle stays an explicit unavailable-storage result: the
 * feature is still composed, and its use cases answer `unavailableStorage`
 * rather than falling back to a second store.
 */
import {
  createCustomTeamTemplatesFeature,
  type CustomTeamTemplatesFeature,
  registerCustomTeamTemplatesIpc,
  removeCustomTeamTemplatesIpc,
} from '@features/custom-team-templates/main';
import { ipcMain } from 'electron';

import type { InternalStorageFeature } from '@features/internal-storage/main';

/** A composed feature whose disposal also tears down its IPC bridge. */
export type CustomTeamTemplatesStartup = Omit<CustomTeamTemplatesFeature, 'dispose'> & {
  /** Removes the IPC bridge and forgets every retained preview. */
  dispose(): void;
};

export function startCustomTeamTemplatesFeature(
  internalStorage: InternalStorageFeature
): CustomTeamTemplatesStartup {
  const feature = createCustomTeamTemplatesFeature({
    backend: internalStorage.customTeamTemplatesBackend,
  });
  registerCustomTeamTemplatesIpc(ipcMain, feature);
  return {
    ...feature,
    dispose: () => {
      removeCustomTeamTemplatesIpc(ipcMain);
      feature.dispose();
    },
  };
}
