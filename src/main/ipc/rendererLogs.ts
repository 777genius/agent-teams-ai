import { createLogger } from '@shared/utils/logger';
import { type IpcMain } from 'electron';

// IPC channel names — must match the preload bindings in src/preload/index.ts
const RENDERER_LOG = 'renderer:log';
const RENDERER_BOOT = 'renderer:boot';
const RENDERER_HEARTBEAT = 'renderer:heartbeat';

const lastHeartbeatByWebContentsId = new Map<number, number>();
const lastHeartbeatWarnedAtByWebContentsId = new Map<number, number>();
const hasReceivedHeartbeatByWebContentsId = new Set<number>();
const sendersWithDestroyCleanup = new WeakSet<object>();
let heartbeatMonitorStarted = false;
let heartbeatMonitorInterval: ReturnType<typeof setInterval> | null = null;
let rendererLogHandlersRegistered = false;
const logger = createLogger('Renderer');

function normalizeRendererLogPayload(payload: unknown): {
  level: 'warn' | 'error';
  message: string;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as { level?: unknown; message?: unknown };
  if (candidate.level !== 'warn' && candidate.level !== 'error') return null;
  if (typeof candidate.message !== 'string') return null;
  const message = candidate.message.trim();
  if (!message) return null;
  return {
    level: candidate.level,
    message,
  };
}

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
    }
  }, CHECK_EVERY_MS);

  // Diagnostics-only: should not keep the app alive.
  heartbeatMonitorInterval.unref();
}

export function registerRendererLogHandlers(ipcMain: IpcMain): void {
  if (rendererLogHandlersRegistered) {
    return;
  }
  rendererLogHandlersRegistered = true;
  startHeartbeatMonitor();

  ipcMain.on(RENDERER_LOG, (_event, payload: unknown) => {
    const normalized = normalizeRendererLogPayload(payload);
    if (!normalized) return;
    if (normalized.level === 'error') {
      logger.error(normalized.message);
      return;
    }
    logger.warn(normalized.message);
  });

  ipcMain.on(RENDERER_BOOT, (event) => {
    const sender = event.sender;
    const id = sender.id;
    lastHeartbeatByWebContentsId.set(id, Date.now());
    lastHeartbeatWarnedAtByWebContentsId.delete(id);
    hasReceivedHeartbeatByWebContentsId.delete(id);
    if (!sendersWithDestroyCleanup.has(sender)) {
      sendersWithDestroyCleanup.add(sender);
      sender.once('destroyed', () => {
        sendersWithDestroyCleanup.delete(sender);
        lastHeartbeatByWebContentsId.delete(id);
        lastHeartbeatWarnedAtByWebContentsId.delete(id);
        hasReceivedHeartbeatByWebContentsId.delete(id);
      });
    }
  });

  ipcMain.on(RENDERER_HEARTBEAT, (event) => {
    const id = event.sender.id;
    hasReceivedHeartbeatByWebContentsId.add(id);
    lastHeartbeatByWebContentsId.set(id, Date.now());
  });
}

export function removeRendererLogHandlers(ipcMain: IpcMain): void {
  ipcMain.removeAllListeners(RENDERER_LOG);
  ipcMain.removeAllListeners(RENDERER_BOOT);
  ipcMain.removeAllListeners(RENDERER_HEARTBEAT);
  rendererLogHandlersRegistered = false;

  if (heartbeatMonitorInterval) {
    clearInterval(heartbeatMonitorInterval);
    heartbeatMonitorInterval = null;
  }
  heartbeatMonitorStarted = false;
  lastHeartbeatByWebContentsId.clear();
  lastHeartbeatWarnedAtByWebContentsId.clear();
  hasReceivedHeartbeatByWebContentsId.clear();
}
