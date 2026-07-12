import { BrowserWindow, dialog } from 'electron';

import type { TeamImportFolderPickerPort } from '../../core/application/ports/TeamImportFolderPickerPort';

export class ElectronTeamImportFolderPicker implements TeamImportFolderPickerPort {
  async chooseFolder(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Import Agent Team',
      buttonLabel: 'Review Team',
    };
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }
}
