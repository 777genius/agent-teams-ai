import { EventEmitter } from 'node:events';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
  APP_CLOSE_UI_MOUNT_REQUEST,
} from '@features/app-close-coordination/contracts';
import { createAppCloseCoordinationBridge } from '@features/app-close-coordination/preload';
import { describe, expect, it, vi } from 'vitest';

import type { AppCloseReadinessRequest } from '@features/app-close-coordination/contracts';
import type { IpcRenderer } from 'electron';

function createIpcRenderer() {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const invoke = vi.fn().mockResolvedValue(true);
  const ipcRenderer = {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      emitter.on(channel, listener);
      return ipcRenderer;
    },
    send,
    invoke,
  } as unknown as IpcRenderer;
  return { emitter, ipcRenderer, send, invoke };
}

const request: AppCloseReadinessRequest = {
  requestId: 'request-1',
  reason: 'window-close',
  deadlineAt: Date.now() + 5_000,
};

describe('createAppCloseCoordinationBridge', () => {
  it('requires exact mount permission through the finite no-payload IPC', async () => {
    const { ipcRenderer, invoke } = createIpcRenderer();
    const bridge = createAppCloseCoordinationBridge(ipcRenderer);
    await expect(bridge.requestUiMount()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(APP_CLOSE_UI_MOUNT_REQUEST);
    invoke.mockResolvedValueOnce('true');
    await expect(bridge.requestUiMount()).resolves.toBe(false);
  });

  it('does not fabricate mount permission when the Main request fails', async () => {
    const { ipcRenderer, invoke } = createIpcRenderer();
    invoke.mockRejectedValueOnce(new Error('closed admission'));
    const bridge = createAppCloseCoordinationBridge(ipcRenderer);
    await expect(bridge.requestUiMount()).rejects.toThrow('closed admission');
  });

  it('responds ready before the React registry mounts', async () => {
    const { emitter, ipcRenderer, send } = createIpcRenderer();
    createAppCloseCoordinationBridge(ipcRenderer);

    emitter.emit(APP_CLOSE_READINESS_REQUEST, {}, request);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(APP_CLOSE_READINESS_RESPONSE, {
        requestId: request.requestId,
        ok: true,
        blockers: [],
        uiHandlerObserved: false,
      });
    });
  });

  it('maps renderer failures to a bounded response and unregisters safely', async () => {
    const { emitter, ipcRenderer, send } = createIpcRenderer();
    const bridge = createAppCloseCoordinationBridge(ipcRenderer);
    const cleanup = bridge.onReadinessRequest(async () => ({
      ok: false,
      blockers: ['  decision save failed  '],
    }));

    emitter.emit(APP_CLOSE_READINESS_REQUEST, {}, request);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(APP_CLOSE_READINESS_RESPONSE, {
        requestId: request.requestId,
        ok: false,
        blockers: ['decision save failed'],
        uiHandlerObserved: true,
      });
    });

    cleanup();
  });

  it('reports a thrown participant failure instead of losing the close response', async () => {
    const { emitter, ipcRenderer, send } = createIpcRenderer();
    const bridge = createAppCloseCoordinationBridge(ipcRenderer);
    bridge.onReadinessRequest(async () => {
      throw new Error('fsync failed');
    });

    emitter.emit(APP_CLOSE_READINESS_REQUEST, {}, request);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(APP_CLOSE_READINESS_RESPONSE, {
        requestId: request.requestId,
        ok: false,
        blockers: ['fsync failed'],
        uiHandlerObserved: true,
      });
    });
  });

  it('does not let stale cleanup unregister a newer readiness handler', async () => {
    const { emitter, ipcRenderer, send } = createIpcRenderer();
    const bridge = createAppCloseCoordinationBridge(ipcRenderer);
    const removeOld = bridge.onReadinessRequest(async () => ({
      ok: false,
      blockers: ['stale'],
    }));
    bridge.onReadinessRequest(async () => ({ ok: true, blockers: [] }));

    removeOld();
    emitter.emit(APP_CLOSE_READINESS_REQUEST, {}, request);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(APP_CLOSE_READINESS_RESPONSE, {
        requestId: request.requestId,
        ok: true,
        blockers: [],
        uiHandlerObserved: true,
      });
    });
  });
});
