import { EventEmitter } from 'node:events';

import {
  APP_CLOSE_READINESS_RESPONSE,
  APP_CLOSE_READINESS_STARTED,
  APP_CLOSE_UI_MOUNT_REQUEST,
} from '@features/app-close-coordination/contracts';
import {
  RendererCloseReadinessCoordinator,
  requestCloseReadiness,
} from '@features/app-close-coordination/main';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserWindow, Dialog, IpcMain } from 'electron';

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = Object.assign(new EventEmitter(), {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  });
  let requestId = '';
  const frame = {};
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (_channel: string, request: { requestId: string }) => {
      requestId = request.requestId;
    },
  };
  const window = {
    isDestroyed: () => false,
    webContents: sender,
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow;
  const coordinator = new RendererCloseReadinessCoordinator(ipc as unknown as IpcMain);
  handlers.get(APP_CLOSE_UI_MOUNT_REQUEST)?.({ sender, senderFrame: frame });
  const reply = (ok: boolean) =>
    ipc.emit(
      APP_CLOSE_READINESS_RESPONSE,
      { sender },
      { requestId, ok, blockers: ok ? [] : ['Disk write failed.'], uiHandlerObserved: true }
    );
  const started = () => ipc.emit(APP_CLOSE_READINESS_STARTED, { sender }, { requestId });
  return { coordinator, window, reply, started };
}

describe('requestCloseReadiness', () => {
  it('does not warn for a responsive clean window', async () => {
    const { coordinator, window, reply } = harness();
    const showMessageBox = vi.fn();
    const close = requestCloseReadiness(coordinator, [window], 'app-quit', 'Quit Anyway', {
      showMessageBox,
    } as unknown as Dialog);
    reply(true);
    await expect(close).resolves.toBe(true);
    expect(showMessageBox).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('dismisses the timeout warning when the late save succeeds', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, window, reply, started } = harness();
      const showMessageBox = vi.fn(
        (_parent, options) =>
          new Promise((resolve) => {
            options.signal.addEventListener('abort', () => resolve({ response: 0 }));
          })
      );
      const close = requestCloseReadiness(coordinator, [window], 'app-quit', 'Quit Anyway', {
        showMessageBox,
      } as unknown as Dialog);
      started();
      await vi.advanceTimersByTimeAsync(35_000);
      expect(showMessageBox).toHaveBeenCalledOnce();
      reply(true);
      await expect(close).resolves.toBe(true);
      expect(showMessageBox.mock.calls[0]![1].signal.aborted).toBe(true);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an actual save failure open when the user cancels', async () => {
    const { coordinator, window, reply } = harness();
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
    const close = requestCloseReadiness(coordinator, [window], 'app-quit', 'Quit Anyway', {
      showMessageBox,
    } as unknown as Dialog);
    reply(false);
    await expect(close).resolves.toBe(false);
    expect(showMessageBox.mock.calls[0]![1].detail).toContain('Disk write failed.');
    coordinator.dispose();
  });
});
