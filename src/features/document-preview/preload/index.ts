import { ipcRenderer } from 'electron';

import { DOCUMENT_PREVIEW_READ } from '../contracts';

import type { DocumentPreviewAPI, DocumentPreviewResult } from '../contracts';
import type { IpcResult } from '@shared/types/ipc';

export function createDocumentPreviewBridge(): DocumentPreviewAPI {
  return {
    readDocumentPreview: async (filePath) => {
      const result = (await ipcRenderer.invoke(
        DOCUMENT_PREVIEW_READ,
        filePath
      )) as IpcResult<DocumentPreviewResult>;
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Document preview read failed');
      return result.data;
    },
  };
}
