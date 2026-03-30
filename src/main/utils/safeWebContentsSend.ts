import { createLogger } from '@shared/utils/logger';

import type { BrowserWindow } from 'electron';

const logger = createLogger('safeWebContentsSend');
const rendererAvailability = new WeakMap<BrowserWindow, boolean>();

export function markRendererReady(window: BrowserWindow | null | undefined): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  rendererAvailability.set(window, true);
}

export function markRendererUnavailable(window: BrowserWindow | null | undefined): void {
  if (!window) {
    return;
  }
  rendererAvailability.set(window, false);
}

export function clearRendererAvailability(window: BrowserWindow | null | undefined): void {
  if (!window) {
    return;
  }
  rendererAvailability.delete(window);
}

export function safeSendToRenderer(
  window: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }

  const contents = window.webContents;
  if (!contents || contents.isDestroyed()) {
    return false;
  }
  if (rendererAvailability.get(window) === false) {
    return false;
  }

  try {
    contents.send(channel, ...args);
    return true;
  } catch (error) {
    rendererAvailability.set(window, false);
    logger.warn(`Failed to send "${channel}" to renderer: ${String(error)}`);
    return false;
  }
}
