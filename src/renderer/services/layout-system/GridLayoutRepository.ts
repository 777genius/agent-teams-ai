import type { PersistedGridLayoutState } from './gridLayoutTypes';

export interface GridLayoutRepository<TState = PersistedGridLayoutState> {
  load(scopeKey: string): Promise<TState | null>;
  save(scopeKey: string, state: TState): Promise<void>;
  clear(scopeKey: string): Promise<void>;
}
