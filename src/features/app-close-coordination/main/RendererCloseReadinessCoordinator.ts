import { randomUUID } from 'node:crypto';

import {
  APP_CLOSE_READINESS_REQUEST,
  APP_CLOSE_READINESS_RESPONSE,
  type AppCloseReadinessRequest,
  type AppCloseReadinessResult,
  type AppCloseReason,
} from '../contracts';

import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron';

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
  const value = response as Partial<AppCloseReadinessResult>;
  if (value.requestId !== requestId || typeof value.ok !== 'boolean') return null;
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
  }

  request(
    window: BrowserWindow,
    reason: AppCloseReason,
    timeoutMs = 5_000
  ): Promise<AppCloseReadinessResult> {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
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
