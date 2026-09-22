import {
  TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW,
  TEAM_IMPORT_CREATE_DRAFT,
} from '@features/team-import/contracts';

import type { TeamImportApi } from '@features/team-import/contracts';
import type { IpcRenderer } from 'electron';

export function createTeamImportBridge(ipcRenderer: IpcRenderer): TeamImportApi {
  return {
    chooseFolderAndPreview: () => ipcRenderer.invoke(TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW),
    createDraft: (request) => ipcRenderer.invoke(TEAM_IMPORT_CREATE_DRAFT, request),
  };
}
