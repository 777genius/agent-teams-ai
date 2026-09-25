import { join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { raceTimeout } from './process.mjs';
import { acquirePidLock } from './state.mjs';
import { startPair as defaultStartPair, stopPair as defaultStopPair } from './session.mjs';

export const SUPERVISOR_PID_FILE = 'supervisor.pid';

/** Run directories of earlier sessions; only the lock holder may remove them. */
async function removeStaleRunDirectories(runDir) {
  for (const name of await readdir(runDir).catch(() => [])) {
    if (/^owner-g[0-9]+$/u.test(name)) await rm(join(runDir, name), { recursive: true, force: true });
  }
}

/**
 * Resolves with the reason the current pair must end: 'terminate' (SIGTERM/SIGINT),
 * 'reload' (SIGHUP, e.g. switch-team), 'owner-exited' or 'product-unhealthy'.
 */
export async function monitorPair({ session, compose, signals, timeouts, log, now = Date.now }) {
  let ownerGone = false;
  session.owner.exited.then(() => { ownerGone = true; });
  let unhealthySince = null;
  for (;;) {
    const signal = signals.take();
    if (signal) return signal;
    if (ownerGone) return 'owner-exited';
    const health = await compose.productHealth().catch(() => 'unknown');
    if (health === 'stopped' || health === 'missing') {
      log('product-not-running', { health });
      return 'product-unhealthy';
    }
    if (health === 'healthy') unhealthySince = null;
    else {
      unhealthySince ??= now();
      if (now() - unhealthySince >= timeouts.productUnhealthyGraceMs) {
        log('product-unhealthy-too-long', { health });
        return 'product-unhealthy';
      }
    }
    await signals.wait(timeouts.healthPollMs, session.owner.exited);
  }
}

/** Signal latch. SIGTERM wins over SIGHUP so a stop is never downgraded to a reload. */
export function createSignalLatch(target = process) {
  let pending = null;
  let wake = () => undefined;
  const handler = reason => () => {
    if (pending !== 'terminate') pending = reason;
    wake();
  };
  const handlers = { SIGTERM: handler('terminate'), SIGINT: handler('terminate'), SIGHUP: handler('reload') };
  for (const [name, fn] of Object.entries(handlers)) target.on(name, fn);
  return {
    take() { const value = pending; pending = null; return value; },
    peek: () => pending,
    wait(ms, ...others) {
      return Promise.race([raceTimeout(ms), new Promise(resolveWake => { wake = resolveWake; }), ...others]);
    },
    dispose() { for (const [name, fn] of Object.entries(handlers)) target.off(name, fn); },
  };
}

/**
 * `hostedctl up`: holds one Owner/Product pair until told to stop. Every failure ends in a
 * non-zero exit after both halves are stopped, so systemd's Restart=on-failure starts a fresh
 * pair with the next generation instead of reconnecting a Product to a consumed session.
 */
export async function runSupervisor({ config, key, compose, providerValues, log,
  startPair = defaultStartPair, stopPair = defaultStopPair, signals = createSignalLatch() }) {
  const lock = await acquirePidLock(join(config.stateDir, SUPERVISOR_PID_FILE));
  try {
    await removeStaleRunDirectories(config.runDir);
    for (;;) {
      if (signals.peek() === 'terminate') return 0;
      signals.take();
      let session;
      try {
        session = await startPair({ config, key, compose, providerValues, log });
      } catch (error) {
        log('pair-start-failed', { reason: error.message });
        return 1;
      }
      const reason = await monitorPair({ session, compose, signals, timeouts: config.timeouts, log });
      log('pair-stopping', { reason, ownerGeneration: session.ownerGeneration });
      try { await stopPair({ compose, session, log }); }
      catch (error) { log('pair-stop-failed', { reason: error.message }); return 1; }
      if (reason === 'terminate') return 0;
      if (reason !== 'reload') return 1;
      if (signals.peek() === 'terminate') return 0;
    }
  } finally {
    await rm(join(config.runDir, 'active.json'), { force: true }).catch(() => undefined);
    signals.dispose();
    await lock.release();
  }
}
