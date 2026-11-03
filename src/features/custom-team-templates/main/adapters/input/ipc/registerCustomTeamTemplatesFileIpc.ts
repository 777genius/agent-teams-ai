import { CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS } from '../../../../contracts';

import type { CustomTeamTemplateDesktopFileService } from '../../../services/CustomTeamTemplateDesktopFileService';
import type { IpcMain } from 'electron';

/**
 * Registers the desktop-only native file channels.
 *
 * These are separate from the shared data channels because only the Electron
 * main process can show native dialogs and touch the filesystem. `importFromFile`
 * accepts no arguments at all; `exportToFile` accepts only a saved template id.
 * No handler accepts, returns or echoes a filesystem path, so a compromised
 * renderer cannot aim a privileged read or write at an arbitrary location.
 */
export function registerCustomTeamTemplatesFileIpc(
  ipcMain: IpcMain,
  service: CustomTeamTemplateDesktopFileService
): void {
  ipcMain.handle(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile, () => service.importFromFile());
  ipcMain.handle(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.exportToFile, (_event, request: unknown) =>
    service.exportToFile(request)
  );
}

/** Removes every desktop file handler on shutdown. */
export function removeCustomTeamTemplatesFileIpc(ipcMain: IpcMain): void {
  for (const channel of Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
}
