const STORAGE_KEY = 'taskFolders:dockedSidebar:v1';

export interface DockedSidebarState {
  /** When on, the folders tree replaces the task list inside the main right sidebar. */
  docked: boolean;
}

const readStored = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

let state: DockedSidebarState = { docked: readStored() };
const listeners = new Set<() => void>();

const publish = (docked: boolean): void => {
  if (state.docked === docked) return;
  state = { docked };
  try {
    if (docked) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Persisting the preference is best effort.
  }
  listeners.forEach((listener) => listener());
};

export const dockedSidebar = {
  getSnapshot: (): DockedSidebarState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set: (docked: boolean): void => publish(docked),
  toggle: (): void => publish(!state.docked),
};
