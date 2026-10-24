import { randomUUID } from 'node:crypto';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
  APP_CLOSE_UI_MOUNT_REQUEST,
  type AppCloseReadinessRequest,
  type AppCloseReadinessResponse,
  type AppCloseReadinessResult,
  type AppCloseReason,
} from '../contracts';

import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from 'electron';

interface PendingReadinessRequest {
  sender: WebContents;
  resolve: (result: AppCloseReadinessResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const normalizeResponse = (
  requestId: string,
  response: unknown
): AppCloseReadinessResult | null => {
  if (!response || typeof response !== 'object') return null;
  const value = response as Partial<AppCloseReadinessResponse>;
  if (value.requestId !== requestId || typeof value.ok !== 'boolean') return null;
  if (value.ok && value.uiHandlerObserved !== true) {
    return {
      requestId,
      ok: false,
      blockers: ['Changes close readiness is not initialized for this renderer.'],
    };
  }

  const blockers = Array.isArray(value.blockers)
    ? value.blockers
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 500))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  return { requestId, ok: value.ok, blockers };
};

export class RendererCloseReadinessCoordinator {
  // Monotonic for the lifetime of this WebContents: renderer loss/reload never
  // converts potentially unsaved editor state back into a safe startup splash.
  private readonly mounted = new WeakSet<WebContents>();
  private readonly closedBeforeMount = new WeakSet<WebContents>();
  private readonly mountListener = (event: IpcMainInvokeEvent, ...payload: unknown[]): boolean => {
    if (payload.length !== 0) return false;
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false;
    if (this.closedBeforeMount.has(event.sender)) return false;
    this.mounted.add(event.sender);
    return true;
  };

  private readonly pending = new Map<string, PendingReadinessRequest>();

  private readonly responseListener = (event: IpcMainEvent, response: unknown): void => {
    if (!response || typeof response !== 'object') return;
    const requestId = (response as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string') return;
    const pending = this.pending.get(requestId);
    if (pending?.sender !== event.sender) return;
    const normalized = normalizeResponse(requestId, response);
    if (!normalized) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(normalized);
  };

  constructor(private readonly ipcMain: IpcMain) {
    ipcMain.on(APP_CLOSE_READINESS_RESPONSE, this.responseListener);
    ipcMain.handle(APP_CLOSE_UI_MOUNT_REQUEST, this.mountListener);
  }

  request(
    window: BrowserWindow,
    reason: AppCloseReason,
    timeoutMs = 5_000
  ): Promise<AppCloseReadinessResult> {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve({ requestId: '', ok: true, blockers: [] });
    }

    if (!this.mounted.has(window.webContents)) {
      // Atomically close future mount admission before accepting this close.
      this.closedBeforeMount.add(window.webContents);
      return Promise.resolve({ requestId: '', ok: true, blockers: [] });
    }

    const requestId = randomUUID();
    const request: AppCloseReadinessRequest = {
      requestId,
      reason,
      deadlineAt: Date.now() + timeoutMs,
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          requestId,
          ok: false,
          blockers: ['Changes did not finish saving before the close timeout.'],
        });
      }, timeoutMs);
      this.pending.set(requestId, { sender: window.webContents, resolve, timer });
      try {
        window.webContents.send(APP_CLOSE_READINESS_REQUEST, request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({
          requestId,
          ok: false,
          blockers: [
            `Unable to ask Changes to save: ${error instanceof Error ? error.message : String(error)}`,
          ],
        });
      }
    });
  }

  dispose(): void {
    this.ipcMain.removeListener(APP_CLOSE_READINESS_RESPONSE, this.responseListener);
    this.ipcMain.removeHandler(APP_CLOSE_UI_MOUNT_REQUEST);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        ok: false,
        blockers: ['App close coordination stopped before Changes finished saving.'],
      });
    }
    this.pending.clear();
  }
}
