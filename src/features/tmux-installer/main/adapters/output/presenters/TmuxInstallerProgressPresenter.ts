import { TMUX_INSTALLER_PROGRESS } from '@features/tmux-installer/contracts';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';

import type { TmuxInstallerSnapshot } from '@features/tmux-installer/contracts';
import type { BrowserWindow } from 'electron';

export class TmuxInstallerProgressPresenter {
  #mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.#mainWindow = window;
  }

  present(snapshot: TmuxInstallerSnapshot): void {
    safeSendToRenderer(this.#mainWindow, TMUX_INSTALLER_PROGRESS, snapshot);
  }
}
