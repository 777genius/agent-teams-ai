import { createIpcWrapper } from '@main/ipc/ipcWrapper';

import { DOCUMENT_PREVIEW_READ } from '../contracts';

import { readDocumentPreview } from './infrastructure/readDocumentPreview';
import { registerViewerProtocol, removeViewerProtocol } from './infrastructure/viewerProtocol';

import type { IpcMain } from 'electron';

export function registerDocumentPreviewHandlers(
  ipc: IpcMain,
  getProjectRoot: () => string | null
): void {
  registerViewerProtocol();
  const wrap = createIpcWrapper('IPC:documentPreview');
  ipc.handle(DOCUMENT_PREVIEW_READ, (_event, input: unknown) =>
    wrap('read', async () => {
      const projectRoot = getProjectRoot();
      if (!projectRoot) throw new Error('Editor not initialized');
      const result = await readDocumentPreview(projectRoot, input);
      if (projectRoot !== getProjectRoot()) throw new Error('Editor project changed during read');
      return result;
    })
  );
}

export function removeDocumentPreviewHandlers(ipc: IpcMain): void {
  ipc.removeHandler(DOCUMENT_PREVIEW_READ);
  removeViewerProtocol();
}
