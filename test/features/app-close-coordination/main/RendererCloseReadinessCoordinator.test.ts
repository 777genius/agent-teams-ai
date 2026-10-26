import { EventEmitter } from 'node:events';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
  APP_CLOSE_READINESS_STARTED,
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
        failure: 'unresponsive',
        blockers: [expect.stringContaining('did not respond')],
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
    expect((ipcMain as unknown as EventEmitter).listenerCount(APP_CLOSE_READINESS_RESPONSE)).toBe(
      0
    );
  });
  it('allows acknowledged saves to finish beyond the interface response timeout', async () => {
    vi.useFakeTimers();
    try {
      const { ipcMain, sent, window, webContents } = createHarness();
      const coordinator = new RendererCloseReadinessCoordinator(ipcMain);
      const settled = vi.fn();
      const readiness = coordinator.request(window, 'app-quit', 100, undefined, 500).then(settled);
      const requestId = sent[0]!.payload.requestId;
      (ipcMain as unknown as EventEmitter).emit(
        APP_CLOSE_READINESS_STARTED,
        { sender: webContents },
        { requestId }
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).not.toHaveBeenCalled();
      (ipcMain as unknown as EventEmitter).emit(
        APP_CLOSE_READINESS_RESPONSE,
        { sender: webContents },
        { requestId, ok: true, blockers: [] }
      );
      await readiness;
      expect(settled).toHaveBeenCalledWith({ requestId, ok: true, blockers: [] });
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds saving time and reports a late result until its warning is released', async () => {
    vi.useFakeTimers();
    try {
      const { ipcMain, sent, window, webContents } = createHarness();
      const coordinator = new RendererCloseReadinessCoordinator(ipcMain);
      const late = vi.fn();
      const readiness = coordinator.request(window, 'app-quit', 100, late, 500);
      const requestId = sent[0]!.payload.requestId;
      const emitter = ipcMain as unknown as EventEmitter;
      emitter.emit(APP_CLOSE_READINESS_STARTED, { sender: webContents }, { requestId });
      await vi.advanceTimersByTimeAsync(500);
      await expect(readiness).resolves.toMatchObject({ ok: false, failure: 'save-timeout' });
      emitter.emit(APP_CLOSE_READINESS_RESPONSE, { sender: {} }, { requestId, ok: true });
      expect(late).not.toHaveBeenCalled();
      emitter.emit(
        APP_CLOSE_READINESS_RESPONSE,
        { sender: webContents },
        { requestId, ok: true, blockers: [] }
      );
      expect(late).toHaveBeenCalledWith({ requestId, ok: true, blockers: [] });
      coordinator.release(requestId);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
