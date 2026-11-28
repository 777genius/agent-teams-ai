export type OpenCodeCurrentnessWindow = 'identity' | `catalog-${1 | 2 | 3}`
  | `credential-${'catalog' | 'directory' | 'connect'}` | 'driver-readiness';
export type OpenCodeCurrentnessPhase = `${OpenCodeCurrentnessWindow}-currentness-summary`;
export interface OpenCodeCurrentnessStats {
  readonly currentCalls: number;
  readonly currentElapsedMs: number;
}

const windows = new Set<OpenCodeCurrentnessWindow>(['identity', 'catalog-1', 'catalog-2', 'catalog-3',
  'credential-catalog', 'credential-directory', 'credential-connect', 'driver-readiness']);
const noop = () => {};
interface Observation {
  window: OpenCodeCurrentnessWindow;
  calls: number;
  elapsed: number;
  depth: number;
  started: number | undefined;
  valid: boolean;
  closed: boolean;
}

/** Passive intervals only. Overlapping windows can observe the same original call. */
export function createOpenCodeCurrentnessTiming(
  observe?: (phase: OpenCodeCurrentnessPhase, stats: OpenCodeCurrentnessStats) => void,
  now: () => number = () => performance.now()
) {
  const active = new Set<Observation>(), issued = new Set<OpenCodeCurrentnessWindow>();
  const clock = (): number | undefined => {
    try { const at = now(); return Number.isFinite(at) && at >= 0 ? at : undefined; }
    catch { return undefined; }
  };
  return Object.freeze({
    begin(window?: OpenCodeCurrentnessWindow): () => void {
      if (!observe || window === undefined || !windows.has(window) || issued.has(window)) return noop;
      issued.add(window);
      const state: Observation = { window, calls: 0, elapsed: 0, depth: 0,
        started: undefined, valid: true, closed: false };
      active.add(state);
      return () => {
        if (state.closed) return;
        state.closed = true; active.delete(state);
        if (!state.valid || state.depth !== 0) return;
        try {
          observe(`${state.window}-currentness-summary`, {
            currentCalls: state.calls, currentElapsedMs: Math.round(state.elapsed),
          });
        } catch { /* A failed observer cannot change the original admission or error. */ }
      };
    },
    enter(): () => void {
      if (active.size === 0) return noop;
      const selected = [...active], at = clock();
      for (const state of selected) {
        if (state.calls >= 1_000_000 || at === undefined) state.valid = false;
        else state.calls++;
        if (state.depth++ === 0) state.started = at;
      }
      let completed = false;
      return () => {
        if (completed) return;
        completed = true;
        const ended = clock();
        for (const state of selected) {
          state.depth--;
          if (ended === undefined || state.started === undefined || ended < state.started) state.valid = false;
          else if (state.depth === 0) {
            state.elapsed += ended - state.started;
            if (!Number.isFinite(state.elapsed) || state.elapsed > 3_600_000) state.valid = false;
          }
        }
      };
    },
  });
}
