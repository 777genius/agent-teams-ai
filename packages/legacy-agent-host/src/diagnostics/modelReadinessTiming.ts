import { performance } from 'node:perf_hooks';

type AuthorityRegion = 'provider' | 'allocation';

/** Private observation only; no authority callback or result crosses this sink. */
export interface ModelReadinessAuthorityTiming {
  observe?(region: AuthorityRegion): (() => void) | undefined;
}

export function beginModelReadinessAuthorityTiming(sink: ModelReadinessAuthorityTiming, region: AuthorityRegion) {
  try {
    const finish = sink.observe?.(region);
    if (finish) return () => { try { finish(); } catch { /* Observation cannot replace the original result. */ } };
  } catch { /* Observation cannot skip the original check. */ }
  return undefined;
}

/** Existing bounded consumer timings; clocks are enabled only by the original TEST subscriber. */
export function createModelReadinessTiming(subscriber: { readonly hasSubscribers: boolean }) {
  const currentCalls = { count: 0, totalMs: 0, maxMs: 0, lastMs: null as number | null, truncated: false };
  let regions: Record<string, number> | undefined;
  return {
    snapshot: () => ({ ...currentCalls, ...(regions ? { regions: { ...regions } } : {}) }),
    begin(beforeFirstRefusal: boolean, sink?: ModelReadinessAuthorityTiming) {
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
            const totals = regions ??= { initialAuthorityCount: 0, initialAuthorityMs: 0, readConsumerCount: 0, readConsumerMs: 0,
              referenceCount: 0, referenceMs: 0, finalAuthorityCount: 0, finalAuthorityMs: 0,
              referenceAccountCount: 0, referenceAccountMs: 0, referenceAccountAuthorityCount: 0, referenceAccountAuthorityMs: 0 };
            let region: string | undefined = 'initialAuthority', entered = started;
            boundary = (next, ended) => {
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
              try { accountStarted = performance.now(); } catch { currentCalls.truncated = true; }
              let restore: (() => void) | undefined;
              if (accountStarted !== undefined && sink) try {
                const previous = Object.getOwnPropertyDescriptor(sink, 'observe');
                const observe = (part: AuthorityRegion) => {
                  let entered: number | undefined;
                  try { entered = performance.now(); } catch { currentCalls.truncated = true; }
                  return () => {
                    try {
                      if (entered !== undefined) {
                        const elapsed = performance.now() - entered;
                        if (!Number.isFinite(elapsed) || elapsed < 0) currentCalls.truncated = true;
                        else authorityMs[part] = (authorityMs[part] ?? 0) + elapsed;
                      }
                    } catch { currentCalls.truncated = true; }
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
        },
      };
    },
  };
}
