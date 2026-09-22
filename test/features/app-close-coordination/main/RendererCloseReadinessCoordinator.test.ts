import { EventEmitter } from 'node:events';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
} from '@features/app-close-coordination/contracts';
import { RendererCloseReadinessCoordinator } from '@features/app-close-coordination/main';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserWindow, IpcMain, WebContents } from 'electron';

function createHarness() {
  const ipcMain = new EventEmitter() as unknown as IpcMain;
  const sent: Array<{ channel: string; payload: { requestId: string } }> = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: { requestId: string }) => sent.push({ channel, payload }),
  } as unknown as WebContents;
  const window = {
    isDestroyed: () => false,
    webContents,
  } as unknown as BrowserWindow;
  return { ipcMain, sent, webContents, window };
}

describe('RendererCloseReadinessCoordinator', () => {
  it('accepts only the matching renderer response and normalizes blockers', async () => {
    const { ipcMain, sent, webContents, window } = createHarness();
    const coordinator = new RendererCloseReadinessCoordinator(ipcMain);
    const readiness = coordinator.request(window, 'window-close');
    const requestId = sent[0]?.payload.requestId;

    expect(sent[0]?.channel).toBe(APP_CLOSE_READINESS_REQUEST);
    expect(requestId).toBeTruthy();
    (ipcMain as unknown as EventEmitter).emit(
      APP_CLOSE_READINESS_RESPONSE,
      { sender: webContents },
      { requestId, ok: false, blockers: ['  disk full  ', 42] }
    );

    await expect(readiness).resolves.toEqual({
      requestId,
      ok: false,
      blockers: ['disk full'],
    });
    coordinator.dispose();
  });

  it('times out instead of trusting a response from another renderer', async () => {
    vi.useFakeTimers();
    try {
      const { ipcMain, sent, window } = createHarness();
      const coordinator = new RendererCloseReadinessCoordinator(ipcMain);
      const readiness = coordinator.request(window, 'app-quit', 100);
      const requestId = sent[0]?.payload.requestId;
      (ipcMain as unknown as EventEmitter).emit(
        APP_CLOSE_READINESS_RESPONSE,
        { sender: {} },
        { requestId, ok: true, blockers: [] }
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(readiness).resolves.toMatchObject({
        requestId,
        ok: false,
        blockers: [expect.stringContaining('timeout')],
      });
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps close blocked when sending the readiness request fails', async () => {
    const { ipcMain, window } = createHarness();
    vi.spyOn(window.webContents, 'send').mockImplementation(() => {
      throw new Error('renderer unavailable');
    });
    const coordinator = new RendererCloseReadinessCoordinator(ipcMain);

    await expect(coordinator.request(window, 'window-close')).resolves.toMatchObject({
      ok: false,
      blockers: [expect.stringContaining('renderer unavailable')],
    });
    coordinator.dispose();
  });

  it('resolves pending requests as blocked when coordination is disposed', async () => {
    const { ipcMain, sent, window } = createHarness();
    const coordinator = new RendererCloseReadinessCoordinator(ipcMain);
    const readiness = coordinator.request(window, 'app-quit');

    coordinator.dispose();

    await expect(readiness).resolves.toEqual({
      requestId: sent[0]?.payload.requestId,
      ok: false,
      blockers: ['App close coordination stopped before Changes finished saving.'],
    });
    expect(
      (ipcMain as unknown as EventEmitter).listenerCount(APP_CLOSE_READINESS_RESPONSE)
    ).toBe(0);
  });
});
