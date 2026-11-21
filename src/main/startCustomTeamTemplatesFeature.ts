/**
 * Custom-team-templates startup for the Electron main process.
 *
 * The composition root in `src/main/index.ts` is frozen by
 * `scripts/ci/check-source-file-size.mjs`, so this module owns the feature's
 * lifecycle instead: it composes the feature over the internal-storage worker
 * gateway, registers the IPC bridge and the desktop file channels, and returns
 * one disposer that undoes all of it.
 *
 * A missing worker bundle stays an explicit unavailable-storage result: the
 * feature is still composed, and its use cases answer `unavailableStorage`
 * rather than falling back to a second store.
 */
import {
  createCustomTeamTemplatesFeature,
  CustomTeamTemplateDesktopFileService,
  type CustomTeamTemplatesFeature,
  ElectronCustomTeamTemplateFileGateway,
  registerCustomTeamTemplatesFileIpc,
  registerCustomTeamTemplatesIpc,
  removeCustomTeamTemplatesFileIpc,
  removeCustomTeamTemplatesIpc,
} from '@features/custom-team-templates/main';
import { ipcMain } from 'electron';

import type { InternalStorageFeature } from '@features/internal-storage/main';

/** A composed feature whose disposal also tears down its IPC bridges. */
export type CustomTeamTemplatesStartup = Omit<CustomTeamTemplatesFeature, 'dispose'> & {
  /** Removes the IPC bridges and forgets every retained preview. */
  dispose(): void;
};

/**
 * Composes and starts the custom-team-templates feature for the main process.
 *
 * Side effects: registers the shared data IPC channels and the two desktop file
 * channels, and constructs the native file gateway. The returned `dispose()` is
 * idempotent from the caller's perspective: it removes every handler it
 * registered and disposes the composed feature exactly once. The SQLite backend
 * itself stays owned by internal-storage.
 */
export function startCustomTeamTemplatesFeature(
  internalStorage: InternalStorageFeature
): CustomTeamTemplatesStartup {
  const feature = createCustomTeamTemplatesFeature({
    backend: internalStorage.customTeamTemplatesBackend,
  });
  // The desktop file workflow reuses the composed use cases: the adapter only
  // adds native dialogs, bounded reads and atomic writes around them.
  const desktopFileService = new CustomTeamTemplateDesktopFileService({
    importTemplate: feature.importTemplate,
    exportTemplate: feature.exportTemplate,
    files: new ElectronCustomTeamTemplateFileGateway(),
  });
  registerCustomTeamTemplatesIpc(ipcMain, feature);
  registerCustomTeamTemplatesFileIpc(ipcMain, desktopFileService);
  return {
    ...feature,
    dispose: () => {
      removeCustomTeamTemplatesFileIpc(ipcMain);
      removeCustomTeamTemplatesIpc(ipcMain);
      feature.dispose();
    },
  };
}
