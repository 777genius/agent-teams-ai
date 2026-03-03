import { RENDERER_BOOT, RENDERER_HEARTBEAT, RENDERER_LOG } from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';
import { type IpcMain } from 'electron';

const logger = createLogger('IPC:rendererLogs');

type RendererLogLevel = 'warn' | 'error';

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(truncated)`;
}

function isRendererLogPayload(
  payload: unknown
): payload is { level: RendererLogLevel; message: string } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as { level?: unknown; message?: unknown };
  return (p.level === 'warn' || p.level === 'error') && typeof p.message === 'string';
}

const lastHeartbeatByWebContentsId = new Map<number, number>();
const lastHeartbeatWarnedAtByWebContentsId = new Map<number, number>();
const hasReceivedHeartbeatByWebContentsId = new Set<number>();
let heartbeatMonitorStarted = false;
let heartbeatMonitorInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeatMonitor(): void {
  if (heartbeatMonitorStarted) return;
  heartbeatMonitorStarted = true;

  const CHECK_EVERY_MS = 1500;
  const STALE_AFTER_MS = 5000;
  const WARN_THROTTLE_MS = 10_000;

  heartbeatMonitorInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, last] of lastHeartbeatByWebContentsId.entries()) {
      if (!hasReceivedHeartbeatByWebContentsId.has(id)) {
        // Don't warn "stale" if we never saw a heartbeat — that likely indicates the
        // heartbeat channel isn't wired (or the window reloaded) rather than a stall.
        continue;
      }
      const age = now - last;
      if (age < STALE_AFTER_MS) continue;
      const lastWarnedAt = lastHeartbeatWarnedAtByWebContentsId.get(id) ?? 0;
      if (now - lastWarnedAt < WARN_THROTTLE_MS) continue;
      lastHeartbeatWarnedAtByWebContentsId.set(id, now);
      logger.warn(`Renderer heartbeat stale webContentsId=${id} ageMs=${age}`);
    }
  }, CHECK_EVERY_MS);

  // Diagnostics-only: should not keep the app alive.
  heartbeatMonitorInterval.unref();
}

export function registerRendererLogHandlers(ipcMain: IpcMain): void {
  startHeartbeatMonitor();

  ipcMain.on(RENDERER_LOG, (_event, payload: unknown) => {
    if (!isRendererLogPayload(payload)) return;
    const msg = truncate(payload.message, 4000);
    if (payload.level === 'error') {
      logger.error(`Renderer: ${msg}`);
    } else {
      logger.warn(`Renderer: ${msg}`);
    }
  });

  ipcMain.on(RENDERER_BOOT, (event) => {
    const id = event.sender.id;
    lastHeartbeatByWebContentsId.set(id, Date.now());
    lastHeartbeatWarnedAtByWebContentsId.delete(id);
    hasReceivedHeartbeatByWebContentsId.delete(id);
    logger.warn(`Renderer boot webContentsId=${id}`);
    event.sender.once('destroyed', () => {
      lastHeartbeatByWebContentsId.delete(id);
      lastHeartbeatWarnedAtByWebContentsId.delete(id);
      hasReceivedHeartbeatByWebContentsId.delete(id);
    });
  });

  ipcMain.on(RENDERER_HEARTBEAT, (event) => {
    const id = event.sender.id;
    const isFirst = !hasReceivedHeartbeatByWebContentsId.has(id);
    hasReceivedHeartbeatByWebContentsId.add(id);
    lastHeartbeatByWebContentsId.set(id, Date.now());
    if (isFirst) {
      logger.warn(`Renderer heartbeat started webContentsId=${id}`);
    }
  });
}

export function removeRendererLogHandlers(ipcMain: IpcMain): void {
  ipcMain.removeAllListeners(RENDERER_LOG);
  ipcMain.removeAllListeners(RENDERER_BOOT);
  ipcMain.removeAllListeners(RENDERER_HEARTBEAT);

  if (heartbeatMonitorInterval) {
    clearInterval(heartbeatMonitorInterval);
    heartbeatMonitorInterval = null;
  }
  heartbeatMonitorStarted = false;
  lastHeartbeatByWebContentsId.clear();
  lastHeartbeatWarnedAtByWebContentsId.clear();
  hasReceivedHeartbeatByWebContentsId.clear();
}
