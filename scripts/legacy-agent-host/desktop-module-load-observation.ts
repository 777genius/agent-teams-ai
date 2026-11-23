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
const requestIdOf = (entry: Row) => typeof entry.requestId === 'string' &&
  entry.requestId.length > 0 && entry.requestId.length <= 128 ? entry.requestId : undefined;
export const desktopNetworkFailure = (value: unknown): string =>
  typeof value === 'string' && value.length <= 128 && /^net::ERR_[A-Z_]+$/.test(value)
    ? value : 'unclassified';

interface RequestCounts {
  started: number;
  finished: number;
  failed: number;
  redirected: number;
  pending: number;
  peakPending: number;
}
interface ResourceFailureSnapshot {
  monotonicMs: number;
  requestType: string | null;
  requestTracked: boolean;
  mainFrameSameOriginScript: boolean | null;
  overflow: boolean;
  untrackedRequestEvents: number;
  orphanTerminalEvents: number;
  allRequests: RequestCounts;
  mainFrameSameOriginScripts: RequestCounts;
}
const resourceTypes = new Set(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script',
  'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest',
  'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'Other']);

/** Counts accepted CDP events independently of the module history; retains no URLs or IDs in evidence. */
function createRequestActivity(origin: string, currentFrame: () => unknown, now: () => number) {
  const counts = (): RequestCounts => ({ started: 0, finished: 0, failed: 0,
    redirected: 0, pending: 0, peakPending: 0 });
  // Values capture script membership at request start, so old-document completions still retire it.
  const active = new Map<string, boolean>();
  const evidence = { scope: 'observed CDP target requests; not process-wide Chromium loader counts',
    activeLimit: 8192, overflow: false, untrackedRequestEvents: 0, orphanTerminalEvents: 0,
    duplicateStartEvents: 0, allRequests: counts(), mainFrameSameOriginScripts: counts(),
    firstResourceFailure: null as ResourceFailureSnapshot | null };
  const eachScope = (script: boolean, accept: (scope: RequestCounts) => void) => {
    accept(evidence.allRequests);
    if (script) accept(evidence.mainFrameSameOriginScripts);
  };
  const complete = (requestId: string, outcome: 'finished' | 'failed' | 'redirected'): boolean => {
    const script = active.get(requestId);
    if (script === undefined) return false;
    eachScope(script, scope => { scope[outcome]++; scope.pending--; });
    active.delete(requestId);
    return true;
  };
  const start = (entry: Row) => {
    const requestId = requestIdOf(entry), request = row(entry.request);
    if (!requestId || typeof request?.url !== 'string' || request.url.length > 8192) return;
    let url: URL;
    try { url = new URL(request.url); } catch { return; }
    if (active.has(requestId)) {
      if (!row(entry.redirectResponse)) { evidence.duplicateStartEvents++; return; }
      complete(requestId, 'redirected');
    }
    if (active.size === evidence.activeLimit) {
      // Do not evict a live request. Counts after overflow are explicitly incomplete/lower bounds.
      evidence.overflow = true; evidence.untrackedRequestEvents++; return;
    }
    const frame = currentFrame();
    const script = entry.type === 'Script' && Boolean(frame) && entry.frameId === frame &&
      url.origin === origin && ['http:', 'https:', 'file:'].includes(url.protocol);
    active.set(requestId, script);
    eachScope(script, scope => {
      scope.started++; scope.pending++; scope.peakPending = Math.max(scope.peakPending, scope.pending);
    });
  };
  const finish = (entry: Row, failed: boolean) => {
    const requestId = requestIdOf(entry);
    if (!requestId) return;
    if (failed && !evidence.firstResourceFailure &&
      desktopNetworkFailure(entry.errorText) === 'net::ERR_INSUFFICIENT_RESOURCES') {
      // Copy before retirement: pending includes this observed failing request, if it was tracked.
      evidence.firstResourceFailure = { monotonicMs: now(),
        requestType: typeof entry.type === 'string' && resourceTypes.has(entry.type) ? entry.type : null,
        requestTracked: active.has(requestId), mainFrameSameOriginScript: active.get(requestId) ?? null,
        overflow: evidence.overflow, untrackedRequestEvents: evidence.untrackedRequestEvents,
        orphanTerminalEvents: evidence.orphanTerminalEvents,
        allRequests: { ...evidence.allRequests },
        mainFrameSameOriginScripts: { ...evidence.mainFrameSameOriginScripts } };
    }
    if (!complete(requestId, failed ? 'failed' : 'finished')) evidence.orphanTerminalEvents++;
  };
  return { evidence, start, finish };
}

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
  const activity = createRequestActivity(origin, currentFrame, now);
  const evidence = { limit: 256, overflow: false, loads, activity: activity.evidence };
  const observe = (method: string, accept: (entry: Row) => void) => cdp.on(method, value => {
    try { const entry = row(value); if (entry) accept(entry); }
    catch { /* Passive observations cannot replace the original flow's result. */ }
  });
  observe('Network.requestWillBeSent', entry => {
    activity.start(entry);
    if (entry.type !== 'Script' || !currentFrame() || entry.frameId !== currentFrame()) return;
    const requestId = requestIdOf(entry), request = row(entry.request);
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
    const requestId = requestIdOf(entry), load = requestId ? tracked.get(requestId) : undefined;
    const status = row(entry.response)?.status;
    if (load && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
      load.status = status;
  });
  const finish = (entry: Row, failed: boolean) => {
    activity.finish(entry, failed);
    const requestId = requestIdOf(entry), load = requestId ? tracked.get(requestId) : undefined;
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
