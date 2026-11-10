import type { TaskIdentity } from '../../core/domain/folders';
let current: TaskIdentity | null = null;
const listeners = new Set<() => void>();
export const moveRequest = {
  getSnapshot: (): TaskIdentity | null => current,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  open: (identity: TaskIdentity): void => {
    current = identity;
    listeners.forEach((l) => l());
  },
  close: (): void => {
    current = null;
    listeners.forEach((l) => l());
  },
};
