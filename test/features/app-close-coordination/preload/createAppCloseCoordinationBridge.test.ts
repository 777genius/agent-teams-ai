import { EventEmitter } from 'node:events';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
} from '@features/app-close-coordination/contracts';
import { createAppCloseCoordinationBridge } from '@features/app-close-coordination/preload';
import { describe, expect, it, vi } from 'vitest';

import type { AppCloseReadinessRequest } from '@features/app-close-coordination/contracts';
import type { IpcRenderer } from 'electron';

function createIpcRenderer() {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const ipcRenderer = {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      emitter.on(channel, listener);
      return ipcRenderer;
    },
    send,
  } as unknown as IpcRenderer;
  return { emitter, ipcRenderer, send };
}

const request: AppCloseReadinessRequest = {
  requestId: 'request-1',
  reason: 'window-close',
  deadlineAt: Date.now() + 5_000,
};

describe('createAppCloseCoordinationBridge', () => {
  it('responds ready before the React registry mounts', async () => {
    const { emitter, ipcRenderer, send } = createIpcRenderer();
    createAppCloseCoordinationBridge(ipcRenderer);

    emitter.emit(APP_CLOSE_READINESS_REQUEST, {}, request);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(APP_CLOSE_READINESS_RESPONSE, {
        requestId: request.requestId,
        ok: true,
        blockers: [],
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
      });
    });
  });
});
