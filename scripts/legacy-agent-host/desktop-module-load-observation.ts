import { performance } from 'node:perf_hooks';

type Row = Record<string, unknown>;
interface ModuleLoad {
  path: string;
  startedMs: number;
  finishedMs: number | null;
  outcome: 'pending' | 'finished' | 'failed' | 'redirected';
  status: number | null;
  failure: string | null;
}
const row = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
export const desktopNetworkFailure = (value: unknown): string =>
  typeof value === 'string' && value.length <= 128 && /^net::ERR_[A-Z_]+$/.test(value)
    ? value : 'unclassified';

/** Observe the existing CDP Network stream; never initiate a request or a renderer read. */
export function observeDesktopModuleLoads(
  cdp: { on(method: string, listener: (value: unknown) => void): void },
  rendererUrl: string,
  currentFrame: () => unknown,
  now: () => number = () => Math.round(performance.now())
) {
  const origin = new URL(rendererUrl).origin;
  const loads: ModuleLoad[] = [];
  const tracked = new Map<string, ModuleLoad>();
  const evidence = { limit: 256, overflow: false, loads };
  const id = (entry: Row) => typeof entry.requestId === 'string' &&
    entry.requestId.length > 0 && entry.requestId.length <= 128 ? entry.requestId : undefined;
  const observe = (method: string, accept: (entry: Row) => void) => cdp.on(method, value => {
    try { const entry = row(value); if (entry) accept(entry); }
    catch { /* Passive observations cannot replace the original flow's result. */ }
  });
  observe('Network.requestWillBeSent', entry => {
    if (entry.type !== 'Script' || !currentFrame() || entry.frameId !== currentFrame()) return;
    const requestId = id(entry), request = row(entry.request);
    if (!requestId || typeof request?.url !== 'string' || request.url.length > 8192) return;
    const previous = tracked.get(requestId);
    if (previous) {
      if (!row(entry.redirectResponse)) return;
      previous.outcome = 'redirected'; previous.finishedMs = now();
      tracked.delete(requestId);
    }
    const url = new URL(request.url);
    if (url.origin !== origin || !['http:', 'https:', 'file:'].includes(url.protocol)) return;
    const load: ModuleLoad = { path: url.pathname.slice(0, 1000), startedMs: now(),
      finishedMs: null, outcome: 'pending', status: null, failure: null };
    if (loads.length === evidence.limit) {
      evidence.overflow = true;
      const evicted = loads.shift();
      for (const [key, value] of tracked) if (value === evicted) tracked.delete(key);
    }
    loads.push(load);
    tracked.set(requestId, load);
  });
  observe('Network.responseReceived', entry => {
    const requestId = id(entry), load = requestId ? tracked.get(requestId) : undefined;
    const status = row(entry.response)?.status;
    if (load && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
      load.status = status;
  });
  const finish = (entry: Row, failed: boolean) => {
    const requestId = id(entry), load = requestId ? tracked.get(requestId) : undefined;
    if (!requestId || !load) return;
    load.finishedMs = now();
    load.outcome = failed ? 'failed' : 'finished';
    if (failed) load.failure = desktopNetworkFailure(entry.errorText);
    tracked.delete(requestId);
  };
  observe('Network.loadingFinished', entry => finish(entry, false));
  // The enclosing observer already owns this CDP subscription; share its event.
  const loadingFailed = (value: unknown) => {
    try { const entry = row(value); if (entry) finish(entry, true); }
    catch { /* Preserve the original failure and the existing diagnostic listener. */ }
  };
  return { evidence, loadingFailed };
}
