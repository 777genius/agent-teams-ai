import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { REVIEW_FILE_CHANGE } from '@preload/constants/ipcChannels';

import type { EditorFileChangeEvent } from '@shared/types/editor';
import type { BrowserWindow } from 'electron';

export class ReviewFileWatchEventPresenter {
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  present(event: EditorFileChangeEvent): void {
    safeSendToRenderer(this.mainWindow, REVIEW_FILE_CHANGE, event);
  }
}
