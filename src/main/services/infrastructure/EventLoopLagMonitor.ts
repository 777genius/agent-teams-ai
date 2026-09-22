import { monitorEventLoopDelay } from 'node:perf_hooks';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Perf:EventLoop');

const DEFAULT_MAX_STALL_THRESHOLD_MS = 750;
const DEFAULT_REPORT_INTERVAL_MS = 30_000;

let started = false;
let currentOp: string | null = null;
let lastReportAt = 0;

function isEnabled(): boolean {
  const raw = process.env.CLAUDE_TEAM_EVENT_LOOP_LAG_MONITOR_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function setCurrentMainOp(op: string | null): void {
  currentOp = op;
}

export function startEventLoopLagMonitor(): void {
  if (!isEnabled()) return;
  if (started) return;
  started = true;

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const interval = setInterval(() => {
    const maxMs = Number(h.max) / 1e6;
    const p95Ms = Number(h.percentile(95)) / 1e6;
    // Reset first so next window is clean even if logging throws
    h.reset();

    // Only report severe stalls. Sub-second blips are common during expected
    // Electron/main-process IO and are too noisy for default development logs.
    if (maxMs < DEFAULT_MAX_STALL_THRESHOLD_MS) return;

    // For known IPC/main-thread operations we already emit operation-specific
    // timing diagnostics. Suppress the generic event-loop warning to avoid
    // duplicate noisy logs that do not add new debugging value.
    if (currentOp) return;

    const now = Date.now();
    if (now - lastReportAt < DEFAULT_REPORT_INTERVAL_MS) return;
    lastReportAt = now;

    logger.warn(
      `Event loop stall detected: p95=${p95Ms.toFixed(1)}ms max=${maxMs.toFixed(1)}ms` +
        (currentOp ? ` op=${currentOp}` : '')
    );
  }, 5000);

  interval.unref();
}
