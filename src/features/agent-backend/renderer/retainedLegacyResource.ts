export interface RetainedLegacyResourceState<T> {
  value: T | null;
  loading: boolean;
  error: string | null;
}

/** One choice owns its read snapshots; no values enter the global Host caches. */
export function createRetainedLegacyResource<T>(load: () => Promise<T>) {
  let state: RetainedLegacyResourceState<T> = { value: null, loading: false, error: null };
  let pending: Promise<boolean> | null = null;
  let started = false;
  let retired = false;
  const listeners = new Set<() => void>();
  const publish = (next: RetainedLegacyResourceState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const refresh = (): Promise<boolean> => {
    if (retired) return Promise.resolve(false);
    if (pending) return pending;
    started = true;
    publish({ value: null, loading: true, error: null });
    pending = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (retired) return false;
          publish({ value, loading: false, error: null });
          return true;
        },
        (error: unknown) => {
          if (!retired)
            publish({
              value: null,
              loading: false,
              error: error instanceof Error ? error.message : 'Original runtime is unavailable.',
            });
          return false;
        }
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () => (started ? (pending ?? Promise.resolve(state.value !== null)) : refresh()),
    refresh,
    retire() {
      retired = true;
      publish({
        value: null,
        loading: false,
        error: 'Original runtime choice is closed. Reopen Launch.',
      });
    },
  };
}
export type RetainedLegacyResource<T> = ReturnType<typeof createRetainedLegacyResource<T>>;
