import { type IpcMain } from 'electron';

// IPC channel names — must match the preload bindings in src/preload/index.ts
const RENDERER_LOG = 'renderer:log';
const RENDERER_BOOT = 'renderer:boot';
const RENDERER_HEARTBEAT = 'renderer:heartbeat';

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
    }
  }, CHECK_EVERY_MS);

  // Diagnostics-only: should not keep the app alive.
  heartbeatMonitorInterval.unref();
}

export function registerRendererLogHandlers(ipcMain: IpcMain): void {
  startHeartbeatMonitor();

  ipcMain.on(RENDERER_LOG, () => {
    // Forwarded renderer logs are intentionally silenced.
  });

  ipcMain.on(RENDERER_BOOT, (event) => {
    const id = event.sender.id;
    lastHeartbeatByWebContentsId.set(id, Date.now());
    lastHeartbeatWarnedAtByWebContentsId.delete(id);
    hasReceivedHeartbeatByWebContentsId.delete(id);
    event.sender.once('destroyed', () => {
      lastHeartbeatByWebContentsId.delete(id);
      lastHeartbeatWarnedAtByWebContentsId.delete(id);
      hasReceivedHeartbeatByWebContentsId.delete(id);
    });
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

  if (heartbeatMonitorInterval) {
    clearInterval(heartbeatMonitorInterval);
    heartbeatMonitorInterval = null;
  }
  heartbeatMonitorStarted = false;
  lastHeartbeatByWebContentsId.clear();
  lastHeartbeatWarnedAtByWebContentsId.clear();
  hasReceivedHeartbeatByWebContentsId.clear();
}
