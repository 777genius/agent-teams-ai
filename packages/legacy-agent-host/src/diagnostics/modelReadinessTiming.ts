import { performance } from 'node:perf_hooks';

type AuthorityRegion = 'provider' | 'allocation';

interface NamespaceTiming {
  referenceSamples: number;
  referenceDirectoryPathMs: number;
  referenceTreeMs: number;
  accountSamples: number;
  accountDirectoryPathMs: number;
  accountTreeMs: number;
}

interface NamespaceObserver {
  reserve(): boolean;
  record(account: boolean, directoryPathMs: number, treeMs: number): void;
  truncate(): void;
}

interface NamespaceScope {
  previous: NamespaceScope | undefined;
  observer: NamespaceObserver | undefined;
  reference: boolean;
  revision: number;
  account: object | undefined;
  closed: boolean;
}

// Only the synchronous original reference call owns this private observation scope.
let namespaceScope: NamespaceScope | undefined;

/** No callback, path, authority value or result crosses this diagnostic seam. */
export function beginModelReadinessNamespaceTiming() {
  const scope = namespaceScope, observer = scope?.observer;
  if (!scope || !observer || !scope.reference || scope.closed) return undefined;
  try {
    if (!observer.reserve()) return undefined;
    const started = performance.now(), account = scope.account, revision = scope.revision;
    const clock = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
    if (!clock(started)) { observer.truncate(); return undefined; }
    let split: number | undefined, done = false, valid = true;
    const current = () => namespaceScope === scope && !scope.closed && scope.reference &&
      scope.revision === revision && scope.account === account;
    return {
      tree() {
        if (done) return;
        try {
          if (!current() || split !== undefined) { valid = false; observer.truncate(); return; }
          split = performance.now();
          if (!clock(split) || split < started) { valid = false; observer.truncate(); }
        } catch { valid = false; observer.truncate(); }
      },
      finish() {
        if (done) return;
        done = true;
        try {
          if (!valid || !current()) { observer.truncate(); return; }
          const ended = performance.now();
          if (!clock(ended) || ended < (split ?? started)) { observer.truncate(); return; }
          observer.record(account !== undefined, (split ?? ended) - started, split === undefined ? 0 : ended - split);
        } catch { observer.truncate(); }
      },
    };
  } catch { observer.truncate(); }
  return undefined;
}

export interface ModelReadinessAuthorityDeduction {
  nestedAllocationMs: number | undefined;
}

/** Private observation only; no authority callback or result crosses this sink. */
export interface ModelReadinessAuthorityTiming {
  observe?(region: AuthorityRegion): ((deduction?: ModelReadinessAuthorityDeduction) => number | void) | undefined;
}

export function beginModelReadinessAuthorityTiming(sink: ModelReadinessAuthorityTiming, region: AuthorityRegion) {
  try {
    const finish = sink.observe?.(region);
    if (finish) return (deduction?: ModelReadinessAuthorityDeduction) => {
      try {
        const elapsed = deduction === undefined ? finish() : finish(deduction);
        return typeof elapsed === 'number' ? elapsed : undefined;
      } catch { /* Observation cannot replace the original result. */ }
      return undefined;
    };
  } catch { /* Observation cannot skip the original check. */ }
  return undefined;
}

/** Existing bounded consumer timings; clocks are enabled only by the original TEST subscriber. */
export function createModelReadinessTiming(subscriber: { readonly hasSubscribers: boolean }) {
  const currentCalls = { count: 0, totalMs: 0, maxMs: 0, lastMs: null as number | null, truncated: false };
  let regions: Record<string, number> | undefined;
  let namespace: NamespaceTiming | undefined, namespaceAttempts = 0;
  const namespaceObserver: NamespaceObserver = {
    truncate() { currentCalls.truncated = true; },
    reserve() {
      if (namespaceAttempts >= 4096) { currentCalls.truncated = true; return false; }
      namespaceAttempts++;
      namespace ??= { referenceSamples: 0, referenceDirectoryPathMs: 0, referenceTreeMs: 0,
        accountSamples: 0, accountDirectoryPathMs: 0, accountTreeMs: 0 };
      return true;
    },
    record(account, directoryPathMs, treeMs) {
      const totals = namespace!;
      const referenceDirectory = totals.referenceDirectoryPathMs + directoryPathMs, referenceTree = totals.referenceTreeMs + treeMs;
      const accountDirectory = totals.accountDirectoryPathMs + (account ? directoryPathMs : 0), accountTree = totals.accountTreeMs + (account ? treeMs : 0);
      if ([directoryPathMs, treeMs, referenceDirectory, referenceTree, accountDirectory, accountTree]
        .some(value => !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) {
        currentCalls.truncated = true; return;
      }
      totals.referenceSamples++; totals.referenceDirectoryPathMs = referenceDirectory; totals.referenceTreeMs = referenceTree;
      if (account) { totals.accountSamples++; totals.accountDirectoryPathMs = accountDirectory; totals.accountTreeMs = accountTree; }
    },
  };
  return {
    // Namespace samples are validator invocations, not outer calls. Account spans are included in reference spans;
    // reentrant spans are inclusive. Accumulate raw durations and round only the retained numeric projection.
    snapshot: () => ({ ...currentCalls, ...(regions ? { regions: { ...regions } } : {}), ...(namespace ? { namespace: {
      ...namespace, referenceDirectoryPathMs: Math.round(namespace.referenceDirectoryPathMs), referenceTreeMs: Math.round(namespace.referenceTreeMs),
      accountDirectoryPathMs: Math.round(namespace.accountDirectoryPathMs), accountTreeMs: Math.round(namespace.accountTreeMs),
    } } : {}) }),
    begin(beforeFirstRefusal: boolean, sink?: ModelReadinessAuthorityTiming) {
      const scope: NamespaceScope = { previous: namespaceScope, observer: undefined, reference: false,
        revision: 0, account: undefined, closed: false };
      namespaceScope = scope; // A disabled nested call also suspends its enclosing observation.
      let started: number | undefined;
      let accountStarted: number | undefined, accountMs: number | undefined, accountAuthorityMs: number | undefined;
      const authorityMs: Partial<Record<AuthorityRegion, number>> = {};
      let beginAccount: (() => () => void) | undefined;
      let boundary: ((next?: 'readConsumer' | 'reference' | 'finalAuthority', ended?: number) => void) | undefined;
      try {
        if (subscriber.hasSubscribers && beforeFirstRefusal) {
          currentCalls.lastMs = null;
          if (currentCalls.count < 4096) {
            currentCalls.count++; started = performance.now();
            scope.observer = namespaceObserver;
            const totals = regions ??= { initialAuthorityCount: 0, initialAuthorityMs: 0, readConsumerCount: 0, readConsumerMs: 0,
              referenceCount: 0, referenceMs: 0, finalAuthorityCount: 0, finalAuthorityMs: 0,
              referenceAccountCount: 0, referenceAccountMs: 0, referenceAccountAuthorityCount: 0, referenceAccountAuthorityMs: 0 };
            let region: string | undefined = 'initialAuthority', entered = started;
            boundary = (next, ended) => {
              if (scope.closed) return;
              scope.reference = next === 'reference'; scope.revision++;
              try {
                const now = ended ?? performance.now(), elapsed = Math.round(now - entered);
                if (region !== undefined) {
                  const count = totals[region + 'Count']!, total = totals[region + 'Ms']! + elapsed;
                  if (Number.isSafeInteger(elapsed) && elapsed >= 0 && Number.isSafeInteger(total)) {
                    totals[region + 'Count'] = count + 1; totals[region + 'Ms'] = total;
                  } else currentCalls.truncated = true;
                }
                region = next; entered = now;
              } catch { region = undefined; currentCalls.truncated = true; }
            };
            beginAccount = () => {
              const previousAccount = scope.account, account = {};
              scope.account = account;
              try { accountStarted = performance.now(); } catch { currentCalls.truncated = true; }
              let restore: (() => void) | undefined;
              if (accountStarted !== undefined && sink) try {
                const previous = Object.getOwnPropertyDescriptor(sink, 'observe');
                const observe = (part: AuthorityRegion) => {
                  let entered: number | undefined;
                  try { entered = performance.now(); } catch { currentCalls.truncated = true; }
                  return (deduction?: ModelReadinessAuthorityDeduction) => {
                    try {
                      if (entered !== undefined) {
                        const elapsed = performance.now() - entered;
                        const nested = deduction?.nestedAllocationMs;
                        if (!Number.isFinite(elapsed) || elapsed < 0 || deduction !== undefined &&
                          (part !== 'provider' || typeof nested !== 'number' || !Number.isFinite(nested) ||
                            nested < 0 || nested > elapsed)) currentCalls.truncated = true;
                        else {
                          authorityMs[part] = (authorityMs[part] ?? 0) + (elapsed - (nested ?? 0));
                          return elapsed;
                        }
                      }
                    } catch { currentCalls.truncated = true; }
                    return undefined;
                  };
                };
                Object.defineProperty(sink, 'observe', { value: observe, configurable: true, writable: true, enumerable: true });
                restore = () => {
                  if (previous) Object.defineProperty(sink, 'observe', previous);
                  else delete sink.observe;
                };
                for (const part of ['Provider', 'Allocation']) {
                  totals['referenceAccount' + part + 'Count'] ??= 0;
                  totals['referenceAccount' + part + 'Ms'] ??= 0;
                }
              } catch { currentCalls.truncated = true; }
              return () => {
                try { if (accountStarted !== undefined) accountMs = performance.now() - accountStarted; }
                catch { currentCalls.truncated = true; }
                finally {
                  accountStarted = undefined;
                  if (scope.account === account) scope.account = previousAccount;
                  else currentCalls.truncated = true;
                  try { restore?.(); } catch { currentCalls.truncated = true; }
                }
              };
            };
          }
          else currentCalls.truncated = true;
        }
      } catch { currentCalls.truncated = true; }
      return {
        boundary, beginAccount,
        beginAccountAuthority() {
          let authorityStarted: number | undefined;
          try { if (accountStarted !== undefined) authorityStarted = performance.now(); }
          catch { currentCalls.truncated = true; }
          return () => {
            try {
              if (authorityStarted !== undefined) {
                const elapsed = performance.now() - authorityStarted;
                if (!Number.isFinite(elapsed) || elapsed < 0) currentCalls.truncated = true;
                else accountAuthorityMs = (accountAuthorityMs ?? 0) + elapsed;
              }
            } catch { currentCalls.truncated = true; }
          };
        },
        finish() {
          if (scope.closed) return;
          if (started !== undefined) try {
            const ended = performance.now(), elapsed = Math.round(ended - started);
            boundary?.(undefined, ended);
            if (!Number.isSafeInteger(elapsed) || elapsed < 0 || !Number.isSafeInteger(currentCalls.totalMs + elapsed))
              currentCalls.truncated = true;
            else { currentCalls.totalMs += elapsed; currentCalls.maxMs = Math.max(currentCalls.maxMs, elapsed); currentCalls.lastMs = elapsed; }
            // Nested callbacks accumulate raw durations; each region counts and rounds once per outer call.
            for (const [name, raw] of [['referenceAccount', accountMs], ['referenceAccountAuthority', accountAuthorityMs],
              ['referenceAccountProvider', authorityMs.provider], ['referenceAccountAllocation', authorityMs.allocation]] as const) {
              if (raw === undefined) continue;
              const milliseconds = Math.round(raw), total = regions![name + 'Ms']! + milliseconds;
              if (!Number.isFinite(raw) || raw < 0 || !Number.isSafeInteger(milliseconds) || !Number.isSafeInteger(total))
                currentCalls.truncated = true;
              else {
                regions![name + 'Count'] = regions![name + 'Count']! + 1;
                regions![name + 'Ms'] = total;
              }
            }
          } catch { currentCalls.truncated = true; }
          scope.closed = true; scope.reference = false;
          if (namespaceScope === scope) {
            namespaceScope = scope.previous;
            while (namespaceScope?.closed) namespaceScope = namespaceScope.previous;
          } else currentCalls.truncated = true;
        },
      };
    },
  };
}
