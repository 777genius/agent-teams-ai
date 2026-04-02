import { monitorEventLoopDelay } from 'node:perf_hooks';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Perf:EventLoop');

let started = false;
let currentOp: string | null = null;

export function setCurrentMainOp(op: string | null): void {
  currentOp = op;
}

export function startEventLoopLagMonitor(): void {
  if (started) return;
  started = true;

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const interval = setInterval(() => {
    const maxMs = Number(h.max) / 1e6;
    const p95Ms = Number(h.percentile(95)) / 1e6;
    // Reset first so next window is clean even if logging throws
    h.reset();

    // Only report meaningful stalls
    if (maxMs < 250) return;

    // For known IPC/main-thread operations we already emit operation-specific
    // timing diagnostics. Suppress the generic event-loop warning to avoid
    // duplicate noisy logs that do not add new debugging value.
    if (currentOp) return;

    logger.warn(
      `Event loop stall detected: p95=${p95Ms.toFixed(1)}ms max=${maxMs.toFixed(1)}ms` +
        (currentOp ? ` op=${currentOp}` : '')
    );
  }, 5000);

  interval.unref();
}
