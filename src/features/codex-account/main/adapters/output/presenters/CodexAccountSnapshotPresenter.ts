import {
  CODEX_ACCOUNT_SNAPSHOT_CHANGED,
  type CodexAccountSnapshotDto,
} from '@features/codex-account/contracts';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';

import type { BrowserWindow } from 'electron';

export class CodexAccountSnapshotPresenter {
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  publish(snapshot: CodexAccountSnapshotDto): void {
    safeSendToRenderer(this.mainWindow, CODEX_ACCOUNT_SNAPSHOT_CHANGED, snapshot);
  }
}
